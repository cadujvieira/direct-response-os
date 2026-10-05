// Router /go/:slug que nao deixa o visitante sem destino quando o banco esta lento ou fora do ar.
// Ordem de prioridade: 1) redirecionar; 2) manter o visitante na mesma LP; 3) gravar clique e distribuicao.
// A configuracao (rota + variantes) fica em memoria; as gravacoes que nao couberem no prazo vao para uma
// fila em memoria com novas tentativas. Se a gravacao se perder, a tag da pagina e o aviso do checkout
// ainda registram o clique, porque o click_id segue na URL de destino.
const {
  parseCookies, selectWeightedVariant, buildRedirectUrl, resolveRouterIdentity, routingTrackingParams
} = require("./routing");

const CONFIG_TTL_MS = 10000;       // pesos alterados no painel valem em ate 10 segundos
const CONFIG_TIMEOUT_MS = 1500;
const STICKY_TIMEOUT_MS = 600;
const PERSIST_WAIT_MS = 400;       // espera maxima pela gravacao antes de redirecionar
const BREAKER_MS = 5000;           // apos uma falha, o banco nao e consultado por 5 segundos
const QUEUE_MAX = 20000, JOB_ATTEMPTS = 60, FLUSH_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timedOut: true })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function createRouter({ pool, hashIp, cookieHeader, env = process.env, now = () => Date.now() }) {
  const cache = new Map();   // slug -> { experiment, variants, at }
  const queue = [];
  const stats = { redirects: 0, degraded: 0, fallback: 0, queued: 0, persisted_late: 0, dropped: 0, last_db_error_at: null };
  let breakerUntil = 0, flushing = false;
  const dbAvailable = () => now() >= breakerUntil;
  const tripBreaker = () => { breakerUntil = now() + BREAKER_MS; stats.last_db_error_at = new Date(now()).toISOString(); };

  async function loadConfig(slug) {
    const cached = cache.get(slug);
    if (cached && now() - cached.at < CONFIG_TTL_MS) return { ...cached, degraded: false };
    if (dbAvailable()) {
      try {
        const config = await withTimeout((async () => {
          const experiment = (await pool.query("SELECT id, slug, name FROM dr_experiments WHERE slug = $1 AND active = TRUE LIMIT 1", [slug])).rows[0];
          if (!experiment) return { experiment: null, variants: [] };
          const variants = (await pool.query(`SELECT id, name, destination_url, weight, active FROM dr_experiment_variants
            WHERE experiment_id = $1 AND active = TRUE AND weight > 0 ORDER BY id ASC`, [experiment.id])).rows;
          return { experiment, variants };
        })(), CONFIG_TIMEOUT_MS);
        if (!config.experiment) { cache.delete(slug); return { experiment: null, variants: [], degraded: false }; }
        const entry = { ...config, at: now() };
        cache.set(slug, entry);
        return { ...entry, degraded: false };
      } catch (error) { tripBreaker(); }
    }
    // Banco indisponivel: vale a ultima configuracao conhecida, por mais antiga que seja.
    return cached ? { ...cached, degraded: true } : { experiment: undefined, variants: [], degraded: true };
  }
  async function stickyVariant(config, clickId, visitorKey) {
    if (!dbAvailable()) return null;
    try {
      const row = (await withTimeout(pool.query(`SELECT a.variant_id FROM dr_experiment_assignments a
        WHERE a.experiment_id = $1 AND (a.click_id = $2 OR a.session_key = $3)
        ORDER BY CASE WHEN a.click_id = $2 THEN 0 ELSE 1 END, a.updated_at DESC, a.id DESC LIMIT 1`,
      [config.experiment.id, clickId, visitorKey]), STICKY_TIMEOUT_MS)).rows[0];
      // So mantem a LP anterior se ela continua ativa e com peso (a lista em memoria so tem essas).
      return row ? config.variants.find(variant => Number(variant.id) === Number(row.variant_id)) || null : null;
    } catch (error) { tripBreaker(); return null; }
  }
  async function persist(job) {
    const c = job.click;
    await pool.query(`INSERT INTO dr_clicks (click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        campaign_id, adset_id, ad_id, page_url, referrer, user_agent, ip_hash, fbclid, gclid, capture_source, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'router',$16::timestamptz AT TIME ZONE 'UTC')
      ON CONFLICT (click_id) DO UPDATE SET
        utm_source = COALESCE(dr_clicks.utm_source, EXCLUDED.utm_source), utm_medium = COALESCE(dr_clicks.utm_medium, EXCLUDED.utm_medium),
        utm_campaign = COALESCE(dr_clicks.utm_campaign, EXCLUDED.utm_campaign), utm_content = COALESCE(dr_clicks.utm_content, EXCLUDED.utm_content),
        utm_term = COALESCE(dr_clicks.utm_term, EXCLUDED.utm_term), campaign_id = COALESCE(dr_clicks.campaign_id, EXCLUDED.campaign_id),
        adset_id = COALESCE(dr_clicks.adset_id, EXCLUDED.adset_id), ad_id = COALESCE(dr_clicks.ad_id, EXCLUDED.ad_id),
        page_url = COALESCE(dr_clicks.page_url, EXCLUDED.page_url), referrer = COALESCE(dr_clicks.referrer, EXCLUDED.referrer),
        user_agent = COALESCE(dr_clicks.user_agent, EXCLUDED.user_agent), ip_hash = COALESCE(dr_clicks.ip_hash, EXCLUDED.ip_hash),
        fbclid = COALESCE(dr_clicks.fbclid, EXCLUDED.fbclid), gclid = COALESCE(dr_clicks.gclid, EXCLUDED.gclid)`,
    [c.click_id, c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content, c.utm_term, c.campaign_id, c.adset_id, c.ad_id,
      c.page_url, c.referrer, c.user_agent, c.ip_hash, c.fbclid, c.gclid, job.at]);
    if (job.variantId != null) {
      await pool.query(`INSERT INTO dr_experiment_assignments (experiment_id, variant_id, click_id, session_key, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5::timestamptz AT TIME ZONE 'UTC',$5::timestamptz AT TIME ZONE 'UTC')
        ON CONFLICT (experiment_id, click_id) DO UPDATE SET variant_id = EXCLUDED.variant_id, session_key = EXCLUDED.session_key, updated_at = NOW()`,
      [job.experimentId, job.variantId, c.click_id, job.visitorKey, job.at]);
    }
  }
  function enqueue(job) {
    if (queue.length >= QUEUE_MAX) { queue.shift(); stats.dropped += 1; }
    queue.push(job); stats.queued += 1;
  }
  async function flush() {
    if (flushing || !queue.length || !dbAvailable()) return;
    flushing = true;
    try {
      while (queue.length && dbAvailable()) {
        const job = queue[0];
        try { await withTimeout(persist(job), 5000); queue.shift(); stats.persisted_late += 1; }
        catch (error) {
          tripBreaker(); job.attempts = (job.attempts || 0) + 1;
          if (job.attempts >= JOB_ATTEMPTS) { queue.shift(); stats.dropped += 1; console.error("Router: clique descartado apos varias tentativas de gravacao"); }
          break;
        }
      }
    } finally { flushing = false; }
  }
  const timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  if (timer.unref) timer.unref();

  async function handler(req, res) {
    try {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      if (!slug) return res.status(400).json({ ok: false, error: "slug obrigatorio" });
      const cookies = parseCookies(req.headers.cookie || "");
      const { clickId, visitorKey } = resolveRouterIdentity(req.query, cookies);
      const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
      const secure = req.secure || forwardedProto === "https";
      res.append("Set-Cookie", cookieHeader("dr_click_id", clickId, secure));
      res.append("Set-Cookie", cookieHeader("dr_visitor_id", visitorKey, secure));

      const config = await loadConfig(slug);
      const fallbackUrl = String(env.DR_ROUTER_FALLBACK_URL || "").trim();
      if (config.experiment === null) return res.status(404).json({ ok: false, error: "router nao encontrado" });
      if (config.experiment === undefined) {
        // Servico recem-iniciado com o banco fora do ar: sem configuracao em memoria. Ainda assim nao devolve erro
        // ao visitante se houver um destino de emergencia configurado.
        if (!fallbackUrl) return res.status(503).json({ ok: false, error: "router temporariamente indisponivel" });
        stats.fallback += 1; stats.redirects += 1;
        return res.redirect(302, buildRedirectUrl(fallbackUrl, routingTrackingParams(req.query, clickId, slug, "fallback")));
      }
      if (!config.variants.length) return res.status(503).json({ ok: false, error: "router sem variantes ativas" });

      const variant = (await stickyVariant(config, clickId, visitorKey)) || selectWeightedVariant(config.variants, visitorKey);
      if (!variant) return res.status(503).json({ ok: false, error: "nenhuma variante elegivel" });
      const redirectUrl = buildRedirectUrl(variant.destination_url, routingTrackingParams(req.query, clickId, config.experiment.slug, variant.name));

      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
      const q = req.query, text = value => (typeof value === "string" && value ? value.slice(0, 2000) : null);
      const job = { at: new Date(now()).toISOString(), experimentId: config.experiment.id, variantId: variant.id, visitorKey,
        click: { click_id: clickId, utm_source: text(q.utm_source), utm_medium: text(q.utm_medium), utm_campaign: text(q.utm_campaign),
          utm_content: text(q.utm_content), utm_term: text(q.utm_term), campaign_id: text(q.campaign_id), adset_id: text(q.adset_id),
          ad_id: text(q.ad_id), page_url: `${req.protocol}://${req.get("host")}${req.originalUrl}`.slice(0, 2000),
          referrer: text(req.get("referer")), user_agent: text(req.get("user-agent")), ip_hash: hashIp(ip), fbclid: text(q.fbclid), gclid: text(q.gclid) } };
      // Em condicoes normais a gravacao termina antes do redirecionamento. Se o banco estiver lento ou fora,
      // o visitante segue e a gravacao continua em segundo plano.
      let saved = false;
      if (dbAvailable()) {
        const writing = persist(job).then(() => { saved = true; });
        try { await withTimeout(writing, PERSIST_WAIT_MS); }
        catch (error) {
          // Banco lento tambem pausa as consultas: os proximos visitantes nao esperam por ele.
          tripBreaker();
          if (error.timedOut) writing.then(() => {}, () => { enqueue(job); });
          else enqueue(job);
        }
      } else enqueue(job);
      stats.redirects += 1;
      if (config.degraded || !saved) stats.degraded += 1;
      return res.redirect(302, redirectUrl);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ ok: false, error: statusCode < 500 ? error.message : "erro interno" });
    }
  }
  return { handler, flush, stop: () => clearInterval(timer),
    health: () => ({ ...stats, queue: queue.length, cached_routes: cache.size, database_paused: !dbAvailable(),
      emergency_destination_configured: Boolean(String(env.DR_ROUTER_FALLBACK_URL || "").trim()) }) };
}
module.exports = { createRouter, withTimeout, CONFIG_TTL_MS, PERSIST_WAIT_MS };

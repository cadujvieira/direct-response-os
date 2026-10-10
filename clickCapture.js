// Registro de cliques vindos da tag das paginas (sem redirecionamento) e recuperacao pelo checkout.
// O primeiro registro de um click_id vale: reenvios so completam campos vazios, nunca trocam a origem.
const crypto = require("crypto");
const { requireAdmin } = require("./trackingHealth");
const { secretMatches } = require("./metaAds");

const CLICK_ID = /^[A-Za-z0-9_.:=+\/-]{1,200}$/;
// Formato gerado pela tag: "dr_" + UUID. So esse formato pode ser recuperado a partir do checkout.
const TAG_CLICK_ID = /^dr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// checkout_sem_origem: venda paga cujo checkout nao trouxe codigo de clique; o "clique" so existe para a venda
// entrar nos totais (decisao do titular: vendas iguais ao gateway). Fica sem campanha, a nao ser que o proprio
// checkout tenha devolvido UTMs.
const SOURCES = new Set(["tag", "router", "checkout_recovered", "checkout_sem_origem", "legacy"]);
const RATE_WINDOW_MS = 60000, RATE_MAX = 120, RATE_KEYS_MAX = 50000, RATE_GLOBAL_MAX = 6000;
// Eventos que so um servidor confiavel pode gravar. Os demais (ex.: landing_view) continuam publicos.
const PROTECTED_EVENTS = new Set(["purchase", "mentorship_purchase", "order_bump_purchase", "refund",
  "call_booked", "call_attended", "call_no_show", "mentorship_offer"]);

function field(value, max = 500) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).replace(/[\u0000-\u001f]/g, " ").trim();
  return result ? result.slice(0, max) : null;
}
function mediaId(value) {
  const result = field(value, 64);
  return result && /^[0-9A-Za-z_-]{1,64}$/.test(result) ? result : null;
}
// Padrao de URL da UTMify: "nome|id" em utm_campaign, utm_medium e utm_content.
// Usado apenas quando o ID explicito nao veio; nada e deduzido de nomes sem o sufixo numerico.
function idFromUtm(value) {
  const match = typeof value === "string" ? value.trim().match(/\|(\d{6,30})$/) : null;
  return match ? match[1] : null;
}
function normalizeClick(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const clickId = typeof input.click_id === "string" ? input.click_id.trim() : "";
  if (!CLICK_ID.test(clickId)) return null;
  const utm = { utm_source: field(input.utm_source), utm_medium: field(input.utm_medium),
    utm_campaign: field(input.utm_campaign), utm_content: field(input.utm_content), utm_term: field(input.utm_term) };
  return { click_id: clickId, ...utm,
    campaign_id: mediaId(input.campaign_id) || idFromUtm(utm.utm_campaign),
    adset_id: mediaId(input.adset_id) || idFromUtm(utm.utm_medium),
    ad_id: mediaId(input.ad_id) || idFromUtm(utm.utm_content),
    fbclid: field(input.fbclid, 1000), gclid: field(input.gclid, 1000),
    page_url: field(input.page_url, 2000), referrer: field(input.referrer, 2000) };
}
async function initClickCaptureDb(pool) {
  await pool.query("ALTER TABLE dr_clicks ADD COLUMN IF NOT EXISTS capture_source TEXT");
}
// A origem (UTMs + IDs de midia) e um bloco unico: so e gravada em um clique existente se ele nao tiver nenhuma.
// Assim um segundo envio nunca mistura a campanha de uma origem com os IDs de outra.
const UNATTRIBUTED = "COALESCE(c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content, c.utm_term, c.campaign_id, c.adset_id, c.ad_id) IS NULL";
// Insere o clique ou completa um ja existente. Nunca sobrescreve atribuicao.
async function saveClick(db, click, options = {}) {
  const source = SOURCES.has(options.source) ? options.source : "legacy";
  const result = await db.query(`INSERT INTO dr_clicks AS c
    (click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id,
     fbclid, gclid, page_url, referrer, user_agent, ip_hash, capture_source, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
      COALESCE($17::timestamptz AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'))
    ON CONFLICT (click_id) DO UPDATE SET
      utm_source = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.utm_source ELSE c.utm_source END,
      utm_medium = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.utm_medium ELSE c.utm_medium END,
      utm_campaign = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.utm_campaign ELSE c.utm_campaign END,
      utm_content = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.utm_content ELSE c.utm_content END,
      utm_term = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.utm_term ELSE c.utm_term END,
      campaign_id = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.campaign_id ELSE c.campaign_id END,
      adset_id = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.adset_id ELSE c.adset_id END,
      ad_id = CASE WHEN ${UNATTRIBUTED} THEN EXCLUDED.ad_id ELSE c.ad_id END,
      fbclid = COALESCE(c.fbclid, EXCLUDED.fbclid), gclid = COALESCE(c.gclid, EXCLUDED.gclid),
      page_url = COALESCE(c.page_url, EXCLUDED.page_url), referrer = COALESCE(c.referrer, EXCLUDED.referrer)
    RETURNING (xmax = 0) AS created`,
  [click.click_id, click.utm_source, click.utm_medium, click.utm_campaign, click.utm_content, click.utm_term,
    click.campaign_id, click.adset_id, click.ad_id, click.fbclid, click.gclid, click.page_url, click.referrer,
    field(options.userAgent, 500), options.ipHash || null, source, options.occurredAt || null]);
  return { created: Boolean(result.rows[0]?.created) };
}
function createRateLimiter(max = RATE_MAX, windowMs = RATE_WINDOW_MS, globalMax = RATE_GLOBAL_MAX) {
  const hits = new Map();
  let windowStart = 0, total = 0;
  return function allow(key, now = Date.now()) {
    // Teto geral: o cabecalho de IP pode ser forjado, entao o volume total tambem e limitado.
    if (now - windowStart >= windowMs) { windowStart = now; total = 0; }
    total += 1;
    if (total > globalMax) return false;
    if (hits.size > RATE_KEYS_MAX) for (const [k, entry] of hits) if (now - entry.start >= windowMs) hits.delete(k);
    if (hits.size > RATE_KEYS_MAX) return false;
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) { hits.set(key, { start: now, count: 1 }); return true; }
    entry.count += 1;
    return entry.count <= max;
  };
}
function hasAdminSecret(req) {
  const expected = String(process.env.DR_ADMIN_SECRET || "").trim();
  return Boolean(expected) && secretMatches(expected, String(req.get("x-admin-secret") || "").trim());
}
// /track/event continua publico para eventos de navegacao; receita e pos-compra exigem servidor confiavel.
function publicEventAllowed(body) {
  const name = typeof body?.event_name === "string" ? body.event_name.trim() : "";
  const value = body?.value == null || body.value === "" ? 0 : Number(body.value);
  return !PROTECTED_EVENTS.has(name) && value === 0;
}
function registerClickRoutes(app, pool, hashIp) {
  const allow = createRateLimiter();
  app.post("/track/click", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const click = normalizeClick(req.body);
      if (!click) return res.status(400).json({ ok: false, error: "click_id obrigatorio e em formato valido" });
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
      const ipHash = hashIp(ip);
      if (!allow(ipHash)) return res.status(429).json({ ok: false, error: "muitas requisicoes" });
      const source = TAG_CLICK_ID.test(click.click_id) ? "tag" : "legacy";
      await saveClick(pool, click, { source, userAgent: req.headers["user-agent"], ipHash });
      res.json({ ok: true, click_id: click.click_id });
    } catch (error) {
      console.error("track/click: falha ao registrar clique (" + (error.code || "erro interno") + ")");
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });
}
module.exports = { CLICK_ID, TAG_CLICK_ID, PROTECTED_EVENTS, normalizeClick, idFromUtm, initClickCaptureDb, saveClick,
  createRateLimiter, hasAdminSecret, publicEventAllowed, registerClickRoutes, requireAdmin, newClickId: () => "dr_" + crypto.randomUUID() };

// "Agente" de saude da operacao: junta sinais do banco, do router, das landing pages, da Hubla, da tag,
// da UTMify, das automacoes e dos erros do servidor e transforma em alertas em portugues simples.
// - recordMonitor(fonte, ok, ms, detalhe) registra um sinal e nunca derruba quem chamou;
// - collectSignals() le tudo; evaluate() aplica as regras (funcao pura, testada);
// - startHealthWatch() repete a verificacao a cada minuto mesmo com o painel fechado e guarda as mudancas;
// - o diagnostico com IA le somente o resumo abaixo: nenhum dado pessoal, token ou payload sai daqui.
const dns = require("node:dns").promises;
const net = require("node:net");
const { requireAdmin } = require("./clickCapture");
const { withTimeout } = require("./resilientRouter");

const CHECK_MS = 60000, RESULT_TTL_MS = 20000, SITE_TTL_MS = 60000, PAGES_TTL_MS = 300000;
const MAX_PAGES = 40, DIAGNOSIS_GAP_MS = 20000, COLLECT_TIMEOUT_MS = 30000, PRUNE_MS = 3600000;
// Teto de gravacoes por minuto, por fonte: uma rajada (erros, token errado no webhook) nao vira rajada no banco
// nem tira a vez das outras fontes.
const WRITES_PER_MINUTE = { hubla_auth: 5, default: 100 };
const HUBLA_WEBHOOK_PATH = "/api/integrations/hubla/webhook";
const LEVELS = { critical: 0, attention: 1, info: 2 };

async function initMonitorDb(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dr_monitor_log (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,
    ok BOOLEAN NOT NULL DEFAULT TRUE,
    ms INTEGER,
    detail TEXT
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS dr_monitor_log_source_idx ON dr_monitor_log(source, at)");
  // As leituras de saude rodam a cada minuto: precisam de indice por data para nao varrer as tabelas.
  await pool.query("CREATE INDEX IF NOT EXISTS dr_clicks_created_idx ON dr_clicks(created_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS dr_events_purchase_created_idx ON dr_events(created_at) WHERE event_name = 'purchase'");
  await pool.query("CREATE INDEX IF NOT EXISTS dr_hubla_events_received_idx ON dr_hubla_events(received_at)");
}

function createMonitor(pool, now = () => Date.now()) {
  let windowStart = 0, written = {};
  const latency = []; // tempos recentes do router, somente em memoria
  // Devolve true quando gravou. "at" permite gravar depois algo que aconteceu com o banco fora do ar.
  async function record(source, ok, ms = null, detail = "", at = null) {
    try {
      const name = String(source).slice(0, 30);
      if (now() - windowStart >= 60000) { windowStart = now(); written = {}; }
      written[name] = (written[name] || 0) + 1;
      if (written[name] > (WRITES_PER_MINUTE[name] || WRITES_PER_MINUTE.default)) return false;
      await pool.query("INSERT INTO dr_monitor_log (source, ok, ms, detail, at) VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()))",
        [name, Boolean(ok), ms == null ? null : Math.min(Math.round(ms), 2000000000), String(detail || "").slice(0, 255), at]);
      return true;
    } catch (error) { return false; /* o monitor nunca derruba a operacao */ }
  }
  async function prune() {
    try { await pool.query("DELETE FROM dr_monitor_log WHERE at < NOW() - INTERVAL '30 days'"); } catch (error) { /* tenta na proxima hora */ }
  }
  // Registra erros 5xx e avisos da Hubla recusados por token; mede o tempo do router.
  function middleware(req, res, next) {
    const started = now();
    res.on("finish", () => {
      const path = String(req.path || "").slice(0, 120);
      if (path.indexOf("/go/") === 0) {
        latency.push({ at: now(), ms: now() - started });
        if (latency.length > 500) latency.shift();
      }
      if (res.statusCode >= 500) record("erro", false, now() - started, req.method + " " + path + ": HTTP " + res.statusCode);
      else if (res.statusCode === 401 && path === HUBLA_WEBHOOK_PATH) record("hubla_auth", false, null, "token recusado");
    });
    next();
  }
  function routerLatency() {
    const recent = latency.filter(item => now() - item.at < 300000);
    if (!recent.length) return { samples: 0, avg_ms: null, max_ms: null };
    return { samples: recent.length, avg_ms: Math.round(recent.reduce((sum, item) => sum + item.ms, 0) / recent.length),
      max_ms: Math.max(...recent.map(item => item.ms)) };
  }
  return { record, prune, middleware, routerLatency };
}

async function sourceSummary(pool, source, minutes) {
  const row = (await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT ok)::int AS failures,
      ROUND(AVG(ms) FILTER (WHERE ok))::int AS ms, MAX(at) FILTER (WHERE ok) AS last_ok,
      (ARRAY_AGG(detail ORDER BY at DESC) FILTER (WHERE NOT ok))[1] AS reason
    FROM dr_monitor_log WHERE source = $1 AND at >= NOW() - make_interval(mins => $2)`, [source, minutes])).rows[0];
  return { total: row.total, failures: row.failures, ms: row.ms, last_ok: row.last_ok, reason: row.reason || "" };
}

function publicBase(env) {
  const base = String(env.DR_PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? base : "";
}
// Enderecos internos nunca sao consultados pelo monitor: so nomes publicos (com ponto), nunca IP privado.
const privateIp = ip => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
  /^(::1?$|f[cd]|fe80|::ffff:)/i.test(ip);
function probeAllowed(value) {
  let url;
  try { url = new URL(value); } catch (error) { return false; }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
  if (host.indexOf(".") < 0 || host.endsWith(".") || host.indexOf(":") >= 0) return false;
  if (/\.(local|internal|localhost)$/.test(host)) return false;
  return !(net.isIP(host) && privateIp(host));
}
async function resolvesPublic(value, lookup) {
  try {
    const found = await lookup(new URL(value).hostname, { all: true });
    return found.length > 0 && found.every(item => !privateIp(item.address));
  } catch (error) { return true; /* nome que nao resolve: a propria consulta acusa a falha */ }
}
// Uma consulta, seguindo no maximo 3 redirecionamentos e conferindo cada destino.
async function probeOnce(url, fetchImpl, lookup) {
  const started = Date.now();
  try {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!probeAllowed(target) || !(await resolvesPublic(target, lookup))) return { ok: false, status: 0, ms: Date.now() - started, error: "endereço não permitido", skipped: true };
      const response = await fetchImpl(target, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { "user-agent": "OfertaDRMonitor/1.0" } });
      if (response.body && response.body.cancel) response.body.cancel().catch(() => {});
      const next = response.status >= 300 && response.status < 400 && response.headers && response.headers.get("location");
      if (!next) return { ok: response.status >= 200 && response.status < 300, status: response.status, ms: Date.now() - started };
      target = new URL(next, target).toString();
    }
    return { ok: false, status: 0, ms: Date.now() - started, error: "redirecionamentos demais" };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: error.name === "TimeoutError" ? "sem resposta em 10 s" : "sem conexão" };
  }
}
// Respostas que indicam protecao contra robos, nao queda.
const unverifiable = status => [401, 403, 406, 429].includes(status);
// Dominio em que TODAS as paginas (3 ou mais) responderam erro 4xx ao mesmo tempo. Paginas diferentes nao somem
// juntas com 404: o padrao e de hospedagem barrando o monitor. Queda real costuma vir como falha de conexao ou 5xx.
function refusedHosts(pages) {
  const groups = new Map();
  for (const page of pages || []) {
    if (!page || !page.host || page.skipped) continue;
    if (!groups.has(page.host)) groups.set(page.host, []);
    groups.get(page.host).push(page);
  }
  const refused = new Map();
  for (const [host, list] of groups) {
    if (list.length >= 3 && list.every(page => !page.ok && page.status >= 400 && page.status < 500)) refused.set(host, list);
  }
  return refused;
}
// Uma falha passageira nao vira alarme: sem conexao ou erro 5xx sao repetidos uma vez antes de acusar queda.
// Respostas 4xx sao definitivas (pagina inexistente ou monitor barrado): repetir so aumenta a chance de bloqueio.
async function probe(url, fetchImpl, lookup = dns.lookup, retryMs = 2000) {
  const first = await probeOnce(url, fetchImpl, lookup);
  if (first.ok || first.skipped || (first.status >= 400 && first.status < 500)) return first;
  await new Promise(resolve => setTimeout(resolve, retryMs));
  return probeOnce(url, fetchImpl, lookup);
}
const pageLabel = value => { try { const u = new URL(value); return u.hostname + (u.pathname === "/" ? "" : u.pathname); } catch (error) { return "endereco invalido"; } };

function createCollector({ pool, router, monitor, env = process.env, fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
  lookup = dns.lookup, retryMs = 2000, gapMs = 400, firstWaitMs = 12000 }) {
  const cache = { site: null, pages: null };
  const startedAt = now();
  const drops = []; // leituras do contador de descartes do router, para saber o que e recente

  // O proprio servico visto de fora (passa pela mesma entrada que o visitante usa), no maximo uma vez por minuto.
  async function measureSite() {
    const base = publicBase(env);
    if (!base) return null;
    if (cache.site && now() - cache.site.at < SITE_TTL_MS) return cache.site.value;
    const targets = [["service", "/health"], ["tag", "/assets/dr-checkout.js"]];
    const results = await Promise.all(targets.map(([, path]) => probe(base + path, fetchImpl, lookup, retryMs)));
    const value = {};
    targets.forEach(([name], index) => { value[name] = results[index]; });
    cache.site = { at: now(), value };
    const bad = Object.entries(value).find(([, item]) => !item.ok);
    monitor.record("site", !bad, Math.max(...Object.values(value).map(item => item.ms)), bad ? bad[0] + " " + (bad[1].status || bad[1].error) : "");
    return value;
  }
  // Cada landing page que esta recebendo trafego do router, a cada 5 minutos.
  // As paginas sao conferidas em segundo plano: a leitura de saude nunca espera por elas (22 paginas, uma por vez,
  // passam facil de 30 segundos). Quem pergunta recebe a ultima leitura; so a primeira de todas espera um pouco.
  let pagesRefresh = null;
  const refusing = new Set(); // dominios que estao barrando o monitor
  async function refreshPages(targets, key) {
    // O checkout nao e consultado: visitas do monitor distorceriam os numeros de conversao da Hubla.
    const chosen = targets.filter(target => probeAllowed(target.destination_url) &&
      !/(^|\.)hub\.la$/i.test(new URL(target.destination_url).hostname)).slice(0, MAX_PAGES);
    // Dominios diferentes em paralelo; dentro do mesmo dominio, uma pagina por vez e com intervalo, para a
    // hospedagem nao tratar o monitor como ataque (12 consultas simultaneas ja fizeram um host responder 404 a todas).
    const byHost = new Map();
    chosen.forEach((target, index) => {
      const host = new URL(target.destination_url).hostname.toLowerCase();
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push({ target, index, host });
    });
    const value = new Array(chosen.length);
    const entry = (item, result) => ({ route: item.target.slug, name: item.target.name, host: item.host,
      page: pageLabel(item.target.destination_url), ...result });
    await Promise.all([...byHost.entries()].map(async ([host, group]) => {
      let rest = group, asked = false;
      if (refusing.has(host)) {
        asked = true;
        // Dominio barrando o monitor: uma unica consulta de sondagem por rodada. Insistir em todas as paginas
        // mantem o bloqueio; com uma so, ele tende a expirar. Voltando a responder, confere todas de novo.
        const canary = await probeOnce(group[0].target.destination_url, fetchImpl, lookup);
        if (!canary.ok && canary.status >= 400 && canary.status < 500) {
          group.forEach(item => { value[item.index] = entry(item, { ok: false, status: canary.status, ms: canary.ms }); });
          return;
        }
        refusing.delete(host);
        value[group[0].index] = entry(group[0], canary);
        rest = group.slice(1);
      }
      for (const item of rest) {
        if (asked && gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
        asked = true;
        value[item.index] = entry(item, await probe(item.target.destination_url, fetchImpl, lookup, retryMs));
      }
    }));
    const refused = refusedHosts(value);
    for (const host of byHost.keys()) { if (refused.has(host)) refusing.add(host); else refusing.delete(host); }
    const bad = value.find(item => !item.ok && !item.skipped && !unverifiable(item.status) && !refused.has(item.host));
    // Pagina isolada com falha: confere de novo em 1 minuto. Dominio inteiro recusando o monitor: mantem o
    // ritmo normal, porque insistir so piora o bloqueio.
    cache.pages = { at: now(), value, key, failing: Boolean(bad) };
    if (value.length) monitor.record("lp", !bad, Math.max(...value.map(item => item.ms)), bad ? bad.page + " " + (bad.status || bad.error) : "");
    return value;
  }
  async function measurePages(targets) {
    // Confere de novo a cada 5 minutos; a cada minuto enquanto houver pagina com falha; e na hora se as rotas mudarem.
    const key = targets.map(target => target.slug + "|" + target.destination_url).join("\n");
    const known = cache.pages && cache.pages.key === key ? cache.pages : null;
    if (known && now() - known.at < (known.failing ? SITE_TTL_MS : PAGES_TTL_MS)) return known.value;
    if (!pagesRefresh) pagesRefresh = refreshPages(targets, key).catch(() => null).finally(() => { pagesRefresh = null; });
    if (known) return known.value;
    try { return await withTimeout(pagesRefresh, firstWaitMs); } catch (error) { return null; }
  }

  async function collect() {
    const s = { now: new Date(now()).toISOString(), uptime_min: Math.round((now() - startedAt) / 60000),
      memory_mb: Math.round(process.memoryUsage().rss / 1048576), router: router ? { ...router.health() } : null,
      router_latency: monitor.routerLatency(), public_url_configured: Boolean(publicBase(env)) };
    if (s.router) {
      // "dropped" conta desde o inicio do processo; o alerta olha so o que foi descartado na ultima hora.
      drops.push({ at: now(), dropped: Number(s.router.dropped || 0) });
      while (drops.length > 1 && now() - drops[0].at > 3600000) drops.shift();
      s.router.dropped_1h = Math.max(0, Number(s.router.dropped || 0) - drops[0].dropped);
    }
    const started = now();
    try { await pool.query("SELECT 1"); s.db_ms = now() - started; }
    catch (error) { s.db_ms = null; s.db_error = error.code || "sem conexao"; return s; }
    const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0] || {};
    const utcNow = "(NOW() AT TIME ZONE 'UTC')";

    s.site = await measureSite();
    const routes = (await pool.query(`SELECT e.slug, v.name, v.destination_url FROM dr_experiments e
      JOIN dr_experiment_variants v ON v.experiment_id = e.id AND v.active = TRUE AND v.weight > 0
      WHERE e.active = TRUE ORDER BY e.id, v.id`)).rows;
    s.routes_without_page = (await pool.query(`SELECT e.slug FROM dr_experiments e WHERE e.active = TRUE AND NOT EXISTS (
      SELECT 1 FROM dr_experiment_variants v WHERE v.experiment_id = e.id AND v.active = TRUE AND v.weight > 0) ORDER BY e.id LIMIT 10`)).rows.map(r => r.slug);
    s.active_routes = new Set(routes.map(r => r.slug)).size;
    s.pages = await measurePages(routes);
    if (s.pages === null) { s.pages = []; s.pages_pending = true; } // primeira conferencia ainda em andamento

    const clicks = await one(`SELECT COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '30 minutes')::int AS m30,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '60 minutes')::int AS m60,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '6 hours')::int AS h6,
        COUNT(*) FILTER (WHERE created_at < ${utcNow} - INTERVAL '60 minutes')::int AS previous_24h,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '60 minutes' AND capture_source = 'router')::int AS router_m60,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '60 minutes' AND capture_source = 'tag')::int AS tag_m60,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '24 hours' AND capture_source = 'checkout_recovered')::int AS recovered_24h
      FROM dr_clicks WHERE created_at >= ${utcNow} - INTERVAL '25 hours'`);
    s.clicks = clicks;
    s.sales = await one(`SELECT COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '60 minutes')::int AS m60,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '6 hours')::int AS h6,
        COUNT(*) FILTER (WHERE created_at >= ${utcNow} - INTERVAL '24 hours')::int AS h24,
        COUNT(*)::int AS d7, MAX(created_at AT TIME ZONE 'UTC') AS last_at
      FROM dr_events WHERE event_name = 'purchase' AND created_at >= ${utcNow} - INTERVAL '7 days'`);

    const hubla = await one(`SELECT
        COUNT(*) FILTER (WHERE status = 'received' AND next_attempt_at < NOW() - INTERVAL '5 minutes')::int AS queue_late,
        COUNT(*) FILTER (WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes')::int AS stuck,
        COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '60 minutes')::int AS failed_1h,
        COUNT(DISTINCT invoice_id) FILTER (WHERE status = 'pending_attribution' AND received_at >= NOW() - INTERVAL '24 hours')::int AS unattributed_24h,
        COUNT(DISTINCT invoice_id) FILTER (WHERE status = 'needs_review')::int AS review,
        COUNT(DISTINCT invoice_id) FILTER (WHERE status = 'unmapped_product' AND received_at >= NOW() - INTERVAL '24 hours')::int AS unmapped_24h,
        COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::int AS notices_24h,
        COUNT(*) FILTER (WHERE received_at < NOW() - INTERVAL '24 hours' AND received_at >= NOW() - INTERVAL '8 days')::int AS notices_prev_7d,
        MAX(received_at) AS last_at
      FROM dr_hubla_events WHERE sandbox = FALSE AND (received_at >= NOW() - INTERVAL '8 days'
        OR status IN ('received','processing','needs_review'))`);
    s.hubla = { ...hubla, token_configured: Boolean(String(env.HUBLA_WEBHOOK_TOKEN || "").trim()),
      refused: await sourceSummary(pool, "hubla_auth", 60) };

    s.utmify = { token_configured: Boolean(String(env.UTMIFY_MCP_TOKEN || "").trim()),
      ...(await one(`SELECT (SELECT status FROM dr_utmify_syncs ORDER BY id DESC LIMIT 1) AS last_status,
        (SELECT MAX(finished_at) FROM dr_utmify_syncs WHERE status = 'completed') AS last_ok_at`)),
      feed: await sourceSummary(pool, "utmify_gasto", 120) };
    s.automations = await one(`SELECT COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= NOW() - INTERVAL '60 minutes')::int AS failed_1h,
        COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_for < NOW() - INTERVAL '15 minutes')::int AS late
      FROM dr_automation_runs WHERE updated_at >= NOW() - INTERVAL '7 days' OR status = 'pending'`);
    s.errors = await sourceSummary(pool, "erro", 60);
    return s;
  }
  return { collect };
}

const seconds = ms => (ms / 1000).toFixed(1).replace(".", ",") + " s";
const minutesSince = (value, nowIso) => (value ? Math.round((new Date(nowIso).getTime() - new Date(value).getTime()) / 60000) : null);
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// Regras do agente. Entrada: sinais coletados. Saida: nivel geral + alertas ordenados por gravidade.
function evaluate(s) {
  const alerts = [];
  const add = (level, title, text, action) => alerts.push({ level, title, text, action });
  const router = s.router || {};

  if (s.db_ms == null) {
    add("critical", "Banco de dados fora do ar", "O Oferta DR não conseguiu falar com o banco (" + (s.db_error || "sem conexão") + ").",
      (router.cached_routes > 0 ? "O router continua mandando os visitantes para as páginas com a última configuração guardada, e os cliques ficam em fila. "
        : "") + "Abra o Render e veja a situação do banco direct-response-db. Vendas da Hubla voltam sozinhas quando o banco voltar: a Hubla reenvia.");
    if (router.queue > 0) add("attention", "Cliques aguardando gravação", plural(router.queue, "clique está", "cliques estão") + " guardados na memória do router.", "São gravados sozinhos quando o banco voltar. Evite reiniciar o serviço até lá.");
    return close(alerts, s);
  }
  if (s.db_ms > 800) add("attention", "Banco de dados lento", "O banco levou " + s.db_ms + " ms para responder uma consulta simples.", "Se continuar assim, veja o uso do banco no Render. O router não espera o banco para redirecionar.");

  // Servico visto de fora
  const siteNames = { service: "O serviço do Oferta DR", tag: "O arquivo da tag das páginas" };
  for (const [name, item] of Object.entries(s.site || {})) {
    if (!item.ok) add("critical", siteNames[name] + " não responde", siteNames[name] + " respondeu " + (item.status || item.error || "erro") + " quando o monitor tentou abrir pelo endereço público.",
      "Abra o Render e veja se o serviço está no ar e como terminou a última publicação. Enquanto isso, links que passam pelo router podem falhar.");
    else if (item.ms > 4000) add("attention", siteNames[name] + " está lento", "Levou " + seconds(item.ms) + " para responder pelo endereço público.", "Pode ser pico de acessos. Se durar mais de 10 minutos, veja o uso de CPU e memória no Render.");
  }

  // Landing pages que recebem trafego
  const refused = refusedHosts(s.pages);
  for (const [host, list] of refused) {
    const codes = [...new Set(list.map(page => page.status))].join(", ");
    add("attention", "Não consegui conferir as páginas de " + host, "As " + list.length + " páginas de " + host + " responderam " + codes +
      " ao monitor ao mesmo tempo. Quando todas falham juntas com esse tipo de resposta, o mais comum é a hospedagem estar barrando o monitor, e não as páginas terem caído.",
      "Abra uma delas em uma aba anônima. Se abrir normal, os visitantes e as vendas não são afetados; peça à hospedagem para liberar o monitor (ele se identifica como OfertaDRMonitor). Se não abrir, o site caiu: tire o peso dessas páginas na aba Router.");
  }
  s.pages = (s.pages || []).map(page => (refused.has(page.host) ? { ...page, refused_by_host: true } : page));
  for (const page of s.pages) {
    if (page.refused_by_host) continue;
    const label = page.name + " (" + page.page + ")";
    if (page.ok) { if (page.ms > 5000) add("attention", "Landing page lenta: " + page.name, label + " levou " + seconds(page.ms) + " para abrir.", "Página lenta derruba conversão. Veja a hospedagem dessa página."); }
    else if (page.skipped) continue;
    else if (unverifiable(page.status)) add("info", "Não consegui conferir a página " + page.name, label + " recusou a visita do monitor (resposta " + page.status + ").", "Costuma ser proteção contra robôs, não queda. Abra a página em uma aba anônima para confirmar.");
    else add("critical", "Landing page fora do ar: " + page.name, label + " respondeu " + (page.status || page.error) + ". O router " + (page.route ? "\"" + page.route + "\" " : "") + "está mandando visitantes para ela.",
      "Abra a página em uma aba anônima. Se estiver fora, tire o peso dela na aba Router até voltar.");
  }

  // Router
  for (const slug of s.routes_without_page || []) add("critical", "Rota sem página ativa: " + slug, "A rota \"" + slug + "\" está ligada, mas nenhuma landing page tem peso para receber visitantes.", "Quem clicar em um link dessa rota recebe erro. Dê peso a pelo menos uma página na aba Router.");
  if (router.dropped_1h > 0) add("critical", "Router descartou cliques", plural(router.dropped_1h, "clique não pôde ser gravado", "cliques não puderam ser gravados") + " na última hora.", "Os visitantes foram redirecionados normalmente; a venda ainda é atribuída pela tag e pelo checkout. Me avise para investigar o banco.");
  if (router.queue > 0) add("attention", "Cliques aguardando gravação", plural(router.queue, "clique está", "cliques estão") + " em fila na memória do router.", "É gravado sozinho em alguns segundos. Se o número só crescer, o banco está com problema.");
  else if (router.database_paused) add("info", "Router sem consultar o banco por alguns segundos", "Uma consulta ao banco falhou ou demorou; o router está usando a configuração guardada em memória.", "Volta sozinho em 5 segundos. Só é problema se aparecer o tempo todo.");
  const latency = s.router_latency || {};
  if (latency.samples >= 5 && latency.avg_ms > 1500) add("attention", "Router demorando para redirecionar", "Média de " + seconds(latency.avg_ms) + " nos últimos 5 minutos (" + latency.samples + " cliques).", "O normal é abaixo de meio segundo. Veja o uso de CPU do serviço no Render.");
  if (s.active_routes > 0 && router.emergency_destination_configured === false) add("info", "Destino de emergência não configurado", "Se o serviço reiniciar com o banco fora do ar, o router não tem para onde mandar o visitante.", "Cadastre no Render a variável DR_ROUTER_FALLBACK_URL com o endereço da sua página principal.");

  // Trafego e vendas
  const clicks = s.clicks || {}, sales = s.sales || {};
  const hourly = Number(clicks.previous_24h || 0) / 24;
  if (hourly >= 20 && Number(clicks.m60 || 0) === 0) add("attention", "O tráfego parou", "Nenhum clique na última hora. Nas 24 horas anteriores a média foi de " + Math.round(hourly) + " por hora.",
    "Se você pausou os anúncios, está tudo certo. Se não pausou, clique em um link do anúncio e veja se a página abre.");
  if (Number(clicks.h6 || 0) >= 300 && Number(sales.h6 || 0) === 0 && Number(sales.d7 || 0) > 0) add("attention", "Tráfego chegando, nenhuma venda em 6 horas",
    clicks.h6 + " cliques nas últimas 6 horas e nenhuma compra registrada.", "Faça o caminho de um cliente até o checkout e confira na Hubla se houve venda que não chegou aqui.");

  // Hubla
  const hubla = s.hubla || {};
  if (!hubla.token_configured) add("critical", "Hubla não está ligada neste ambiente", "O token do aviso de vendas não está cadastrado, então nenhuma venda entra.", "Cadastre HUBLA_WEBHOOK_TOKEN no Render e aponte uma regra de webhook da Hubla para este endereço.");
  const stalled = Number(hubla.queue_late || 0) + Number(hubla.stuck || 0);
  if (stalled > 0) add("critical", "Fila de vendas da Hubla parada", plural(stalled, "aviso da Hubla está", "avisos da Hubla estão") + " há mais de 5 minutos sem ser processado.", "As vendas estão guardadas, mas não entraram no painel. Me avise para investigar; reiniciar o serviço no Render costuma destravar.");
  if (Number(hubla.failed_1h || 0) >= 3) add("critical", "Avisos da Hubla falhando", hubla.failed_1h + " avisos falharam ao processar na última hora.", "Veja o motivo em Integrações > Hubla. O sistema tenta de novo sozinho.");
  else if (Number(hubla.failed_1h || 0) > 0) add("attention", "Aviso da Hubla com falha", plural(Number(hubla.failed_1h), "aviso falhou", "avisos falharam") + " na última hora; nova tentativa já agendada.", "Só se preocupe se virar vermelho.");
  const unattributed = Number(hubla.unattributed_24h || 0);
  // Critico so quando e parte relevante das vendas: com volume alto, alguns compradores entram direto no checkout.
  if (unattributed >= 3 && unattributed >= Math.max(Number(sales.h24 || 0), unattributed) * 0.2) add("critical", "Vendas chegando sem origem", unattributed + " vendas das últimas 24 horas chegaram sem o código do clique.", "Alguma página não está repassando o clique ao checkout. Confira com a Black Track se a tag continua publicada em todas as páginas.");
  else if (unattributed > 0) add("attention", "Venda sem origem", plural(unattributed, "venda chegou", "vendas chegaram") + " sem o código do clique nas últimas 24 horas.", "Veja em Integrações > Hubla. Pode ser alguém que entrou direto no checkout.");
  if (Number(hubla.review || 0) > 0) add("attention", "Vendas da Hubla esperando sua conferência", plural(Number(hubla.review), "fatura precisa", "faturas precisam") + " de revisão (reembolso parcial, parcelamento ou caso fora do padrão).", "Abra Integrações > Hubla e resolva as pendências da lista.");
  if (Number(hubla.unmapped_24h || 0) > 0) add("attention", "Venda de produto não cadastrado", plural(Number(hubla.unmapped_24h), "venda", "vendas") + " das últimas 24 horas de um produto que o Oferta DR não conhece.", "Me passe o produto para eu cadastrar; a venda entra sozinha depois.");
  if ((hubla.refused || {}).failures >= 3) add("attention", "Avisos recusados por token errado", hubla.refused.failures + " avisos chegaram com token diferente do cadastrado na última hora.", "Se você trocou o token na Hubla, atualize HUBLA_WEBHOOK_TOKEN no Render. Se não trocou, pode ignorar.");
  if (hubla.token_configured && Number(hubla.notices_prev_7d || 0) >= 21 && Number(hubla.notices_24h || 0) === 0) add("attention", "Nenhum aviso da Hubla em 24 horas", "Nos 7 dias anteriores chegaram " + hubla.notices_prev_7d + " avisos; nas últimas 24 horas, nenhum.", "Confira na Hubla (Integrações > Webhook > Histórico) se os envios estão dando erro.");
  if (Number(clicks.recovered_24h || 0) >= 3 && Number(clicks.recovered_24h) >= Number(sales.h24 || 0) * 0.3) add("attention", "A tag das páginas não está avisando os cliques",
    clicks.recovered_24h + " cliques das últimas 24 horas só foram conhecidos pelo checkout, na hora da compra.", "As vendas estão sendo atribuídas, mas o painel perde os visitantes que não compram. Confira com a Black Track se a versão nova da tag está publicada.");

  // UTMify, automacoes, erros, processo
  const utmify = s.utmify || {};
  const feed = utmify.feed || {};
  if (utmify.token_configured && feed.total >= 2 && feed.failures === feed.total) add("attention", "Investimento da UTMify não está atualizando",
    "As últimas " + feed.total + " buscas automáticas do investimento falharam. Motivo: " + (feed.reason || "sem detalhe") + ".",
    "O investimento da Visão geral fica parado até voltar. Se o motivo citar UTMIFY_META_ACCOUNTS, confira os nomes das contas no Render; se não, me avise.");
  if (utmify.token_configured && utmify.last_status === "failed") add("attention", "Última atualização da UTMify falhou", "Os números de anúncios do painel podem estar desatualizados.", "Abra Integrações e clique em sincronizar de novo.");
  const automations = s.automations || {};
  if (Number(automations.late || 0) > 0) add("attention", "Automações atrasadas", plural(Number(automations.late), "tarefa automática está", "tarefas automáticas estão") + " há mais de 15 minutos na fila.", "Me avise se não normalizar em meia hora.");
  if (Number(automations.failed_1h || 0) > 0) add("attention", "Automação com falha", plural(Number(automations.failed_1h), "tarefa automática falhou", "tarefas automáticas falharam") + " na última hora.", "Veja o motivo na aba Automações.");
  const errors = s.errors || {};
  if (errors.total >= 5) add("critical", "Erros no servidor", errors.total + " erros internos na última hora. Último: " + errors.reason, "Algo está quebrando. Me chame com esse texto que eu investigo.");
  else if (errors.total > 0) add("attention", "Erro interno registrado", plural(errors.total, "erro", "erros") + " na última hora. Último: " + errors.reason, "Pode ser pontual. Se repetir, me avise.");
  if (s.memory_mb >= 430) add("attention", "Memória do serviço alta", "O serviço está usando " + s.memory_mb + " MB.", "Perto do limite o Render reinicia o serviço. Me avise se aparecer com frequência.");
  if (s.uptime_min != null && s.uptime_min < 10) add("info", "Serviço reiniciou há pouco", "O Oferta DR está no ar há " + plural(s.uptime_min, "minuto", "minutos") + ".", "Normal logo depois de uma publicação. Fora disso, me avise.");
  if (!s.public_url_configured) add("info", "Monitor sem endereço público", "O monitor não sabe qual endereço abrir para testar o serviço por fora.", "Cadastre DR_PUBLIC_URL no Render com o endereço do Oferta DR.");
  return close(alerts, s);
}

function close(alerts, s) {
  alerts.sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);
  const level = alerts.some(a => a.level === "critical") ? "critical" : alerts.some(a => a.level === "attention") ? "attention" : "ok";
  const at = new Date(s.now || Date.now());
  const sales = s.sales || {};
  // Metricas mostradas no painel e enviadas ao diagnostico: somente contagens e tempos.
  const metrics = { db_ms: s.db_ms == null ? null : s.db_ms, site: s.site || null, pages: s.pages || [], pages_pending: Boolean(s.pages_pending), active_routes: s.active_routes || 0,
    router: s.router || null, router_latency: s.router_latency || null, clicks: s.clicks || null,
    sales: s.sales ? { m60: sales.m60, h6: sales.h6, h24: sales.h24, last_at: sales.last_at, minutes_since_last: minutesSince(sales.last_at, at.toISOString()) } : null,
    hubla: s.hubla || null, utmify: s.utmify || null, automations: s.automations || null,
    errors: s.errors ? { total: s.errors.total, reason: s.errors.reason } : null, uptime_min: s.uptime_min, memory_mb: s.memory_mb };
  return { ok: true, level, alerts, metrics, generated_at: at.toISOString(),
    time: at.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) };
}

const AGENT_INSTRUCTIONS = `Você é o monitor técnico do "Oferta DR", o sistema de rastreamento de um funil de resposta direta: anúncios da Meta levam o visitante a um router (/go) que divide o tráfego entre landing pages de ângulos diferentes; a compra acontece no checkout da Hubla, que avisa o Oferta DR por webhook; uma tag nas páginas cria e repassa o código do clique; os números de anúncio vêm da UTMify; o serviço roda no Render com banco PostgreSQL. Só a Black Track envia compras para a Meta.
Você recebe um JSON com o estado atual (alertas e métricas). Escreva para o dono da operação, que não é técnico, em português do Brasil, direto e curto.
Formato: 1) uma frase de veredito (está tudo bem / atenção / problema sério); 2) o que está acontecendo, em até 4 frases, citando os números que importam; 3) o que fazer agora, em passos numerados curtos (no máximo 4), só se houver algo a fazer. Não invente dados que não estão no JSON. Não recomende pausar, escalar ou mudar orçamento de anúncios. Se estiver tudo normal, diga isso e aponte no máximo um ponto de atenção com base nos números. Sem títulos, sem markdown pesado, sem emojis.`;

function startHealthWatch({ pool, router, monitor, env = process.env, fetchImpl }) {
  const collector = createCollector({ pool, router, monitor, env, fetchImpl });
  let last = null, running = null, signature = null, lastDiagnosis = 0, timer = null, first = null, pruner = null;
  const unsaved = []; // mudancas de situacao que nao puderam ser gravadas (banco fora do ar)

  async function check() {
    if (last && Date.now() - last.at < RESULT_TTL_MS) return last.value;
    if (running) return running;
    running = (async () => {
      let value;
      // Prazo total: uma consulta presa nao pode deixar o monitor mudo.
      try { value = evaluate(await withTimeout(collector.collect(), COLLECT_TIMEOUT_MS)); }
      catch (error) {
        value = close([error.timedOut
          ? { level: "critical", title: "Monitor não concluiu a verificação", text: "A leitura de saúde passou de 30 segundos sem resposta do banco.", action: "O banco pode estar travado ou muito lento. Veja a situação dele no Render e me avise." }
          : { level: "critical", title: "Monitor com erro", text: "A verificação de saúde falhou (" + (error.code || "erro interno") + ").", action: "Me avise com esse texto." }], {});
      }
      last = { at: Date.now(), value };
      // Guarda cada mudanca de situacao, para o painel mostrar o que aconteceu enquanto ninguem olhava.
      const next = value.level + "|" + value.alerts.filter(a => a.level !== "info").map(a => a.title).join("|");
      if (signature !== null && next !== signature) {
        unsaved.push({ ok: value.level === "ok", at: new Date().toISOString(), detail: value.level === "ok" ? "voltou ao normal"
          : value.alerts.filter(a => a.level !== "info").map(a => a.title).join("; ") });
        if (unsaved.length > 50) unsaved.shift();
      }
      signature = next;
      while (unsaved.length && await monitor.record("saude", unsaved[0].ok, null, unsaved[0].detail, unsaved[0].at)) unsaved.shift();
      return value;
    })().finally(() => { running = null; });
    return running;
  }
  // Chamado depois que as tabelas existem (start() do index.js).
  function begin() {
    if (timer) return;
    timer = setInterval(() => { check().catch(() => {}); }, CHECK_MS);
    first = setTimeout(() => { check().catch(() => {}); }, 5000);
    pruner = setInterval(() => { monitor.prune(); }, PRUNE_MS);
    for (const item of [timer, first, pruner]) if (item.unref) item.unref();
  }

  async function history() {
    try {
      return (await pool.query(`SELECT at, ok, detail FROM dr_monitor_log WHERE source = 'saude' AND at >= NOW() - INTERVAL '24 hours'
        ORDER BY at DESC LIMIT 12`)).rows;
    } catch (error) { return []; }
  }
  async function diagnose() {
    const key = String(env.ANTHROPIC_API_KEY || "").trim();
    if (!key) return { error: "Cadastre a variável ANTHROPIC_API_KEY no Render (chave da API da Anthropic) para ativar o diagnóstico com IA." };
    if (Date.now() - lastDiagnosis < DIAGNOSIS_GAP_MS) return { error: "Aguarde alguns segundos antes de pedir outro diagnóstico." };
    lastDiagnosis = Date.now();
    const health = await check(), model = String(env.ANTHROPIC_MODEL || "claude-sonnet-5-5").trim();
    try {
      const response = await (fetchImpl || fetch)("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4000, system: AGENT_INSTRUCTIONS, messages: [{ role: "user",
          content: "Agora: " + new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) + "\n\nEstado atual:\n" +
            JSON.stringify({ nivel: health.level, alertas: health.alerts, metricas: health.metrics }) +
            "\n\nMudanças nas últimas 24 horas:\n" + JSON.stringify(await history()) }] }),
        signal: AbortSignal.timeout(45000) });
      const data = await response.json().catch(() => null);
      if (!response.ok) return { error: response.status === 401 ? "A chave ANTHROPIC_API_KEY foi recusada. Confira no Render." : "A API de IA respondeu " + response.status + "." };
      const text = ((data && data.content) || []).filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      return { text, model, at: new Date().toISOString() };
    } catch (error) { return { error: "Não consegui gerar o diagnóstico agora. Tente de novo em instantes." }; }
  }
  return { begin, check, history, diagnose, stop: () => { clearInterval(timer); clearTimeout(first); clearInterval(pruner); timer = null; } };
}

function registerHealthRoutes(app, watch) {
  app.get("/api/operation-health", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    const [health, history] = await Promise.all([watch.check(), watch.history()]);
    res.json({ ...health, history });
  });
  app.post("/api/operation-health/diagnosis", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    // Sempre 200: a mensagem em portugues precisa chegar ao painel mesmo quando a IA falha.
    try { res.json({ ok: true, ...(await watch.diagnose()) }); }
    catch (error) { res.json({ ok: true, error: "Não consegui gerar o diagnóstico agora." }); }
  });
}

module.exports = { initMonitorDb, createMonitor, createCollector, evaluate, startHealthWatch, registerHealthRoutes, probeAllowed, publicBase };

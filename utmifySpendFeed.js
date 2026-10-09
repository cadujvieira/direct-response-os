// Investimento automatico pela UTMify. A Visao geral, Campanhas e os detalhamentos leem o investimento de
// dr_ad_spend, que so era preenchida pela integracao direta da Meta (desligada) ou por envio manual. Este
// processo busca na UTMify, a cada 30 minutos, o gasto do dia por anuncio (com campanha e conjunto) e grava em
// dr_ad_spend com source = 'utmify'. Cada dia buscado substitui o que havia daquele dia, entao correcoes da Meta
// entram sozinhas.
//
// Regras:
// - so roda com UTMIFY_MCP_TOKEN e respeita UTMIFY_META_ACCOUNTS (mesmas contas da sincronizacao manual);
// - se a integracao direta da Meta estiver configurada, nao roda (evita contar o mesmo gasto duas vezes);
// - consultas uma por vez, com intervalo, para nao abusar do MCP;
// - os dias seguem o fuso do dashboard da UTMify (o mesmo da sincronizacao manual).
const { callMcpTool, ensureConnection, filterMetaAccounts, normalizeMetaObject, toMcpDateRange } = require("./utmifyMcp");
const { normalizeSpendInput, upsertSpend } = require("./spendStore");

const TICK_MS = 30 * 60000, YESTERDAY_EVERY_MS = 2 * 3600000, CALL_GAP_MS = 2500, RETRY_WAITS_MS = [10000, 30000], BACKFILL_DAYS = 31, WEEK_DAYS = 7;
const LEVELS = ["campaign", "adset", "ad"];

function dayInZone(ms, timeZoneHours) {
  return new Date(ms + Number(timeZoneHours || 0) * 3600000).toISOString().slice(0, 10);
}
function shiftDay(day, delta) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
const money = value => Math.round(Number(value || 0) * 100) / 100;

// Monta as linhas de gasto de um dia: uma por anuncio, com nomes de campanha e conjunto. Se a soma dos anuncios
// de uma campanha ficar abaixo do total da campanha (anuncio sem identificacao), a diferenca entra numa linha da
// campanha, para o total do dia bater com a UTMify.
function buildSpendRows(day, objectsByLevel) {
  const names = { campaign: new Map(), adset: new Map() };
  for (const item of objectsByLevel.campaign || []) if (item.campaign_id || item.object_id) names.campaign.set(item.campaign_id || item.object_id, item.name);
  for (const item of objectsByLevel.adset || []) if (item.adset_id || item.object_id) names.adset.set(item.adset_id || item.object_id, item.name);
  const rows = [], perCampaign = new Map();
  for (const ad of objectsByLevel.ad || []) {
    const m = ad.metrics || {};
    if (!ad.campaign_id || !(Number(m.spend) > 0 || Number(m.impressions) > 0)) continue;
    rows.push({ spend_date: day, source: "utmify", campaign_id: ad.campaign_id, campaign_name: names.campaign.get(ad.campaign_id) || null,
      adset_id: ad.adset_id, adset_name: ad.adset_id ? names.adset.get(ad.adset_id) || null : null, ad_id: ad.ad_id || ad.object_id, ad_name: ad.name,
      spend: money(m.spend), impressions: Math.round(Number(m.impressions) || 0), clicks: Math.round(Number(m.media_clicks) || 0) });
    perCampaign.set(ad.campaign_id, money((perCampaign.get(ad.campaign_id) || 0) + money(m.spend)));
  }
  for (const campaign of objectsByLevel.campaign || []) {
    const id = campaign.campaign_id || campaign.object_id;
    const residual = money(Number(campaign.metrics?.spend || 0) - (perCampaign.get(id) || 0));
    if (id && residual > 0.01) rows.push({ spend_date: day, source: "utmify", campaign_id: id, campaign_name: campaign.name,
      adset_id: null, adset_name: null, ad_id: null, ad_name: null, spend: residual, impressions: 0, clicks: 0 });
  }
  return rows;
}

function metaDirectConfigured(env) {
  return Boolean(String(env.META_ACCESS_TOKEN || "").trim() && String(env.META_AD_ACCOUNT_ID || "").trim());
}

function startUtmifySpendFeed({ pool, monitor, env = process.env, now = () => Date.now(), callTool = callMcpTool,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), tickMs = TICK_MS, gapMs = CALL_GAP_MS, retryWaits = RETRY_WAITS_MS }) {
  const state = { running: null, timer: null, lastYesterdayAt: 0, weekCheckedDay: "", last: null };

  async function fetchDay(connection, accounts, day) {
    const objects = {};
    for (const level of LEVELS) {
      const args = { dashboardId: connection.dashboard_id,
        dateRange: toMcpDateRange(day, day, Number(connection.time_zone || 0)), level,
        metaAdAccountIds: accounts.length ? accounts : null, accountStatuses: ["ACTIVE"] };
      // A UTMify recusa chamadas muito seguidas (visto em producao): espera e tenta de novo antes de desistir.
      let payload;
      for (let attempt = 0; ; attempt++) {
        try { payload = await callTool("get_meta_ad_objects", args); break; }
        catch (error) { if (attempt >= retryWaits.length) throw error; await sleep(retryWaits[attempt]); }
      }
      objects[level] = (Array.isArray(payload?.results) ? payload.results : []).map(raw => normalizeMetaObject(raw, level));
      await sleep(gapMs);
    }
    return buildSpendRows(day, objects);
  }
  async function saveDay(day, rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM dr_ad_spend WHERE source = 'utmify' AND spend_date = $1::date", [day]);
      for (const row of rows) await upsertSpend(client, normalizeSpendInput(row, { defaultSource: "utmify" }));
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }

  // Quais dias buscar agora: hoje sempre; ontem a cada 2 h; a ultima semana uma vez por dia; os ultimos 31 dias
  // quando ainda nao ha nenhum gasto da UTMify gravado (primeira vez).
  async function plan(today, force) {
    const days = [today];
    if (force || now() - state.lastYesterdayAt >= YESTERDAY_EVERY_MS) days.push(shiftDay(today, -1));
    const empty = Number((await pool.query("SELECT COUNT(*)::int AS n FROM dr_ad_spend WHERE source = 'utmify'")).rows[0].n) === 0;
    const back = empty ? BACKFILL_DAYS : state.weekCheckedDay !== today ? WEEK_DAYS : 0;
    for (let n = 2; n < back; n++) days.push(shiftDay(today, -n));
    return { days, back };
  }

  async function runOnce({ force = false } = {}) {
    if (!String(env.UTMIFY_MCP_TOKEN || "").trim()) return (state.last = { ok: true, skipped: "UTMify não configurada" });
    if (metaDirectConfigured(env)) return (state.last = { ok: true, skipped: "integração direta da Meta ativa" });
    const started = now();
    try {
      const connection = await ensureConnection(pool);
      const accounts = filterMetaAccounts(connection.meta_accounts, env).map(item => item.id).filter(Boolean);
      const today = dayInZone(now(), connection.time_zone);
      const { days, back } = await plan(today, force);
      let total = 0;
      // Hoje e ontem vem primeiro e sao gravados na hora. Falha num dia antigo nao desfaz o que ja foi gravado:
      // a rodada conta como feita (hoje esta certo) e a semana e conferida de novo na proxima rodada.
      let done = 0, pending = "";
      for (const day of days) {
        try {
          const rows = await fetchDay(connection, accounts, day);
          await saveDay(day, rows);
          if (day === today) total = rows.reduce((sum, row) => sum + row.spend, 0);
          done++;
        } catch (error) {
          if (day === today) throw error;
          pending = day; break;
        }
      }
      if (days.length > 1 && done > 1) state.lastYesterdayAt = now();
      if (back && !pending) state.weekCheckedDay = today;
      state.last = { ok: true, at: new Date(now()).toISOString(), days: done, today, today_spend: money(total), ...(pending ? { pending_from: pending } : {}) };
      if (monitor) monitor.record("utmify_gasto", true, now() - started, done + " dia(s)" + (pending ? "; dias antigos ficam para a proxima rodada" : ""));
      return state.last;
    } catch (error) {
      const reason = error.statusCode === 400 ? String(error.message).slice(0, 160) : String(error.message || "falha").slice(0, 120);
      state.last = { ok: false, at: new Date(now()).toISOString(), error: reason };
      if (monitor) monitor.record("utmify_gasto", false, now() - started, reason);
      return state.last;
    }
  }
  function run(options) {
    if (!state.running) state.running = runOnce(options).finally(() => { state.running = null; });
    return state.running;
  }
  function begin(firstDelayMs = 15000) {
    if (state.timer) return;
    const first = setTimeout(() => run(), firstDelayMs);
    if (first.unref) first.unref();
    state.timer = setInterval(() => run(), tickMs);
    if (state.timer.unref) state.timer.unref();
  }
  return { begin, run, status: () => state.last };
}

function registerSpendFeedRoutes(app, feed, requireAdmin) {
  // Atualizacao na hora (botao do painel): busca hoje e ontem.
  app.post("/api/integrations/utmify/spend-refresh", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    const result = await feed.run({ force: true });
    res.json({ ...result, ok: Boolean(result.ok) }); // sempre 200: o motivo da falha vai no corpo para o painel
  });
}

module.exports = { startUtmifySpendFeed, registerSpendFeedRoutes, buildSpendRows, dayInZone, shiftDay };

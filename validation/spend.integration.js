// Homologacao local do investimento automatico pela UTMify. PostgreSQL em loopback no banco oferta_validation e
// aplicacao HTTP em loopback. A UTMify e SIMULADA (callTool falso): nenhuma chamada sai da maquina.
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { startUtmifySpendFeed, dayInZone, shiftDay } = require("../utmifySpendFeed");
const { createMonitor } = require("../operationHealth");

async function main() {
  const dbUrl = new URL(process.env.DR_VALIDATION_DATABASE_URL || "invalid:");
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
  assert.equal(dbUrl.pathname, "/oferta_validation");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const pool = new Pool({ connectionString: dbUrl.href, ssl: false });
  const get = async path => { const r = await fetch(new URL(path, base)); assert.equal(r.status, 200, path); return r.json(); };
  try {
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM dr_ad_spend")).rows[0].count), 0, "Use um banco novo");
    await pool.query(`INSERT INTO dr_utmify_connection (id, dashboard_id, dashboard_name, time_zone, currency, meta_accounts)
      VALUES (1, 'dash1', 'Principal', -3, 'BRL', $1::jsonb) ON CONFLICT (id) DO UPDATE SET meta_accounts = EXCLUDED.meta_accounts, time_zone = -3`,
    [JSON.stringify([{ id: "act1", name: "α USD 01" }, { id: "act2", name: "α USD 02" }])]);

    const clock = Date.parse("2026-10-09T15:00:00Z");
    const today = dayInZone(clock, -3), yesterday = shiftDay(today, -1);
    let spendToday = 120.5, failNext = false;
    const calls = [];
    const callTool = async (name, args) => {
      calls.push(args);
      if (failNext) throw new Error("UTMify MCP indisponivel");
      const day = args.dateRange.from.slice(0, 10);
      const amount = day === today ? spendToday : day === yesterday ? 80 : 10;
      const cents = Math.round(amount * 100);
      if (args.level === "campaign") return { results: [{ id: "111", campaignId: "111", name: "CBO Jovens", spend: cents, impressions: 1000 }] };
      if (args.level === "adset") return { results: [{ id: "222", campaignId: "111", adsetId: "222", name: "Conj 18-29", spend: cents, impressions: 1000 }] };
      return { results: [{ id: "333", campaignId: "111", adsetId: "222", adId: "333", name: "Criativo A", spend: cents, impressions: 1000, inlineLinkClicks: 40 }] };
    };
    const monitor = createMonitor(pool);
    const env = { UTMIFY_MCP_TOKEN: "fake", UTMIFY_META_ACCOUNTS: "USD 01,USD 02" };
    const feed = startUtmifySpendFeed({ pool, monitor, env, now: () => clock, callTool, sleep: async () => {}, gapMs: 0 });

    // 1. Primeira vez: ultimos 31 dias, tres niveis por dia, so as contas da oferta, fuso do dashboard
    const first = await feed.run();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.days, 31);
    assert.equal(calls.length, 93);
    assert.deepEqual(calls[0].metaAdAccountIds, ["act1", "act2"]);
    assert.equal(calls[0].dateRange.from, today + "T00:00:00-03:00");
    const rows = (await pool.query("SELECT spend_date::text AS day, source, campaign_id, campaign_name, adset_name, ad_id, ad_name, spend, clicks FROM dr_ad_spend ORDER BY spend_date DESC")).rows;
    assert.equal(rows.length, 31);
    assert.deepEqual(rows[0], { day: today, source: "utmify", campaign_id: "111", campaign_name: "CBO Jovens", adset_name: "Conj 18-29", ad_id: "333", ad_name: "Criativo A", spend: "120.5", clicks: 40 });
    console.log("PASS primeira busca grava os ultimos 31 dias por anuncio, com nomes, so das contas da oferta");

    // 2. Visao geral, grafico e campanhas passam a mostrar o investimento
    const summary = await get("/api/summary?from=" + today + "&to=" + today);
    assert.equal(Number(summary.summary.spend), 120.5);
    const all = await get("/api/summary");
    assert.equal(Number(all.summary.spend), 120.5 + 80 + 29 * 10);
    const series = await get("/api/overview/timeseries?from=" + yesterday + "&to=" + today);
    assert.deepEqual(series.points.map(p => Number(p.spend)), [80, 120.5]);
    const campaigns = await get("/api/campaigns?from=" + today + "&to=" + today);
    const row = (campaigns.campaigns || campaigns.rows || []).find(c => c.campaign_id === "111");
    assert(row && Number(row.spend) === 120.5, JSON.stringify(campaigns).slice(0, 300));
    console.log("PASS Visao geral, grafico e campanhas mostram o investimento");

    // 3. Proxima rodada: so hoje (ontem a cada 2 h); valor novo substitui, nao soma
    calls.length = 0; spendToday = 200;
    await feed.run();
    assert.equal(calls.length, 3);
    assert.equal(Number((await get("/api/summary?from=" + today + "&to=" + today)).summary.spend), 200);
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM dr_ad_spend WHERE spend_date = $1", [today])).rows[0].count), 1);
    console.log("PASS rodadas seguintes atualizam o dia sem duplicar");

    // 4. Falha da UTMify: nada e apagado e o monitor registra
    failNext = true;
    const failed = await feed.run({ force: true });
    assert.equal(failed.ok, false);
    assert.equal(Number((await get("/api/summary?from=" + today + "&to=" + today)).summary.spend), 200, "falha nao zera o investimento");
    const log = (await pool.query("SELECT ok, detail FROM dr_monitor_log WHERE source = 'utmify_gasto' ORDER BY id")).rows;
    assert.deepEqual(log.map(r => r.ok), [true, true, false]);
    console.log("PASS falha da UTMify preserva o investimento gravado e fica registrada no monitor");

    // 5. Conta pedida que nao existe: erro explicito, nada buscado
    failNext = false; calls.length = 0;
    const wrong = startUtmifySpendFeed({ pool, env: { UTMIFY_MCP_TOKEN: "fake", UTMIFY_META_ACCOUNTS: "USD 03" }, now: () => clock, callTool, sleep: async () => {}, gapMs: 0 });
    const result = await wrong.run();
    assert.equal(result.ok, false);
    assert.match(result.error, /UTMIFY_META_ACCOUNTS: conta nao encontrada.*USD 03/);
    assert.equal(calls.length, 0);
    console.log("PASS conta fora do dashboard gera erro claro e nao busca dados de outras contas");
  } finally { await pool.end(); }
}
main().catch(error => { console.error("FAIL", error); process.exit(1); });

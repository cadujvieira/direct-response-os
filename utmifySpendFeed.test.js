const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSpendRows, dayInZone, shiftDay, startUtmifySpendFeed } = require("./utmifySpendFeed");

const obj = (level, fields, spend, impressions = 100) => ({ level, name: fields.name, object_id: fields.id, campaign_id: fields.campaign_id || null,
  adset_id: fields.adset_id || null, ad_id: fields.ad_id || null, metrics: { spend, impressions, media_clicks: 3 } });

test("dia no fuso do dashboard da UTMify", () => {
  const ms = Date.parse("2026-10-09T01:30:00Z");
  assert.equal(dayInZone(ms, -3), "2026-10-08");
  assert.equal(dayInZone(ms, 0), "2026-10-09");
  assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});

test("linhas de gasto: uma por anuncio com nomes, diferenca da campanha vira linha da campanha", () => {
  const rows = buildSpendRows("2026-10-08", {
    campaign: [obj("campaign", { id: "c1", campaign_id: "c1", name: "Camp 1" }, 150), obj("campaign", { id: "c2", campaign_id: "c2", name: "Camp 2" }, 40)],
    adset: [obj("adset", { id: "s1", campaign_id: "c1", adset_id: "s1", name: "Conj 1" }, 150)],
    ad: [obj("ad", { id: "a1", campaign_id: "c1", adset_id: "s1", ad_id: "a1", name: "Ad 1" }, 100.004),
      obj("ad", { id: "a2", campaign_id: "c1", adset_id: "s1", ad_id: "a2", name: "Ad 2" }, 50),
      obj("ad", { id: "a3", campaign_id: "c1", adset_id: "s1", ad_id: "a3", name: "Parado" }, 0, 0)]
  });
  assert.equal(rows.length, 3, "anuncio sem gasto e sem impressao fica de fora");
  assert.deepEqual(rows[0], { spend_date: "2026-10-08", source: "utmify", campaign_id: "c1", campaign_name: "Camp 1", adset_id: "s1", adset_name: "Conj 1",
    ad_id: "a1", ad_name: "Ad 1", spend: 100, impressions: 100, clicks: 3 });
  assert.equal(rows[2].campaign_id, "c2"); assert.equal(rows[2].ad_id, null); assert.equal(rows[2].spend, 40);
  const total = rows.reduce((sum, row) => sum + row.spend, 0);
  assert.equal(Math.round(total * 100) / 100, 190, "total do dia bate com as campanhas");
});

test("sem token da UTMify ou com Meta direta ligada, nao busca nada", async () => {
  let calls = 0;
  const feed = startUtmifySpendFeed({ pool: { query: async () => { calls++; return { rows: [] }; } }, env: {}, callTool: async () => { calls++; } });
  assert.equal((await feed.run()).skipped, "UTMify não configurada");
  const meta = startUtmifySpendFeed({ pool: {}, env: { UTMIFY_MCP_TOKEN: "x", META_ACCESS_TOKEN: "t", META_AD_ACCOUNT_ID: "a" }, callTool: async () => { calls++; } });
  assert.equal((await meta.run()).skipped, "integração direta da Meta ativa");
  assert.equal(calls, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMcpUrl,
  normalizeDashboard,
  normalizeMetaObject,
  performanceRow,
  toMcpDateRange,
  validateSyncRange
} = require("./utmifyMcp");

test("monta URL MCP com token e resources sem alterar endpoint base", () => {
  const url = new URL(buildMcpUrl({
    endpoint: "https://mcp.utmify.com.br/mcp/",
    token: "temporary-test-token",
    resources: "gs,gm"
  }));

  assert.equal(url.origin + url.pathname, "https://mcp.utmify.com.br/mcp/");
  assert.equal(url.searchParams.get("token"), "temporary-test-token");
  assert.equal(url.searchParams.get("resources"), "gs,gm");
});

test("valida periodo de sincronizacao de ate 31 dias", () => {
  const range = validateSyncRange("2026-09-01", "2026-09-30");
  assert.equal(range.days, 30);
  assert.equal(range.from, "2026-09-01");
  assert.equal(range.to, "2026-09-30");
});

test("rejeita periodo maior que 31 dias", () => {
  assert.throws(
    () => validateSyncRange("2026-08-01", "2026-09-30"),
    /31 dias/
  );
});

test("monta dateRange MCP respeitando timezone do dashboard", () => {
  assert.deepEqual(
    toMcpDateRange("2026-09-01", "2026-09-30", -3),
    {
      from: "2026-09-01T00:00:00-03:00",
      to: "2026-09-30T23:59:59-03:00"
    }
  );
});

test("normaliza dashboard e mantem apenas contas Meta habilitadas", () => {
  const dashboard = normalizeDashboard({
    id: "dash-1",
    name: "Principal",
    timeZone: -3,
    currency: "BRL",
    metaProfiles: [{
      id: "profile-1",
      name: "Perfil",
      adAccounts: [
        { id: "a1", name: "Ativa", enabled: true },
        { id: "a2", name: "Desativada", enabled: false }
      ]
    }]
  });

  assert.equal(dashboard.id, "dash-1");
  assert.equal(dashboard.time_zone, -3);
  assert.equal(dashboard.meta_accounts.length, 1);
  assert.equal(dashboard.meta_accounts[0].id, "a1");
});

test("normaliza objeto de anuncio UTMify", () => {
  const item = normalizeMetaObject({
    id: "ad-1",
    profileId: "profile-1",
    accountId: "account-1",
    campaignId: "campaign-1",
    adsetId: "adset-1",
    adId: "ad-1",
    name: "Criativo A",
    effectiveStatus: "ACTIVE",
    ca: "Conta A",
    spend: 665,
    impressions: 923,
    inlineLinkClicks: 310,
    landingPageViews: 289,
    initiateCheckout: 12,
    leads: 18,
    approvedOrdersCount: 4,
    revenue: 1188,
    profit: 523,
    cpa: 166.25,
    roas: 1.786
  }, "ad");

  assert.equal(item.object_id, "ad-1");
  assert.equal(item.metrics.spend, 6.65);
  assert.equal(item.metrics.media_clicks, 310);
  assert.equal(item.metrics.landing_page_views, 289);
  assert.equal(item.metrics.purchases, 4);
  assert.equal(item.metrics.revenue, 11.88);
});

test("performance usa nomes parentais e metricas do MCP", () => {
  const object = normalizeMetaObject({
    id: "ad-1",
    campaignId: "campaign-1",
    adsetId: "adset-1",
    adId: "ad-1",
    name: "Anuncio 01",
    spend: 300,
    inlineLinkClicks: 120,
    landingPageViews: 100,
    impressions: 2000,
    leads: 20,
    initiateCheckout: 10,
    approvedOrdersCount: 3,
    revenue: 891
  }, "ad");

  const row = performanceRow(object, {
    campaign: new Map([["campaign-1", "Campanha A"]]),
    adset: new Map([["adset-1", "Conjunto A"]])
  });

  assert.equal(row.campaign, "Campanha A");
  assert.equal(row.adset, "Conjunto A");
  assert.equal(row.ad, "Anuncio 01");
  assert.equal(row.clicks, 100);
  assert.equal(row.media_clicks, 120);
  assert.equal(row.purchases, 3);
  assert.equal(row.spend, 3);
  assert.equal(row.revenue, 8.91);
  assert.equal(row.cpa, 1);
  assert.equal(row.roas, 2.97);
});

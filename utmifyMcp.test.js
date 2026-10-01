const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEconomicsSummary,
  buildMcpUrl,
  internalPerformanceFields,
  mergePerformanceAttribution,
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


test("economia combina aquisicao UTMify com monetizacao interna sem duplicar receita", () => {
  const summary = buildEconomicsSummary(
    {
      spend: 29000,
      purchases: 100,
      revenue: 29700
    },
    {
      front_purchases: 96,
      front_revenue: 28512,
      mentorship_purchases: 10,
      mentorship_revenue: 50000,
      bump_revenue: 0,
      refunds: 1000,
      net_revenue: 77512,
      ltv_per_front_buyer: 807.42,
      mentorship_attach_rate_pct: 10.42
    }
  );

  assert.equal(summary.spend, 29000);
  assert.equal(summary.utmify_purchases, 100);
  assert.equal(summary.utmify_front_revenue, 29700);
  assert.equal(summary.utmify_cpa, 290);
  assert.equal(summary.utmify_front_roas, 29700 / 29000);
  assert.equal(summary.mentorship_revenue, 50000);
  assert.equal(summary.tracked_net_revenue, 77512);
  assert.equal(summary.tracked_total_roas, 77512 / 29000);
  assert.equal(summary.purchase_tracking_coverage_pct, 96);
  assert.equal(
    summary.revenue_tracking_coverage_pct,
    (28512 / 29700) * 100
  );
  assert.equal(summary.downstream_revenue, 49000);
});

test("economia retorna null para ratios sem denominador", () => {
  const summary = buildEconomicsSummary(
    { spend: 0, purchases: 0, revenue: 0 },
    {
      front_purchases: 0,
      front_revenue: 0,
      mentorship_purchases: 0,
      mentorship_revenue: 0,
      bump_revenue: 0,
      refunds: 0,
      net_revenue: 0
    }
  );

  assert.equal(summary.utmify_cpa, null);
  assert.equal(summary.utmify_front_roas, null);
  assert.equal(summary.tracked_total_roas, null);
  assert.equal(summary.purchase_tracking_coverage_pct, null);
  assert.equal(summary.revenue_tracking_coverage_pct, null);
});


test("atribui receita de mentoria e LTV ao mesmo anuncio por ID", () => {
  const mediaRows = [{
    campaign: "Campanha A",
    campaign_id: "c1",
    adset: "Conjunto A",
    adset_id: "s1",
    ad: "Anuncio A",
    ad_id: "a1",
    clicks: 100,
    media_clicks: 120,
    impressions: 2000,
    leads: 20,
    checkouts: 10,
    purchases: 2,
    revenue: 594,
    spend: 300,
    cpl: 15,
    cpa: 150,
    roas: 1.98,
    source: "utmify"
  }];

  const internalRows = [{
    object_id: "a1",
    campaign_id: "c1",
    adset_id: "s1",
    ad_id: "a1",
    campaign_name: "Campanha A",
    tracked_front_buyers: 2,
    tracked_front_revenue: 594,
    calls_booked: 2,
    calls_attended: 2,
    mentorship_purchases: 1,
    mentorship_revenue: 5000,
    bump_revenue: 0,
    refunds: 0
  }];

  const result = mergePerformanceAttribution(
    mediaRows,
    internalRows,
    "ad",
    {
      total_front_buyers: 2,
      total_front_revenue: 594,
      id_attributed_front_buyers: 2,
      id_attributed_front_revenue: 594
    }
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mentorship_purchases, 1);
  assert.equal(result.rows[0].mentorship_revenue, 5000);
  assert.equal(result.rows[0].tracked_net_revenue, 5594);
  assert.equal(result.rows[0].ltv_per_front_buyer, 2797);
  assert.equal(result.rows[0].tracked_total_roas, 5594 / 300);
  assert.equal(result.rows[0].purchase_tracking_coverage_pct, 100);
  assert.equal(result.rows[0].attribution_status, "matched");
  assert.equal(result.attribution.id_coverage_pct, 100);
  assert.equal(result.attribution.utmify_match_coverage_pct, 100);
});

test("nao força buyer interno para objeto UTMify com ID diferente", () => {
  const mediaRows = [{
    campaign: "Campanha UTMify",
    campaign_id: "c-real",
    adset: "Conjunto UTMify",
    adset_id: "s-real",
    ad: "Anuncio UTMify",
    ad_id: "a-real",
    clicks: 10,
    media_clicks: 12,
    impressions: 200,
    leads: 1,
    checkouts: 1,
    purchases: 1,
    revenue: 297,
    spend: 200,
    cpl: 200,
    cpa: 200,
    roas: 1.485,
    source: "utmify"
  }];

  const internalRows = [{
    object_id: "a-outro",
    campaign_id: "c-outro",
    adset_id: "s-outro",
    ad_id: "a-outro",
    campaign_name: "Campanha interna",
    tracked_front_buyers: 1,
    tracked_front_revenue: 297,
    calls_booked: 1,
    calls_attended: 1,
    mentorship_purchases: 1,
    mentorship_revenue: 10000,
    bump_revenue: 0,
    refunds: 0
  }];

  const result = mergePerformanceAttribution(
    mediaRows,
    internalRows,
    "ad",
    {
      total_front_buyers: 1,
      total_front_revenue: 297,
      id_attributed_front_buyers: 1,
      id_attributed_front_revenue: 297
    }
  );

  assert.equal(result.rows.length, 2);

  const media = result.rows.find((row) => row.ad_id === "a-real");
  const internal = result.rows.find((row) => row.ad_id === "a-outro");

  assert.equal(media.mentorship_revenue, 0);
  assert.equal(media.attribution_status, "media_only");
  assert.equal(internal.mentorship_revenue, 10000);
  assert.equal(internal.attribution_status, "internal_only");
  assert.equal(result.attribution.id_coverage_pct, 100);
  assert.equal(result.attribution.utmify_match_coverage_pct, 0);
});

test("calcula campos internos de valor real sem mídia", () => {
  const fields = internalPerformanceFields({
    tracked_front_buyers: 2,
    tracked_front_revenue: 594,
    mentorship_purchases: 1,
    mentorship_revenue: 5000,
    bump_revenue: 100,
    refunds: 200
  }, {
    spend: 0,
    purchases: 0,
    revenue: 0
  });

  assert.equal(fields.tracked_net_revenue, 5494);
  assert.equal(fields.downstream_revenue, 4900);
  assert.equal(fields.ltv_per_front_buyer, 2747);
  assert.equal(fields.mentorship_attach_rate_pct, 50);
  assert.equal(fields.tracked_total_roas, null);
});

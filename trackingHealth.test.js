const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildHealthReport,
  coverageState,
  differencePercent,
  divergenceState,
  safePercent,
  validateHealthRange
} = require("./trackingHealth");

test("safePercent retorna null sem denominador", () => {
  assert.equal(safePercent(10, 0), null);
  assert.equal(safePercent(0, 0), null);
  assert.equal(safePercent(95, 100), 95);
});

test("coverageState classifica cobertura", () => {
  assert.equal(coverageState(99), "good");
  assert.equal(coverageState(90), "warn");
  assert.equal(coverageState(60), "critical");
  assert.equal(coverageState(null), "neutral");
});

test("divergenceState classifica divergencia absoluta", () => {
  assert.equal(divergenceState(4), "good");
  assert.equal(divergenceState(-10), "warn");
  assert.equal(divergenceState(25), "critical");
});

test("differencePercent usa UTMify como base externa", () => {
  assert.equal(differencePercent(90, 100), -10);
  assert.equal(differencePercent(110, 100), 10);
  assert.equal(differencePercent(10, 0), null);
});

test("valida periodo de tracking health em ate 90 dias", () => {
  const range = validateHealthRange("2026-09-01", "2026-10-01");
  assert.equal(range.days, 31);

  assert.throws(
    () => validateHealthRange("2026-01-01", "2026-10-01"),
    /90 dias/
  );
});

test("relatorio identifica falta de click_id e ad_id", () => {
  const report = buildHealthReport({
    clicks_total: 100,
    clicks_with_campaign_id: 95,
    clicks_with_adset_id: 90,
    clicks_with_ad_id: 75,
    leads_total: 50,
    leads_with_click_id: 48,
    leads_with_source: 47,
    leads_orphan_click_id: 0,
    buyers_total: 10,
    buyers_with_click_id: 8,
    buyers_with_resolved_click: 8,
    buyers_with_campaign_id: 8,
    buyers_with_adset_id: 8,
    buyers_with_ad_id: 7,
    events_total: 40,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 2970
  });

  assert.equal(report.status, "critical");
  assert.equal(report.buyers.total, 10);

  const codes = report.issues.map((item) => item.code);
  assert.ok(codes.includes("buyer_missing_click_id"));
  assert.ok(codes.includes("buyer_missing_ad_id"));
  assert.ok(codes.includes("utmify_snapshot_missing"));
});

test("relatorio separa cobertura interna de match UTMify", () => {
  const report = buildHealthReport({
    clicks_total: 100,
    clicks_with_campaign_id: 100,
    clicks_with_adset_id: 100,
    clicks_with_ad_id: 100,
    leads_total: 50,
    leads_with_click_id: 50,
    leads_with_source: 50,
    leads_orphan_click_id: 0,
    buyers_total: 10,
    buyers_with_click_id: 10,
    buyers_with_resolved_click: 10,
    buyers_with_campaign_id: 10,
    buyers_with_adset_id: 10,
    buyers_with_ad_id: 10,
    buyers_campaign_match: 10,
    buyers_adset_match: 9,
    buyers_ad_match: 7,
    events_total: 40,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 2970,
    utmify_sync_id: 123,
    utmify_spend: 2500,
    utmify_purchases: 10,
    utmify_revenue: 2970
  });

  const internalAd = report.metrics.find(
    (item) => item.id === "buyer_ad_id"
  );
  const matchAd = report.metrics.find(
    (item) => item.id === "utmify_ad_match"
  );

  assert.equal(internalAd.pct, 100);
  assert.equal(internalAd.state, "good");
  assert.equal(matchAd.pct, 70);
  assert.equal(matchAd.state, "critical");
  assert.ok(
    report.issues.some((item) => item.code === "utmify_ad_match_low")
  );
});

test("relatorio marca divergencia de vendas e receita", () => {
  const report = buildHealthReport({
    clicks_total: 100,
    clicks_with_campaign_id: 100,
    clicks_with_adset_id: 100,
    clicks_with_ad_id: 100,
    leads_total: 50,
    leads_with_click_id: 50,
    leads_with_source: 50,
    leads_orphan_click_id: 0,
    buyers_total: 8,
    buyers_with_click_id: 8,
    buyers_with_resolved_click: 8,
    buyers_with_campaign_id: 8,
    buyers_with_adset_id: 8,
    buyers_with_ad_id: 8,
    buyers_campaign_match: 8,
    buyers_adset_match: 8,
    buyers_ad_match: 8,
    events_total: 30,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 2376,
    utmify_sync_id: 10,
    utmify_purchases: 10,
    utmify_revenue: 2970
  });

  assert.equal(report.discrepancies.purchase_difference_pct, -20);
  assert.equal(report.discrepancies.purchase_state, "critical");
  assert.equal(report.discrepancies.revenue_state, "critical");
  assert.ok(
    report.issues.some((item) => item.code === "purchase_divergence")
  );
  assert.ok(
    report.issues.some((item) => item.code === "revenue_divergence")
  );
});

test("relatorio saudavel fica good sem issues", () => {
  const report = buildHealthReport({
    clicks_total: 100,
    clicks_with_campaign_id: 100,
    clicks_with_adset_id: 100,
    clicks_with_ad_id: 100,
    leads_total: 50,
    leads_with_click_id: 50,
    leads_with_source: 50,
    leads_orphan_click_id: 0,
    buyers_total: 10,
    buyers_with_click_id: 10,
    buyers_with_resolved_click: 10,
    buyers_with_campaign_id: 10,
    buyers_with_adset_id: 10,
    buyers_with_ad_id: 10,
    buyers_campaign_match: 10,
    buyers_adset_match: 10,
    buyers_ad_match: 10,
    events_total: 40,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 2970,
    utmify_sync_id: 5,
    utmify_purchases: 10,
    utmify_revenue: 2970
  });

  assert.equal(report.status, "good");
  assert.deepEqual(report.issues, []);
});


test("snapshot UTMify zerado com compras internas vira divergencia critica", () => {
  const report = buildHealthReport({
    clicks_total: 10,
    clicks_with_campaign_id: 10,
    clicks_with_adset_id: 10,
    clicks_with_ad_id: 10,
    leads_total: 5,
    leads_with_click_id: 5,
    leads_with_source: 5,
    leads_orphan_click_id: 0,
    buyers_total: 2,
    buyers_with_click_id: 2,
    buyers_with_resolved_click: 2,
    buyers_with_campaign_id: 2,
    buyers_with_adset_id: 2,
    buyers_with_ad_id: 2,
    buyers_campaign_match: 0,
    buyers_adset_match: 0,
    buyers_ad_match: 0,
    events_total: 8,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 594,
    utmify_sync_id: 99,
    utmify_purchases: 0,
    utmify_revenue: 0
  });

  assert.equal(report.status, "critical");
  assert.ok(
    report.issues.some((item) => item.code === "utmify_zero_purchases")
  );
  assert.ok(
    report.issues.some((item) => item.code === "utmify_zero_revenue")
  );
});


test("cobertura Meta usa somente a coorte elegivel e match usa somente IDs capturados", () => {
  const report = buildHealthReport({
    clicks_total: 100,
    clicks_meta_eligible: 20,
    clicks_with_campaign_id: 20,
    clicks_with_adset_id: 19,
    clicks_with_ad_id: 18,
    leads_total: 40,
    leads_with_click_id: 40,
    leads_with_source: 40,
    leads_orphan_click_id: 0,
    buyers_total: 10,
    buyers_meta_eligible: 5,
    buyers_with_click_id: 10,
    buyers_with_resolved_click: 10,
    buyers_with_campaign_id: 5,
    buyers_with_adset_id: 5,
    buyers_with_ad_id: 4,
    buyers_campaign_match: 5,
    buyers_adset_match: 5,
    buyers_ad_match: 3,
    events_total: 30,
    events_orphan_click_id: 0,
    repeated_purchase_clicks: 0,
    internal_front_revenue: 2970,
    internal_meta_front_revenue: 1485,
    utmify_sync_id: 20,
    utmify_purchases: 5,
    utmify_revenue: 1485
  });

  const clickAd = report.metrics.find((item) => item.id === "click_ad_id");
  const buyerAd = report.metrics.find((item) => item.id === "buyer_ad_id");
  const matchAd = report.metrics.find((item) => item.id === "utmify_ad_match");

  assert.equal(clickAd.denominator, 20);
  assert.equal(clickAd.pct, 90);
  assert.equal(buyerAd.denominator, 5);
  assert.equal(buyerAd.pct, 80);
  assert.equal(matchAd.denominator, 4);
  assert.equal(matchAd.pct, 75);
  assert.equal(report.internal.purchases, 5);
  assert.equal(report.internal.purchases_total, 10);
  assert.equal(report.internal.revenue, 1485);
});

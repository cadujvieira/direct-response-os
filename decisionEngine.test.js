const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SETTINGS, normalizeSettings, evaluateScope } = require("./cpaEngine");
const { RULES, buildDecisions, registerDecisionRoutes } = require("./decisionEngine");
const now = new Date("2026-10-01T18:00:00Z");
const settings = normalizeSettings({ ...DEFAULT_SETTINGS, costs_confirmed: true });
const health = { status: "good", utmify: { available: true } };
function sample(overrides = {}) {
  return { total_buyers: 100, mature_buyers: 100, total_front_revenue: 27000,
    front_revenue: 27000, mentorship_revenue: 52000, mentorship_buyers: 10,
    mentorship_transactions: 10, max_buyer_mentorship_revenue: 5200,
    bump_revenue: 1500, bump_transactions: 10, refunds: 3000, ...overrides };
}
function scope(input = {}, media = {}, config = settings, h = health) {
  return { object_id: "a", campaign: "Campanha A", adset: "Conjunto A", ad: "Criativo A",
    ...evaluateScope(sample(input), { spend: 23800, purchases: 100, revenue: 27000, matched: true, ...media }, h, config) };
}
function report(rows = [scope()], summary = scope(), extras = {}) {
  return { range: { from: "2026-08-01", to: "2026-08-31", days: 31, level: "ad" },
    revision: 2, settings, summary, rows, tracking_status: "good",
    sync: { available: true, sync_id: 7 }, unassigned_buyers: 0, ...extras };
}
const kinds = result => result.cards.map(card => card.kind);
test("escala usa limite prudente proprio com folga de pelo menos 20%", () => {
  const result = buildDecisions(report(), now);
  assert.deepEqual(kinds(result), ["scale_opportunity"]);
  assert.equal(result.counts.eligible_scopes, 1);
  assert.equal(result.cards[0].metrics.find(m => m.key === "cpa_max").value, 542.5);
  assert.equal(result.cards[0].reference, "scope");
  assert.ok(result.cards[0].metrics.find(m => m.key === "prudent_headroom_pct").value > 50);
  assert.equal(result.cards[0].metrics.find(m => m.key === "mature_revenue_roas").value, 77500 / 23800);
});
test("CPA dentro do prudente mas com pouca folga nao gera gatilho de escala", () => {
  assert.deepEqual(kinds(buildDecisions(report([scope({}, { spend: 45000 })]), now)), []);
  assert.deepEqual(kinds(buildDecisions(report([scope({}, { spend: 48825 })]), now)), []);
});
test("limites distinguem atencao e risco critico sem chamar objetivo de prejuizo", () => {
  assert.deepEqual(kinds(buildDecisions(report([scope({}, { spend: 51000 })]), now)), ["near_limit"]);
  const result = buildDecisions(report([scope({}, { spend: 60000 })]), now);
  assert.equal(result.cards[0].kind, "above_limit");
  assert.equal(result.cards[0].severity, "critical");
  assert.ok(result.cards[0].detail.includes("objetivo"));
});
test("contribuicao negativa tem prioridade e nunca gera alto LTV ou escala", () => {
  const config = normalizeSettings({ ...settings, front_variable_cost: 1000 });
  const row = scope({}, {}, config);
  const result = buildDecisions(report([row], row, { settings: config }), now);
  assert.deepEqual(kinds(result), ["negative_contribution"]);
  assert.equal(result.cards[0].severity, "critical");
});
test("criativo de alto LTV compara media ponderada da mesma coorte", () => {
  const high = scope({ mentorship_revenue: 160000, max_buyer_mentorship_revenue: 16000 });
  const result = buildDecisions(report([high]), now);
  assert.ok(kinds(result).includes("high_ltv"));
  assert.equal(result.cards.find(card => card.kind === "high_ltv").metrics.find(m => m.key === "ltv_multiple").value, 1855 / 775);
  assert.equal(result.cards.find(card => card.kind === "high_ltv").reference, "overall_comparison");
});
test("mentoria isolada ou concentrada nao gera alto LTV nem escala", () => {
  for (const input of [{ mentorship_buyers: 1 }, { max_buyer_mentorship_revenue: 40000 }]) {
    const result = buildDecisions(report([scope(input)]), now);
    assert.deepEqual(kinds(result), ["scope_pending"]);
  }
});
test("front barato com baixo LTV e baixa conversao nao vira vencedor de escala automaticamente", () => {
  const low = scope({ mentorship_revenue: 0, mentorship_buyers: 0, mentorship_transactions: 0,
    max_buyer_mentorship_revenue: 0, bump_revenue: 0, bump_transactions: 0, refunds: 0 }, { spend: 18000 });
  const result = buildDecisions(report([low]), now);
  assert.deepEqual(kinds(result), ["front_false_winner", "near_limit"]);
  assert.ok(result.cards[0].criteria.some(text => text.includes("não implica prejuízo")));
});
test("front barato com conversao de mentoria normal nao gera falso vencedor", () => {
  const low = scope({ mentorship_revenue: 15000, max_buyer_mentorship_revenue: 1500 }, { spend: 18000 });
  assert.ok(!kinds(buildDecisions(report([low]), now)).includes("front_false_winner"));
});
function emptyScope(spend = 759.5, extra = {}) {
  return scope({ total_buyers: 0, mature_buyers: 0, total_front_revenue: 0, front_revenue: 0,
    mentorship_revenue: 0, mentorship_buyers: 0, mentorship_transactions: 0,
    max_buyer_mentorship_revenue: 0, bump_revenue: 0, bump_transactions: 0, refunds: 0 },
    { spend, purchases: 0, revenue: 0, ...extra });
}
test("gasto sem compra exige 1,4x limite geral validado e informa referencia emprestada", () => {
  const result = buildDecisions(report([emptyScope()]), now);
  assert.deepEqual(kinds(result), ["spend_without_purchase"]);
  const card = result.cards[0];
  assert.equal(card.reference, "overall");
  assert.equal(card.metrics.find(m => m.key === "reference_cpa").value, 542.5);
  assert.ok(Math.abs(card.metrics.find(m => m.key === "spend_multiple").value - 1.4) < 1e-12);
  assert.equal(card.severity, "attention");
});
test("gasto abaixo do limiar, sem objeto, divergente ou com compra nao gera revisao de corte", () => {
  for (const row of [emptyScope(700), emptyScope(1000, { matched: false }),
    emptyScope(1000, { revenue: 1 }), emptyScope(1000, { purchases: 1 })]) {
    assert.ok(!kinds(buildDecisions(report([row]), now)).includes("spend_without_purchase"));
  }
});
test("periodo em aberto, futuro ou com menos de tres dias nao gera revisao de gasto sem compra", () => {
  for (const range of [{ from: "2026-09-29", to: "2026-10-01", days: 3, level: "ad" },
    { from: "2026-10-02", to: "2026-10-04", days: 3, level: "ad" },
    { from: "2026-08-01", to: "2026-08-02", days: 2, level: "ad" }]) {
    assert.ok(!kinds(buildDecisions(report([emptyScope()], scope(), { range }), now)).includes("spend_without_purchase"));
  }
});
test("fechamento de periodo usa dia de Sao Paulo, inclusive na virada UTC", () => {
  const range = { from: "2026-09-28", to: "2026-09-30", days: 3, level: "ad" };
  assert.ok(!kinds(buildDecisions(report([emptyScope()], scope(), { range }), new Date("2026-10-01T01:00:00Z"))).includes("spend_without_purchase"));
  assert.ok(kinds(buildDecisions(report([emptyScope()], scope(), { range }), new Date("2026-10-01T04:00:00Z"))).includes("spend_without_purchase"));
});
test("custos, tracking, snapshot e moeda bloqueiam decisoes de midia mesmo com row aparentemente apta", () => {
  for (const reason of ["costs_unconfirmed", "tracking_unreliable", "stale_snapshot", "snapshot_missing", "currency_mismatch"]) {
    const summary = { ...scope(), recommendation_eligible: false, reasons: [{ code: reason, message: "Pendência" }] };
    const result = buildDecisions(report([scope(), { ...emptyScope(), object_id: "zero" }], summary), now);
    assert.deepEqual(kinds(result), ["readiness"]);
    assert.equal(result.counts.eligible_scopes, 0);
    assert.equal(result.reference.eligible, false);
  }
});
test("referencia provisoria nao impede escala com criterio proprio mas impede comparacoes gerais", () => {
  const summary = scope({ max_buyer_mentorship_revenue: 40000 });
  const high = scope({ mentorship_revenue: 160000, max_buyer_mentorship_revenue: 16000 });
  const result = buildDecisions(report([high, { ...emptyScope(), object_id: "zero" }], summary), now);
  assert.ok(kinds(result).includes("scale_opportunity"));
  assert.ok(!kinds(result).includes("high_ltv"));
  assert.ok(!kinds(result).includes("spend_without_purchase"));
  assert.ok(kinds(result).includes("readiness"));
});
test("cenario manual alto nunca muda os diagnosticos observados", () => {
  const original = buildDecisions(report(), now);
  const result = buildDecisions(report(undefined, undefined, { scenario: { cpa_max: 999999 },
    settings: { ...settings, scenario_mentorship_ticket: 1000000 } }), now);
  assert.deepEqual(result.cards, original.cards);
});
test("escopo imaturo nao tem ROAS projetado e o maduro usa apenas receita madura", () => {
  const row = scope({ total_buyers: 120, total_front_revenue: 32400 }, { purchases: 120, revenue: 32400 });
  const result = buildDecisions(report([row]), now);
  const card = result.cards.find(card => card.kind === "scale_opportunity");
  assert.equal(card.metrics.find(m => m.key === "mature_revenue_roas").value, 77500 / 23800);
  const immature = scope({ mature_buyers: 0 });
  assert.deepEqual(kinds(buildDecisions(report([immature]), now)), ["scope_pending"]);
});
test("IDs e nomes identicos em niveis diferentes continuam escopos distintos", () => {
  const ad = buildDecisions(report(), now).cards[0];
  const campaign = buildDecisions(report(undefined, undefined, { range: { from: "2026-08-01", to: "2026-08-31", days: 31, level: "campaign" } }), now).cards[0];
  assert.notEqual(ad.id, campaign.id);
  assert.equal(campaign.scope.name, "Campanha A");
});
test("priorizacao e limite preservam contagem total e nao retornam infinitos", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ ...scope(), object_id: String(i) }));
  rows.push({ ...scope({}, { spend: 60000 }), object_id: "risk" });
  const result = buildDecisions(report(rows), now);
  assert.equal(result.cards.length, RULES.max_cards);
  assert.equal(result.counts.total, 121);
  assert.equal(result.counts.opportunity, 120);
  assert.equal(result.cards[0].kind, "above_limit");
  assert.deepEqual(result, buildDecisions(report(rows.slice().reverse()), now));
  assert.ok(!JSON.stringify(result).includes("Infinity"));
});
test("compradores sem ID permanecem visiveis e nao sao inventados por nome", () => {
  const result = buildDecisions(report([], scope(), { unassigned_buyers: 5 }), now);
  assert.deepEqual(kinds(result), ["unassigned"]);
  assert.equal(result.cards[0].scope, null);
});
test("rotas exigem segredo antes de consultar dados e ocultam erros internos", async () => {
  const routes = new Map(), previous = process.env.DR_ADMIN_SECRET;
  process.env.DR_ADMIN_SECRET = "decision-test-secret";
  registerDecisionRoutes({ get: (path, handler) => routes.set(path, handler) },
    { query: async () => { throw new Error("provider-token-private"); } });
  try {
    let status, body, header;
    const res = { status: code => { status = code; return res; }, json: value => { body = value; }, set: (name, value) => { header = [name, value]; } };
    await routes.get("/api/decisions")({ get: () => "", query: {} }, res);
    assert.equal(status, 401);
    assert.equal(header, undefined);
    await routes.get("/api/decisions")({ get: () => "decision-test-secret", query: { from: "2026-08-01", to: "2026-08-31" } }, res);
    assert.equal(status, 500);
    assert.equal(body.error, "erro interno");
    assert.deepEqual(header, ["Cache-Control", "no-store"]);
    await routes.get("/api/decisions")({ get: () => "decision-test-secret", query: { from: "2026-02-30", to: "2026-03-02" } }, res);
    assert.equal(status, 400);
  } finally { if (previous == null) delete process.env.DR_ADMIN_SECRET; else process.env.DR_ADMIN_SECRET = previous; }
});

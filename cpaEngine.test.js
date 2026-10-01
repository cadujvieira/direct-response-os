const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SETTINGS, normalizeSettings, validateRange, calculateUnitEconomics,
  scenarioEconomics, evaluateScope, saveSettings, registerCpaRoutes } = require("./cpaEngine");
const config = overrides => normalizeSettings({ ...DEFAULT_SETTINGS, costs_confirmed: true, ...overrides });
const sample = overrides => ({ total_buyers:100, mature_buyers:100, total_front_revenue:27000,
  front_revenue:27000, mentorship_revenue:52000, mentorship_buyers:10, mentorship_transactions:10,
  max_buyer_mentorship_revenue:5200, bump_revenue:1500, bump_transactions:10, refunds:3000, ...overrides });
const media = overrides => ({ spend:23800, purchases:100, revenue:27000, matched:true, ...overrides });
const health = { status:"good", utmify:{ available:true } };

test("CPA esperado de 775 com reserva de 30% e limite prudente", () => {
  const result = calculateUnitEconomics(sample(), config());
  assert.equal(result.contribution_per_buyer,775);
  assert.equal(result.cpa_max,542.5);
  assert.equal(result.prudent_cpa_max,488.25);
  assert.equal(result.mentorship_per_buyer,520);
});
test("ROI sobre midia e reserva da contribuicao usam denominadores diferentes", () => {
  const result = calculateUnitEconomics(sample(), config({target_mode:"media_roi"}));
  assert.equal(result.cpa_max,596.15);
  assert.notEqual(result.cpa_max,542.5);
});
test("taxas, transacoes, imposto, split e entrega reduzem contribuicao", () => {
  const result = calculateUnitEconomics(sample(), config({fee_pct:10, fixed_fee:1, tax_pct:5,
    split_pct:20, front_variable_cost:10, mentorship_variable_cost:100}));
  // 775 - 80.5 - 1.2 - 38.75 - 155 - 10 - 10 = 479.55.
  assert.equal(result.contribution_per_buyer,479.55);
  assert.equal(result.cpa_max,335.69);
});
test("refunds maiores que receita mantem perda e CPA maximo zero", () => {
  const result = calculateUnitEconomics(sample({refunds:90000}),config({tax_pct:10,split_pct:10}));
  assert.equal(result.net_revenue_per_buyer,-95);
  assert.equal(result.taxes_per_buyer,0);
  assert.equal(result.split_per_buyer,0);
  assert.equal(result.cpa_max,0);
});
test("sem compradores maduros nao inventa LTV nem CPA maximo", () => {
  assert.equal(calculateUnitEconomics(sample({mature_buyers:0}),config()),null);
  const report=evaluateScope(sample({mature_buyers:0}),media(),health,config());
  assert.equal(report.status,"insufficient_history");
  assert.equal(report.headroom,null);
  assert.equal(report.recommendation_eligible,false);
});
test("cenario calcula conversao por todos os compradores front sem soma duplicada", () => {
  const result=scenarioEconomics(config({scenario_front_ticket:270, scenario_mentorship_rate_pct:10,
    scenario_mentorship_ticket:5200, scenario_bump_per_buyer:15, scenario_refund_per_buyer:30}));
  assert.equal(result.contribution_per_buyer,775);
  assert.equal(result.cpa_max,542.5);
});
test("escala exige tracking, custos confirmados, conciliacao e amostra", () => {
  const result=evaluateScope(sample(),media(),health,config());
  assert.equal(result.status,"scalable");
  assert.equal(result.headroom,304.5);
  assert.equal(result.recommendation_eligible,true);
  for (const bad of [
    evaluateScope(sample(),media(),{...health,status:"critical"},config()),
    evaluateScope(sample(),media(),{...health,status:"warn"},config()),
    evaluateScope(sample(),media(),health,config({costs_confirmed:false})),
    evaluateScope(sample({mature_buyers:20}),media(),health,config()),
    evaluateScope(sample(),media({purchases:50}),health,config()),
    evaluateScope(sample(),media({revenue:10000}),health,config()),
    evaluateScope(sample(),media({matched:false}),health,config())
  ]) { assert.equal(bad.recommendation_eligible,false); assert.equal(bad.status,"provisional"); }
});
test("recomendacao distingue folga prudente, perto do limite e acima", () => {
  assert.equal(evaluateScope(sample(),media({spend:51000}),health,config()).status,"near_limit");
  assert.equal(evaluateScope(sample(),media({spend:60000}),health,config()).status,"above_limit");
});
test("comprador de mentoria isolado nao pode validar escala", () => {
  const result=evaluateScope(sample({mentorship_buyers:1,max_buyer_mentorship_revenue:52000}),media(),health,config());
  assert.equal(result.status,"provisional");
  assert.ok(result.reasons.some(r=>r.code==="mentorship_concentration"));
});
test("moedas distintas nao sao somadas como BRL", () => {
  const internal=evaluateScope(sample({non_brl_events:1}),media(),health,config());
  assert.equal(internal.economics,null);
  assert.equal(internal.recommendation_eligible,false);
  const external=evaluateScope(sample(),media(),{...health,media_currency_valid:false},config());
  assert.equal(external.economics,null);
  assert.equal(external.current_cpa,null);
});
test("snapshot desatualizado nao libera escala em periodo aberto", () => {
  const result=evaluateScope(sample(),media(),{...health,snapshot_fresh:false},config());
  assert.equal(result.recommendation_eligible,false);
  assert.ok(result.reasons.some(r=>r.code==="stale_snapshot"));
});
test("coorte majoritariamente imatura nao libera escala mesmo com amostra minima", () => {
  const result=evaluateScope(sample({mature_buyers:50}),media(),health,config());
  assert.equal(result.recommendation_eligible,false);
  assert.ok(result.reasons.some(r=>r.code==="maturity_low"));
});
test("sem snapshot e sem compras CPA atual fica indisponivel", () => {
  const result=evaluateScope(sample(),{}, {status:"good",utmify:{available:false}},config());
  assert.equal(result.current_cpa,null);
  assert.equal(result.status,"provisional");
  assert.ok(result.reasons.some(r=>r.code==="snapshot_missing"));
});
test("parametros rejeitam campos desconhecidos, tipos, objetivos e amostra insegura", () => {
  for (const bad of [{min_buyers:1},{target_pct:100},{split_pct:101},{fee_pct:"5"},
    {costs_confirmed:"true"},{maturity_days:2.5},{target_mode:"x"},{toString:123},{credential:"x"}]) {
    assert.throws(()=>normalizeSettings(bad));
  }
  assert.equal(DEFAULT_SETTINGS.costs_confirmed,false);
});
test("periodo rejeita datas normalizadas silenciosamente, arrays e mais de 31 dias", () => {
  assert.equal(validateRange({from:"2026-09-01",to:"2026-10-01"}).days,31);
  for(const input of [{from:"2026-02-30",to:"2026-03-02"},{from:["2026-09-01"],to:"2026-09-02"},
    {from:"2026-09-01",to:"2026-10-02"},{from:"2026-10-02",to:"2026-10-01"},
    {from:"2026-10-01",to:"2026-10-01",level:"unknown"}]) assert.throws(()=>validateRange(input));
});
test("edicao economica concorrente retorna 409 e nunca perde revisao", async () => {
  let values;
  await assert.rejects(saveSettings({query:async(sql,args)=>{values=args;return {rows:[]};}},
    {expected_revision:3,settings:config()}), error=>error.statusCode===409);
  assert.equal(values[1],3);
});
test("rotas do motor exigem segredo e nao consultam banco sem autenticar", async () => {
  const routes=new Map(), previous=process.env.DR_ADMIN_SECRET;
  process.env.DR_ADMIN_SECRET="cpa-test-secret";
  registerCpaRoutes({get:(path,handler)=>routes.set("GET "+path,handler),
    put:(path,handler)=>routes.set("PUT "+path,handler)},
    {query:async()=>assert.fail("consulta nao autorizada")});
  try {
    for(const path of ["GET /api/cpa-max", "GET /api/cpa-max/settings", "PUT /api/cpa-max/settings"]) {
      let status;
      await routes.get(path)({get:()=>""},{status:code=>({json:()=>{status=code;}})});
      assert.equal(status,401);
    }
  } finally { if(previous==null) delete process.env.DR_ADMIN_SECRET; else process.env.DR_ADMIN_SECRET=previous; }
});

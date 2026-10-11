const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCheckoutReport, campaignName } = require("./hublaCheckoutReport");

const config = { kinds: new Map([["prod-front", "front"]]), conflicts: new Set(), clickParam: "click_id" };
let seq = 0;
function notice(id, { status, method = "pix", version = 1, product = "prod-front", name = "IA Lendária", history, params, utm, cents = 29700,
  type = "invoice.status_updated", at = "2026-10-10T12:00:00Z", payer = "payer-" + id } = {}) {
  return { id: ++seq, received_at: at, payload: { type, event: {
    products: [{ id: product, name, offers: [] }],
    invoice: { id, status, version, payerId: payer, paymentMethod: method, createdAt: at, amount: { totalCents: cents },
      statusAt: (history || [status]).map(s => ({ status: s, when: at })),
      paymentSession: { utm: utm || {}, params: params || {}, url: "https://pay.hub.la/x?nome=privado&email=a@b.c" },
      payer: { firstName: "Privado", email: "privado@exemplo.com", phone: "+5511999999999" } } } } };
}

test("cada fatura vira um resultado: pago, Pix/boleto sem pagamento, cartao nao aprovado", () => {
  const rows = [
    notice("aaaaaaaa-1", { status: "unpaid", history: ["unpaid"], utm: { source: "FB", campaign: "[CV 07]|120251609204850561" }, params: { click_id: "dr_x" } }),
    notice("aaaaaaaa-1", { status: "paid", version: 2, history: ["unpaid", "paid"], utm: { source: "FB", campaign: "[CV 07]|120251609204850561" }, params: { click_id: "dr_x" } }),
    notice("bbbbbbbb-2", { status: "unpaid", history: ["unpaid"] }),
    notice("bbbbbbbb-2", { status: "canceled", version: 3, history: ["unpaid", "canceled"] }),
    notice("cccccccc-3", { status: "overdue", method: "credit_card", history: ["unpaid", "overdue"], utm: { source: "FB", campaign: "[CV 03]|120251609204150561" } }),
    notice("dddddddd-4", { status: "unpaid", method: "bank_slip" }),
    notice("eeeeeeee-5", { status: "paid", product: "outro-produto", name: "Outro curso", history: ["paid"] }),
    { id: ++seq, received_at: "2026-10-10T13:00:00Z", payload: { type: "lead.abandoned_checkout", event: { lead: { id: "lead-1" } } } },
    { id: ++seq, received_at: "2026-10-10T13:05:00Z", payload: { type: "lead.abandoned_checkout", event: { lead: { id: "lead-1" } } } }
  ];
  const report = buildCheckoutReport(rows, config);
  assert.equal(report.summary.invoices, 5);
  assert.equal(report.summary.front_invoices, 4);
  assert.equal(report.summary.other_product_invoices, 1, "venda de outro produto aparece separada");
  assert.equal(report.summary.people, 4);
  assert.equal(report.summary.paid, 1);
  assert.equal(report.summary.paid_value, 297);
  assert.deepEqual(report.summary.by_outcome, { "Pago": 1, "Pix gerado e não pago": 1, "Cartão não aprovado": 1, "Boleto gerado e não pago": 1 });
  assert.equal(report.summary.abandoned_checkouts, 1, "carrinho abandonado conta uma vez por lead");
  const cv07 = report.campaigns.find(c => c.campaign === "[CV 07]");
  assert.deepEqual([cv07.people, cv07.paid, cv07.paid_value, cv07.from_ads], [1, 1, 297, true]);
  assert(report.campaigns.some(c => c.campaign === "Sem UTM no checkout"));
  const paid = report.invoices.find(i => i.invoice === "aaaaaaaa");
  assert.equal(paid.has_click_id, true);
  assert.equal(paid.outcome, "pago");
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /privado|@|5511999|payer-|_person/i, "sem dados pessoais, id do comprador ou URL do checkout");
});

test("mesma pessoa: parcelado gera duas faturas por tentativa e tres tentativas viram uma linha", () => {
  const card = (id, cents, status, at) => notice(id, { status, method: "credit_card", cents, at, payer: "comprador-x",
    history: ["unpaid", status], utm: { source: "FB", campaign: "[CV 10]|120251609204770561" }, params: { click_id: "dr_y" } });
  const rows = [
    card("t1-total", 36864, "overdue", "2026-10-11T04:22:05Z"), card("t1-parc", 3072, "canceled", "2026-10-11T04:22:06Z"),
    card("t2-total", 36864, "overdue", "2026-10-11T04:24:10Z"), card("t2-parc", 3072, "canceled", "2026-10-11T04:24:11Z"),
    card("t3-total", 36864, "overdue", "2026-10-11T04:26:30Z"), card("t3-parc", 3072, "canceled", "2026-10-11T04:26:31Z"),
    notice("pix-outra", { status: "unpaid", payer: "comprador-z", at: "2026-10-10T19:56:00Z" })
  ];
  const report = buildCheckoutReport(rows, config);
  assert.equal(report.summary.invoices, 7);
  assert.equal(report.summary.people, 2);
  assert.equal(report.summary.attempts, 4);
  const x = report.people.find(p => p.campaign === "[CV 10]");
  assert.deepEqual([x.attempts, x.outcome, x.amount, x.payment_methods.join(), x.invoices.length], [3, "cartao_nao_aprovado", 368.64, "Cartão", 6]);
  assert.deepEqual(report.summary.by_outcome, { "Cartão não aprovado": 1, "Pix gerado e não pago": 1 });
  assert.deepEqual(report.campaigns.find(c => c.campaign === "[CV 10]").people, 1);
});

test("pessoa que tentou cartao e depois pagou no Pix conta como paga uma vez", () => {
  const rows = [
    notice("c1", { status: "overdue", method: "credit_card", payer: "p1", history: ["unpaid", "overdue"], at: "2026-10-10T10:00:00Z" }),
    notice("c2", { status: "paid", method: "pix", payer: "p1", history: ["unpaid", "paid"], at: "2026-10-10T10:20:00Z" })
  ];
  const report = buildCheckoutReport(rows, config);
  assert.equal(report.summary.people, 1);
  assert.equal(report.summary.paid, 1);
  assert.equal(report.people[0].attempts, 2);
  assert.equal(report.people[0].amount, 297);
  assert.deepEqual(report.people[0].payment_methods, ["Cartão", "Pix"]);
});

test("aviso antigo chegando depois nao desfaz o pagamento", () => {
  const rows = [
    notice("ffffffff-6", { status: "paid", version: 5, history: ["unpaid", "paid"], at: "2026-10-10T10:00:00Z" }),
    notice("ffffffff-6", { status: "unpaid", version: 1, history: ["unpaid"], at: "2026-10-10T11:00:00Z" })
  ];
  const report = buildCheckoutReport(rows, config);
  assert.equal(report.invoices.length, 1);
  assert.equal(report.invoices[0].outcome, "pago");
  assert.equal(report.invoices[0].status, "paid");
});

test("nome da campanha sem o sufixo do id", () => {
  assert.equal(campaignName("[CBO] [CV 07]|120251609204850561"), "[CBO] [CV 07]");
  assert.equal(campaignName("Campanha|sem id"), "Campanha|sem id");
  assert.equal(campaignName(null), null);
});

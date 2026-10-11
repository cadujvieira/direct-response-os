const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCheckoutReport, campaignName } = require("./hublaCheckoutReport");

const config = { kinds: new Map([["prod-front", "front"]]), conflicts: new Set(), clickParam: "click_id" };
let seq = 0;
function notice(id, { status, method = "pix", version = 1, product = "prod-front", name = "IA Lendária", history, params, utm, cents = 29700,
  type = "invoice.status_updated", at = "2026-10-10T12:00:00Z" } = {}) {
  return { id: ++seq, received_at: at, payload: { type, event: {
    products: [{ id: product, name, offers: [] }],
    invoice: { id, status, version, paymentMethod: method, createdAt: at, amount: { totalCents: cents },
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
  assert.equal(report.summary.paid, 1);
  assert.equal(report.summary.paid_value, 297);
  assert.deepEqual(report.summary.by_outcome, { "Pago": 1, "Pix gerado e não pago": 1, "Cartão não aprovado": 1, "Boleto gerado e não pago": 1 });
  assert.equal(report.summary.abandoned_checkouts, 1, "carrinho abandonado conta uma vez por lead");
  const cv07 = report.campaigns.find(c => c.campaign === "[CV 07]");
  assert.deepEqual([cv07.invoices, cv07.paid, cv07.paid_value, cv07.from_ads], [1, 1, 297, true]);
  assert(report.campaigns.some(c => c.campaign === "Sem UTM no checkout"));
  const paid = report.invoices.find(i => i.invoice === "aaaaaaaa");
  assert.equal(paid.has_click_id, true);
  assert.equal(paid.outcome, "pago");
  const json = JSON.stringify(report);
  assert.doesNotMatch(json, /privado|@|5511999/i, "sem dados pessoais nem URL do checkout");
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

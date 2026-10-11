// Homologacao local do relatorio de checkouts da Hubla. Avisos SINTETICOS entram pela rota real do webhook
// (token de homologacao) em PostgreSQL/aplicacao de loopback; nada aqui toca a Hubla ou a producao.
const assert = require("node:assert/strict");
const { Pool } = require("pg");

async function main() {
  const dbUrl = new URL(process.env.DR_VALIDATION_DATABASE_URL || "invalid:");
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
  assert.equal(dbUrl.pathname, "/oferta_validation");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const secret = process.env.DR_VALIDATION_ADMIN_SECRET, token = process.env.DR_VALIDATION_HUBLA_TOKEN;
  const pool = new Pool({ connectionString: dbUrl.href, ssl: false });
  const http = async (path, { body, headers = {}, status = 200 } = {}) => {
    const r = await fetch(new URL(path, base), { method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, status, path);
    return r.json();
  };
  let n = 0;
  const send = (id, status, { method = "pix", version = 1, history, campaign, product = "qa-front-product", sandbox = false } = {}) => {
    const at = new Date().toISOString();
    return http("/api/integrations/hubla/webhook", { headers: { "x-hubla-token": token, "x-hubla-idempotency": "qa-report-" + (++n),
      ...(sandbox ? { "x-hubla-sandbox": "true" } : {}) }, body: { type: "invoice.status_updated", version: "2.0.0", event: {
      products: [{ id: product, name: product === "qa-front-product" ? "IA Lendária" : "Outro curso", offers: [] }],
      invoice: { id, status, version, type: "sell", currency: "BRL", paymentMethod: method, createdAt: at,
        amount: { totalCents: 29700 }, statusAt: (history || [status]).map(s => ({ status: s, when: at })),
        paymentSession: { utm: campaign ? { source: "FB", campaign } : {}, params: {} },
        payer: { firstName: "Pessoa", email: "pessoa@exemplo.com" } } } } });
  };
  try {
    await http("/api/integrations/hubla/checkout-report", { status: 401 });
    await send("qa-inv-pix", "unpaid");
    await send("qa-inv-pix", "canceled", { version: 2, history: ["unpaid", "canceled"] });
    await send("qa-inv-card", "overdue", { method: "credit_card", history: ["unpaid", "overdue"], campaign: "[CV 03]|120251609204150561" });
    await send("qa-inv-paid", "paid", { history: ["unpaid", "paid"], campaign: "[CV 07]|120251609204850561" });
    await send("qa-inv-outro", "paid", { product: "produto-de-outra-oferta", history: ["paid"] });
    await send("qa-inv-sandbox", "paid", { sandbox: true, history: ["paid"] });
    const admin = { "x-admin-secret": secret };
    const report = await http("/api/integrations/hubla/checkout-report", { headers: admin });
    assert.equal(report.summary.invoices, 4, "aviso de sandbox fica de fora");
    assert.equal(report.summary.front_invoices, 3);
    assert.equal(report.summary.other_product_invoices, 1);
    assert.equal(report.summary.paid, 1);
    assert.deepEqual(report.summary.by_outcome, { "Pago": 1, "Pix gerado e não pago": 1, "Cartão não aprovado": 1 });
    assert.deepEqual(report.campaigns.map(c => [c.campaign, c.invoices, c.paid]).sort(),
      [["Sem UTM no checkout", 1, 0], ["[CV 03]", 1, 0], ["[CV 07]", 1, 1]]);
    assert(report.webhook_first_notice_at);
    assert.doesNotMatch(JSON.stringify(report), /pessoa|@/i, "sem dados pessoais");
    console.log("PASS relatorio de checkouts: pago, Pix nao pago, cartao nao aprovado, outro produto e campanhas");
    const old = await http("/api/integrations/hubla/checkout-report?from=2020-01-01&to=2020-01-02", { headers: admin });
    assert.equal(old.summary.invoices, 0);
    await http("/api/integrations/hubla/checkout-report?from=2020-13-01", { headers: admin, status: 400 });
    console.log("PASS periodo vazio e periodo invalido");
    const stored = await pool.query("SELECT COUNT(*)::int AS n FROM dr_hubla_events");
    assert.equal(stored.rows[0].n, 6, "relatorio e somente leitura");
    console.log("PASS relatorio nao altera o inbox");
  } finally { await pool.end(); }
}
main().catch(error => { console.error("FAIL", error); process.exit(1); });

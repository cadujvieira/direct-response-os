// Homologacao local: reembolso confirmado pela Hubla tira a venda e o valor dos totais do painel
// (resumo, serie diaria e campanhas). Avisos SINTETICOS pela rota real do webhook, em banco de loopback.
const assert = require("node:assert/strict");
const crypto = require("crypto");

async function main() {
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const token = process.env.DR_VALIDATION_HUBLA_TOKEN;
  const http = async (path, { body, headers = {}, status = 200 } = {}) => {
    const r = await fetch(new URL(path, base), { method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, status, path);
    return r.json();
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const run = crypto.randomUUID().slice(0, 8), campaign = "QA reembolso " + run;
  const summary = async () => (await http("/api/summary?from=" + today + "&to=" + today)).summary;
  const series = async () => (await http("/api/overview/timeseries?from=" + today + "&to=" + today)).points[0];
  const camp = async () => (await http("/api/campaigns?from=" + today + "&to=" + today)).campaigns.find(c => c.campaign === campaign);
  let n = 0;
  const notice = (id, type, status, history, value = 29700) => http("/api/integrations/hubla/webhook", {
    headers: { "x-hubla-token": token, "x-hubla-idempotency": "qa-refund-" + run + "-" + (++n) },
    body: { type, version: "2.0.0", event: { products: [{ id: "qa-front-product", name: "IA Lendária", offers: [] }],
      invoice: { id, status, version: n, type: "sell", currency: "BRL", paymentMethod: "pix", createdAt: history[0].when,
        amount: { totalCents: value }, statusAt: history,
        paymentSession: { utm: { source: "FB", campaign }, params: { click_id: "dr_" + crypto.randomUUID() } },
        payer: { id: "payer-" + run + id, firstName: "Pessoa", email: "p." + run + id + "@exemplo.com", phone: "+5511988887777" } } } } });
  const waitFor = async (check, what) => {
    for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 500)); }
    throw new Error("tempo esgotado: " + what);
  };

  const s0 = await summary(), t0 = await series();
  const paidAt = new Date(Date.now() - 3600e3).toISOString(), refundAt = new Date(Date.now() - 600e3).toISOString();
  const paidHist = [{ status: "unpaid", when: paidAt }, { status: "paid", when: paidAt }];
  await notice("qa-ref-a-" + run, "invoice.status_updated", "paid", paidHist);
  await notice("qa-ref-b-" + run, "invoice.status_updated", "paid", paidHist);
  await waitFor(async () => (await summary()).purchases_gross === s0.purchases_gross + 2, "duas vendas");
  const s1 = await summary();
  assert.equal(s1.purchases, s0.purchases + 2);
  assert.equal(Number(s1.revenue), Number(s0.revenue) + 594);
  assert.equal((await camp()).purchases, 2);

  // reembolso total da venda A: aviso de status + confirmacao invoice.refunded
  const refHist = [...paidHist, { status: "refunded", when: refundAt }];
  await notice("qa-ref-a-" + run, "invoice.status_updated", "refunded", refHist);
  await notice("qa-ref-a-" + run, "invoice.refunded", "refunded", refHist);
  await waitFor(async () => (await summary()).refunded_purchases === s0.refunded_purchases + 1, "reembolso aplicado");
  const s2 = await summary(), t2 = await series(), c2 = await camp();
  assert.equal(s2.purchases_gross, s0.purchases_gross + 2, "bruto continua com as duas");
  assert.equal(s2.purchases, s0.purchases + 1, "liquido tira a reembolsada");
  assert.equal(Number(s2.refunds), Number(s0.refunds) + 297);
  assert.equal(Number(s2.revenue), Number(s0.revenue) + 297);
  assert.equal(Number(s2.revenue_gross), Number(s0.revenue_gross) + 594);
  assert.equal(t2.purchases, t0.purchases + 1);
  assert.equal(Number(t2.revenue), Number(t0.revenue) + 297);
  assert.equal(c2.purchases, 1);
  assert.equal(Number(c2.revenue), 297);
  console.log("PASS reembolso: resumo, serie diaria e campanha ficam liquidos (venda e valor), bruto preservado");
}
main().catch(error => { console.error(error); process.exit(1); });

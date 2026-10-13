// Homologacao local: faturas da Hubla viram "checkout iniciado" no painel (uma vez por clique / por comprador sem
// clique), sem mexer na contagem de vendas. Avisos SINTETICOS pela rota real do webhook, em banco de loopback.
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
  const run = crypto.randomUUID().slice(0, 8), campaign = "QA checkout " + run;
  const summary = async () => (await http("/api/summary?from=" + today + "&to=" + today)).summary;
  const camp = async () => (await http("/api/campaigns?from=" + today + "&to=" + today)).campaigns.find(c => c.campaign === campaign);
  let n = 0;
  const notice = ({ id, status, payer, click, product = "qa-front-product", method = "pix", minutesAgo = 30 }) => {
    const when = new Date(Date.now() - minutesAgo * 60e3).toISOString();
    const hist = [{ status: "unpaid", when }].concat(status === "paid" ? [{ status: "paid", when }] : status === "overdue" ? [{ status: "overdue", when }] : []);
    return http("/api/integrations/hubla/webhook", { headers: { "x-hubla-token": token, "x-hubla-idempotency": "qa-ck-" + run + "-" + (++n) },
      body: { type: "invoice.status_updated", version: "2.0.0", event: { products: [{ id: product, name: "IA Lendária", offers: [] }],
        invoice: { id: id + "-" + run, status, version: 1, type: "sell", currency: "BRL", paymentMethod: method, createdAt: when,
          payerId: payer + "-" + run, amount: { totalCents: 29700 }, statusAt: hist,
          paymentSession: { utm: { source: "FB", campaign }, params: click ? { click_id: click } : {} },
          payer: { id: payer + "-" + run, firstName: "Pessoa", email: payer + "." + run + "@exemplo.com", phone: "+5511977776666" } } } } });
  };
  const waitFor = async (check, what) => {
    for (let i = 0; i < 60; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 500)); }
    throw new Error("tempo esgotado: " + what);
  };
  const s0 = await summary();
  const clickA = "dr_" + crypto.randomUUID(), clickC = "dr_" + crypto.randomUUID();
  // A: Pix gerado e nao pago, duas faturas do mesmo clique (parcelamento inteligente)
  await notice({ id: "a1", status: "unpaid", payer: "pa", click: clickA });
  await notice({ id: "a2", status: "unpaid", payer: "pa", click: clickA });
  // B: cartao recusado sem codigo do clique, duas tentativas
  await notice({ id: "b1", status: "overdue", payer: "pb", method: "credit_card" });
  await notice({ id: "b2", status: "overdue", payer: "pb", method: "credit_card", minutesAgo: 20 });
  // C: comprou
  await notice({ id: "c1", status: "paid", payer: "pc", click: clickC });
  // D: outro produto (nao conta)
  await notice({ id: "d1", status: "unpaid", payer: "pd", click: "dr_" + crypto.randomUUID(), product: "produto-de-outra-oferta" });
  await waitFor(async () => (await summary()).checkouts >= s0.checkouts + 3 && (await summary()).purchases >= s0.purchases + 1, "checkouts");
  await new Promise(r => setTimeout(r, 3000));
  const s1 = await summary(), c1 = await camp();
  assert.equal(s1.checkouts, s0.checkouts + 3, "um checkout por pessoa: A (2 faturas, 1 clique), B (sem clique, 2 tentativas) e C");
  assert.equal(s1.purchases, s0.purchases + 1, "vendas nao mudam: so C pagou");
  assert.equal(c1.checkouts, 3, "A, B e C pela campanha do checkout (B usa as UTMs da propria sessao do checkout)");
  assert.equal(c1.purchases, 1);
  console.log("PASS checkout: faturas da Hubla viram checkout iniciado, uma vez por clique/comprador; vendas intactas; outro produto fora");
}
main().catch(error => { console.error(error); process.exit(1); });

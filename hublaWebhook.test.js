const test = require("node:test");
const assert = require("node:assert/strict");
const { ENDPOINT, hublaConfig, tokenMatches, isSandbox, looksLikeTest, sanitizePayload, idempotencyKey, envelope,
  interpretInvoice, clickFromSession, processHublaEvent, registerHublaRoutes, REFUND_GRACE_MS } = require("./hublaWebhook");
const { normalizeFunnelEvent } = require("./funnelIntegration");

const config = hublaConfig({ HUBLA_WEBHOOK_TOKEN: "t", HUBLA_FRONT_PRODUCT_IDS: "prod-front, offer-front",
  HUBLA_MENTORSHIP_PRODUCT_IDS: "prod-mentor" });
// Formato publicado em hubla.gitbook.io/docs/webhooks/eventos/fatura (payload 2.0.0).
function notice(overrides = {}, type = "invoice.status_updated") {
  const invoice = { id: "7614b1bb-1d1a-43ba-890c-50d74216eb56", orderId: "a1b2", parentInvoiceId: null, childInvoiceIds: [],
    payerId: "payer-1", sellerId: "seller-1",
    payer: { id: "payer-1", firstName: "John", lastName: "Doe", document: "12345678900", email: "John@Example.com", phone: "+5511999999999" },
    installments: 1, paymentMethod: "pix", currency: "BRL", type: "sell", status: "paid",
    statusAt: [{ when: "2026-09-28T20:35:22.671Z", status: "unpaid" }, { when: "2026-09-28T20:35:33.512Z", status: "paid" }],
    amount: { subtotalCents: 29700, subtotal: 297, discountCents: 0, discount: 0, prorataCents: 0, prorata: 0,
      installmentFeeCents: 0, installmentFee: 0, totalCents: 29700, total: 297 },
    receivers: [{ id: "platform", name: "Hubla", email: "x@hub.la", phone: "+55", role: "platform", paysForFees: false, totalCents: 2970, currency: "BRL" },
      { id: "seller-1", name: "Seller", email: "s@example.com", phone: "+55", role: "seller", paysForFees: true, totalCents: 26730, currency: "BRL" }],
    paymentSession: { ip: "220.172.165.140", userAgent: "Mozilla", url: "https://pay.hub.la/offer-front?click_id=dr_abc",
      utm: { source: "meta" }, cookies: { fbclid: "fb" }, params: { click_id: "dr_abc", sck: "x" } },
    billingAddress: { city: "Sao Paulo", postalCode: "01310-200" },
    saleDate: "2026-09-28T20:35:22.671Z", version: 8, ...overrides };
  return { type, version: "2.0.0", event: { product: { id: "prod-front", name: "Oferta" },
    products: [{ id: "prod-front", name: "Oferta", offers: [{ id: "offer-front", name: "Principal" }] }], invoice,
    user: { id: "payer-1", document: "12345678900", email: "john@example.com" } } };
}
const sale = (overrides, type) => interpretInvoice(notice(overrides, type), config);

test("token so e aceito quando configurado e identico", () => {
  assert.equal(tokenMatches("segredo", "segredo"), true);
  assert.equal(tokenMatches("segredo", " segredo "), true);
  for (const received of ["", undefined, "segredo2", "SEGREDO"]) assert.equal(tokenMatches("segredo", received), false);
  assert.equal(tokenMatches("", ""), false);
});
test("configuracao vem apenas do ambiente e detecta ID repetido entre tipos", () => {
  assert.equal(hublaConfig({}).token, "");
  assert.equal(hublaConfig({}).clickParam, "click_id");
  assert.equal(hublaConfig({ HUBLA_CLICK_ID_PARAM: "bad param!" }).clickParam, "click_id");
  const both = hublaConfig({ HUBLA_FRONT_PRODUCT_IDS: "a", HUBLA_MENTORSHIP_PRODUCT_IDS: "a" });
  assert.equal(both.conflicts.has("a"), true);
  const body = notice(); body.event.product.id = "a"; body.event.products = [{ id: "a", offers: [] }];
  assert.equal(interpretInvoice(body, both).outcome, "unmapped_product");
});
test("sandbox e identificado pelo cabecalho e nunca divide chave com aviso real", () => {
  for (const value of ["true", "TRUE", "1"]) assert.equal(isSandbox(value), true);
  for (const value of ["false", "FALSE", "", undefined, "0"]) assert.equal(isSandbox(value), false);
  assert.notEqual(idempotencyKey("abc", {}, true), idempotencyKey("abc", {}, false));
  assert.equal(idempotencyKey("abc", { a: 1 }, false), idempotencyKey("abc", { a: 2 }, false));
  assert.equal(idempotencyKey(undefined, { a: 1 }, false), idempotencyKey("", { a: 1 }, false));
  assert.notEqual(idempotencyKey(undefined, { a: 1 }, false), idempotencyKey(undefined, { a: 2 }, false));
});
test("payload persistido remove documento, endereco, IP, user agent e contatos de recebedores", () => {
  const stored = JSON.stringify(sanitizePayload(notice()));
  for (const secret of ["12345678900", "220.172.165.140", "Mozilla", "01310-200", "x@hub.la", "s@example.com"]) assert.equal(stored.includes(secret), false, secret);
  assert.deepEqual(sanitizePayload({ CPF: "1", cnpj: "2", user_agent: "3", ip_address: "4", billing_address: { a: 1 }, address: "5", keep: "6" }), { keep: "6" });
  const parsed = JSON.parse(stored);
  assert.equal(parsed.event.invoice.paymentSession.params.click_id, "dr_abc");
  assert.equal(parsed.event.invoice.receivers[1].totalCents, 26730);
  assert.equal(interpretInvoice(parsed, config).sale.value, 297);
});
test("envelope extrai fatura, versao, comprador e IDs de produto e oferta", () => {
  assert.deepEqual(envelope(notice()), { event_type: "invoice.status_updated", payload_version: "2.0.0",
    invoice_id: "7614b1bb-1d1a-43ba-890c-50d74216eb56", invoice_status: "paid", invoice_version: 8,
    payer_id: "payer-1", product_ids: ["prod-front", "offer-front"] });
  assert.equal(envelope({ type: "subscription.created" }).invoice_id, null);
});
test("compra front paga vira pedido com prefixo, valor em reais e horario real do pagamento", () => {
  const result = sale();
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.sale.session, { utm_source: "meta", utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
    campaign_id: undefined, adset_id: undefined, ad_id: undefined, fbclid: "fb", gclid: null, started_at: "2026-09-28T20:35:22.671Z" });
  delete result.sale.session;
  assert.deepEqual({ ...result.sale, repaid_after_reversal: undefined, click_problem: undefined }, { kind: "front",
    invoice_id: "7614b1bb-1d1a-43ba-890c-50d74216eb56", order_id: "hubla:7614b1bb-1d1a-43ba-890c-50d74216eb56", status: "paid",
    value: 297, charged_total: 297, seller_net: 267.3, paid_at: "2026-09-28T20:35:33.512Z", refunded_at: null, chargeback_at: null,
    repaid_after_reversal: undefined, click_id: "dr_abc", click_problem: undefined, email: "john@example.com",
    telefone: "5511999999999", nome: "John Doe", produto: "Oferta", payer_id: "payer-1" });
  assert.equal(normalizeFunnelEvent({ event_name: "purchase", order_id: result.sale.order_id, click_id: result.sale.click_id,
    email: result.sale.email, value: result.sale.value, currency: "BRL", payment_status: "approved",
    occurred_at: result.sale.paid_at }, new Date("2026-10-01T00:00:00Z")).value, 297);
});
test("juros de parcelamento do comprador nao entram como receita e centavos nao sao convertidos duas vezes", () => {
  const amount = { subtotalCents: 120000, subtotal: 1200, discountCents: 24000, discount: 240, installmentFeeCents: 16320,
    installmentFee: 163.2, totalCents: 112320, total: 1123.2 };
  assert.equal(sale({ amount, installments: 12, paymentMethod: "credit_card" }).sale.value, 960);
  assert.equal(sale({ amount: { ...amount, total: 112320 } }).code, "amount_units");
  const legacy = { ...amount }; delete legacy.total;
  assert.equal(sale({ amount: legacy }).sale.value, 960);
  for (const bad of [{ totalCents: 297.5 }, { totalCents: "29700" }, { totalCents: 0 }, {}]) assert.equal(sale({ amount: bad }).code, "amount");
});
test("faturas nunca pagas nao geram receita", () => {
  for (const status of ["unpaid", "overdue", "canceled"]) {
    const result = sale({ status, statusAt: [{ when: "2026-09-28T20:35:22.671Z", status: "unpaid" }] });
    assert.equal(result.outcome, "ignored"); assert.equal(result.code, "never_paid");
  }
});
test("fatura paga ou revertida sem historico legivel vai para revisao, nunca e ignorada", () => {
  for (const status of ["paid", "refunded", "chargeback", "disputed", "novo_status"]) {
    for (const statusAt of [undefined, [], [{ status: "paid", when: 1727555733 }], [{ status: "paid", when: "ontem" }]]) {
      const result = sale({ status, statusAt });
      assert.equal(result.outcome, "needs_review", status); assert.equal(result.code, "missing_paid_history");
    }
  }
  assert.equal(sale({ status: "unpaid", statusAt: [] }, "invoice.refunded").outcome, "needs_review");
  assert.equal(sale({ status: "paid" }, "invoice.refunded").code, "refund_status_mismatch");
});
test("somente a trilha financeira e a confirmacao de reembolso total sao interpretadas", () => {
  for (const type of ["invoice.payment_succeeded", "invoice.created", "invoice.expired", "invoice.payment_failed",
    "refund_request.created", "refund_request.accepted", "smart_installment.created", "subscription.activated", "lead.abandoned_checkout"]) {
    assert.equal(sale({}, type).outcome, "ignored", type);
  }
  assert.equal(sale({ status: "refunded", statusAt: [{ when: "2026-09-28T20:35:33.512Z", status: "paid" },
    { when: "2026-09-28T21:35:33.512Z", status: "refunded" }] }, "invoice.refunded").outcome, "ok");
});
test("produto e reconhecido por ID de produto ou oferta, nunca por nome ou valor", () => {
  const unknown = notice(); unknown.event.product.id = "other"; unknown.event.products = [{ id: "other", name: "Oferta", offers: [{ id: "other-offer" }] }];
  assert.equal(interpretInvoice(unknown, config).outcome, "unmapped_product");
  const compat = notice(); compat.event.product.id = "offer-front"; compat.event.products = [{ id: "offer-front", name: "X", offers: [] }];
  assert.equal(interpretInvoice(compat, config).sale.kind, "front");
  const mentor = notice(); mentor.event.product.id = "prod-mentor"; mentor.event.products = [{ id: "prod-mentor", offers: [] }];
  assert.equal(interpretInvoice(mentor, config).sale.kind, "mentorship");
});
test("vendas ambiguas ficam em revisao em vez de serem contadas", () => {
  const multi = notice(); multi.event.products.push({ id: "prod-mentor", name: "Bump", offers: [] });
  assert.equal(interpretInvoice(multi, config).code, "multi_product");
  assert.equal(sale({ type: "renewal" }).code, "unsupported_invoice_type");
  assert.equal(sale({ parentInvoiceId: "parent" }).code, "child_invoice");
  assert.equal(sale({ smartInstallment: { installment: 2, installments: 12 } }).code, "installment_followup");
  assert.equal(sale({ smartInstallment: { installment: 1, installments: 12 } }).outcome, "ok");
  assert.equal(sale({ currency: "USD" }).code, "currency");
  assert.equal(sale({ amount: { totalCents: 29700, settlement: { totalCents: 5000, currency: "USD" } } }).code, "currency");
  assert.equal(sale({ id: null }).code, "invalid_invoice");
});
test("click_id vem somente do checkout: parametros ou URL, sem aceitar valores conflitantes", () => {
  const session = (params, url) => ({ paymentSession: { params, url } });
  assert.equal(clickFromSession(session({ CLICK_ID: "a" }), "click_id").click_id, "a");
  assert.equal(clickFromSession(session({}, "https://pay.hub.la/x?click_id=b&utm_source=meta"), "click_id").click_id, "b");
  assert.equal(clickFromSession(session({ click_id: "a", Click_Id: "b" }), "click_id").click_id, null);
  assert.equal(clickFromSession(session({ click_id: "x".repeat(201) }), "click_id").click_id, null);
  assert.equal(clickFromSession(session({ sck: "a", src: "b" }, "not a url"), "click_id").click_id, null);
  assert.equal(clickFromSession({}, "click_id").click_id, null);
  assert.equal(clickFromSession(session({ dr: "z" }), "dr").click_id, "z");
  const missing = sale({ paymentSession: { utm: { source: "meta", content: "dr_abc" } } });
  assert.equal(missing.outcome, "ok"); assert.equal(missing.sale.click_id, null);
});
test("historico de status fornece datas de pagamento, reembolso, chargeback e repagamento", () => {
  const history = [{ when: "2026-09-28T20:00:00.000Z", status: "unpaid" }, { when: "2026-09-28T20:01:00.000Z", status: "paid" },
    { when: "2026-09-29T10:00:00.000Z", status: "disputed" }];
  assert.equal(sale({ status: "disputed", statusAt: history }).sale.paid_at, "2026-09-28T20:01:00.000Z");
  const charged = sale({ status: "chargeback", statusAt: [...history, { when: "2026-09-30T10:00:00.000Z", status: "chargeback" }] }).sale;
  assert.equal(charged.chargeback_at, "2026-09-30T10:00:00.000Z"); assert.equal(charged.repaid_after_reversal, false);
  const won = sale({ status: "paid", statusAt: [...history, { when: "2026-09-30T10:00:00.000Z", status: "paid" }] }).sale;
  assert.equal(won.paid_at, "2026-09-28T20:01:00.000Z"); assert.equal(won.repaid_after_reversal, false);
  const repaid = sale({ status: "paid", statusAt: [...history, { when: "2026-09-30T10:00:00.000Z", status: "chargeback" },
    { when: "2026-10-01T10:00:00.000Z", status: "paid" }] }).sale;
  assert.equal(repaid.repaid_after_reversal, true);
});
test("aviso do sandbox e apenas lido: nenhuma consulta ou gravacao no funil", async () => {
  const pool = { query: async () => assert.fail("sandbox nao pode tocar o banco"), connect: async () => assert.fail("sem conexao") };
  const result = await processHublaEvent(pool, { sandbox: true, payload: notice(), event_type: "invoice.status_updated" }, config, {});
  assert.equal(result.status, "sandbox"); assert.match(result.reason, /front, R\$ 297\.00, com click_id/);
  const other = await processHublaEvent(pool, { sandbox: true, payload: { type: "subscription.created", event: {} } }, config, {});
  assert.equal(other.status, "sandbox");
});
test("avisos sem efeito financeiro e produtos sem mapeamento nao consultam o livro de pedidos", async () => {
  const pool = { query: async () => assert.fail("consulta inesperada") };
  assert.equal((await processHublaEvent(pool, { sandbox: false, payload: notice({}, "invoice.payment_succeeded") }, config, {})).status, "ignored");
  assert.equal((await processHublaEvent(pool, { sandbox: false, payload: notice() }, hublaConfig({}), {})).status, "unmapped_product");
});
test("compra front sem click_id fica pendente de atribuicao com valor preservado", async () => {
  const pool = { query: async sql => { assert.match(sql, /dr_funnel_orders/); return { rows: [] }; } };
  const result = await processHublaEvent(pool, { sandbox: false, event_type: "invoice.status_updated",
    payload: notice({ paymentSession: { params: {} } }) }, config, {});
  assert.equal(result.status, "pending_attribution"); assert.equal(result.code, "missing_click");
  assert.equal(result.amount, 297); assert.equal(result.kind, "front");
});
test("reembolso sem invoice.refunded aguarda confirmacao e depois exige revisao, sem descontar", async () => {
  const refunded = notice({ status: "refunded", statusAt: [{ when: "2026-09-28T20:35:33.512Z", status: "paid" },
    { when: "2026-09-28T21:47:53.177Z", status: "refunded" }] });
  const pool = { query: async sql => ({ rows: /dr_funnel_orders/.test(sql)
    ? [{ kind: "front", front_order_id: "x", refunded_value: "0", valor: "297", paid_at: new Date() }] : [] }),
    connect: async () => assert.fail("nenhum lancamento financeiro esperado") };
  const row = { sandbox: false, event_type: "invoice.status_updated", payload: refunded, received_at: new Date() };
  const waiting = await processHublaEvent(pool, row, config, {});
  assert.equal(waiting.status, "pending_refund_confirmation");
  const late = await processHublaEvent(pool, { ...row, received_at: new Date(Date.now() - REFUND_GRACE_MS - 1000) }, config, {});
  assert.equal(late.status, "needs_review"); assert.equal(late.code, "refund_unconfirmed");
});
test("disputa aberta e registrada sem desconto", async () => {
  const pool = { query: async () => ({ rows: [{ kind: "front", refunded_value: "0", valor: "297" }] }), connect: async () => assert.fail("sem lancamento") };
  const result = await processHublaEvent(pool, { sandbox: false, event_type: "invoice.status_updated", payload: notice({ status: "disputed",
    statusAt: [{ when: "2026-09-28T20:35:33.512Z", status: "paid" }, { when: "2026-09-29T20:35:33.512Z", status: "disputed" }] }) }, config, {});
  assert.equal(result.status, "processed"); assert.equal(result.code, "disputed");
});
test("contrato canonico aceita chargeback definitivo como reversao e continua rejeitando solicitacoes", () => {
  const base = { event_name: "refund", event_id: "hubla:inv:chargeback", order_id: "hubla:inv", value: 297, currency: "BRL",
    occurred_at: "2026-09-30T10:00:00.000Z" }, now = new Date("2026-10-01T00:00:00Z");
  assert.equal(normalizeFunnelEvent({ ...base, payment_status: "chargeback" }, now).payment_status, "chargeback");
  for (const status of ["disputed", "requested", "pending", undefined]) assert.throws(() => normalizeFunnelEvent({ ...base, payment_status: status }, now));
});
// Formato observado no teste oficial da conta em 05/10/2026 ("Integracao recomendada"), com dados pessoais trocados.
function accountTest(type, status, statusAt) {
  return { type, version: "2.0.0", event: { product: { id: "OFFER123", name: "Produto " },
    products: [{ id: "PRODUCT456", name: "Produto ", offers: [{ id: "OFFER123", name: "Produto ", cohorts: [{ id: "c1" }], amountCents: 29700, isOrderBump: false }] }],
    invoice: { id: "53a0a7ba-tester", orderId: "184c3bad-tester", childInvoiceIds: [], subscriptionId: "01cc-tester", payerId: "RE4g-tester",
      payer: { id: "RE4g-tester", firstName: "FULANO", lastName: "TESTE", email: "fulano@example.test", phone: "19999990000" },
      sellerId: "seller", installments: 1, paymentMethod: "credit_card", currency: "BRL", type: "sell", status, statusAt,
      paymentSession: { ip: "127.0.0.1", utm: { source: "facebook", medium: "ads" }, params: { src: "hubla-sandbox", sck: "teste-sandbox" } },
      amount: { subtotalCents: 29700, subtotal: 297, discountCents: 0, discount: 0, prorataCents: 0, prorata: 0, installmentFeeCents: 0, installmentFee: 0, totalCents: 29700, total: 297 },
      receivers: [{ id: "platform-identity", role: "platform", paysForFees: false, totalCents: 2347, currency: "BRL" },
        { id: "seller", role: "seller", paysForFees: true, totalCents: 27354, currency: "BRL" }], version: 1 },
    subscriptions: [{ id: "01cc-tester", type: "one_time", billingCycleMonths: 1, quantity: 1 }] } };
}
test("formato real da conta: produto e reconhecido pelo ID da oferta ou do produto e o teste nunca vira venda", async () => {
  const when = "2026-10-05T03:02:24.391Z";
  const refunded = accountTest("invoice.refunded", "refunded", [{ status: "unpaid", when }, { status: "refunded", when }]);
  // O teste oficial envia "reembolsada" sem etapa "paga": fica em revisao, nunca gera venda nem desconto.
  for (const env of [{ HUBLA_FRONT_PRODUCT_IDS: "OFFER123" }, { HUBLA_FRONT_PRODUCT_IDS: "PRODUCT456" }]) {
    assert.equal(interpretInvoice(refunded, hublaConfig(env)).code, "missing_paid_history");
    const paid = interpretInvoice(accountTest("invoice.status_updated", "paid", [{ status: "unpaid", when }, { status: "paid", when }]), hublaConfig(env));
    assert.equal(paid.outcome, "ok"); assert.equal(paid.sale.kind, "front"); assert.equal(paid.sale.value, 297);
    assert.equal(paid.sale.seller_net, 273.54); assert.equal(paid.sale.telefone, "19999990000"); assert.equal(paid.sale.click_id, null);
  }
  assert.deepEqual(envelope(refunded).product_ids, ["OFFER123", "PRODUCT456"]);
  assert.equal(looksLikeTest(refunded), true);
  assert.equal(looksLikeTest(notice()), false);
  assert.equal(looksLikeTest({ type: "x" }), false);
  // Mesmo que o cabecalho de sandbox falhe, o aviso "-tester" e gravado como teste.
  let stored;
  const pool = { query: async (sql, values) => { stored = values; return { rows: [{ id: 1 }] }; } };
  const { storeHublaEvent } = require("./hublaWebhook");
  assert.equal((await storeHublaEvent(pool, refunded, { idempotency: "k", sandbox: "FALSE" })).sandbox, true);
  assert.equal(stored[1], true); assert.match(stored[0], /^sandbox:/);
  assert.equal((await storeHublaEvent(pool, notice(), { idempotency: "k", sandbox: "FALSE" })).sandbox, false);
});
function routes(pool, runtime) {
  const map = new Map();
  registerHublaRoutes({ get: (path, fn) => map.set("GET " + path, fn), post: (path, fn) => map.set("POST " + path, fn) }, pool, {}, runtime);
  return map;
}
function call(handler, { headers = {}, body, params = {}, query = {} } = {}) {
  return new Promise(resolve => {
    const res = { set: () => res, status: code => ({ json: json => resolve({ status: code, json }) }), json: json => resolve({ status: 200, json }) };
    handler({ get: name => headers[name.toLowerCase()] || "", body, params, query }, res);
  });
}
test("receptor recusa sem token configurado, token invalido e corpo invalido antes de gravar", async () => {
  const previous = process.env.HUBLA_WEBHOOK_TOKEN;
  const handler = routes({ query: async () => assert.fail("gravacao indevida") }).get("POST " + ENDPOINT);
  try {
    delete process.env.HUBLA_WEBHOOK_TOKEN;
    assert.equal((await call(handler, { headers: { "x-hubla-token": "" }, body: notice() })).status, 503);
    process.env.HUBLA_WEBHOOK_TOKEN = "hubla-test-token";
    assert.equal((await call(handler, { body: notice() })).status, 401);
    assert.equal((await call(handler, { headers: { "x-hubla-token": "wrong" }, body: notice() })).status, 401);
    for (const body of [null, [], "text", {}, { type: 7 }]) {
      assert.equal((await call(handler, { headers: { "x-hubla-token": "hubla-test-token" }, body })).status, 400);
    }
  } finally { if (previous == null) delete process.env.HUBLA_WEBHOOK_TOKEN; else process.env.HUBLA_WEBHOOK_TOKEN = previous; }
});
test("ACK so depois de persistir; reenvio e reconhecido; falha de banco nao confirma recebimento", async () => {
  const previous = process.env.HUBLA_WEBHOOK_TOKEN; process.env.HUBLA_WEBHOOK_TOKEN = "hubla-test-token";
  const headers = { "x-hubla-token": "hubla-test-token", "x-hubla-idempotency": "idem-1", "x-hubla-sandbox": "FALSE" };
  try {
    const keys = new Map(), order = []; let kicks = 0;
    const pool = { query: async (sql, values) => {
      if (/^SELECT body_hash/.test(sql)) return { rows: [{ body_hash: keys.get(values[0]) }] };
      assert.match(sql, /INSERT INTO dr_hubla_events/); order.push("stored");
      assert.equal(values[1], false); assert.equal(JSON.stringify(values).includes("12345678900"), false);
      if (keys.has(values[0])) return { rows: [] };
      keys.set(values[0], values[10]); return { rows: [{ id: keys.size }] };
    } };
    const handler = routes(pool, { kick: () => { kicks++; order.push("kick"); } }).get("POST " + ENDPOINT);
    const first = await call(handler, { headers, body: notice() });
    assert.deepEqual(first, { status: 200, json: { ok: true, received: true, duplicate: false } });
    assert.deepEqual(order, ["stored", "kick"]);
    assert.equal((await call(handler, { headers, body: notice() })).json.duplicate, true);
    assert.equal(kicks, 1);
    // Mesma chave com conteudo diferente nao e reenvio: e guardado como aviso proprio, uma unica vez.
    const other = notice({ status: "refunded" }, "invoice.refunded");
    assert.equal((await call(handler, { headers, body: other })).json.duplicate, false);
    assert.equal((await call(handler, { headers, body: other })).json.duplicate, true);
    assert.equal(keys.size, 2); assert.equal(kicks, 2);
    const broken = routes({ query: async () => { throw Object.assign(new Error("db password=secret"), { code: "57P01" }); } }).get("POST " + ENDPOINT);
    const failed = await call(broken, { headers, body: notice() });
    assert.equal(failed.status, 500); assert.equal(JSON.stringify(failed.json).includes("secret"), false);
  } finally { if (previous == null) delete process.env.HUBLA_WEBHOOK_TOKEN; else process.env.HUBLA_WEBHOOK_TOKEN = previous; }
});
test("rotas administrativas da Hubla exigem o segredo administrativo", async () => {
  const previous = process.env.DR_ADMIN_SECRET; process.env.DR_ADMIN_SECRET = "hubla-admin-test";
  const map = routes({ query: async () => assert.fail("consulta sem autorizacao") });
  try {
    for (const key of ["GET /api/integrations/hubla/status", "GET /api/integrations/hubla/events", "POST /api/integrations/hubla/process",
      "POST /api/integrations/hubla/events/:id/retry", "POST /api/integrations/hubla/events/:id/resolve-refund"]) {
      assert.equal((await call(map.get(key), { params: { id: "1" }, body: { value: 10 } })).status, 401, key);
    }
  } finally { if (previous == null) delete process.env.DR_ADMIN_SECRET; else process.env.DR_ADMIN_SECRET = previous; }
});

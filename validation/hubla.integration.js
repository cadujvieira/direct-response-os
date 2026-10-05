// Homologacao local do receptor Hubla. Mesmas travas do roteiro do funil:
// somente PostgreSQL em loopback no banco oferta_validation e aplicacao HTTP em loopback.
// Os avisos abaixo sao SINTETICOS, no formato publicado pela Hubla (payload 2.0.0). Nao provam conexao real.
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const crypto = require("node:crypto");

async function main() {
  const dbUrl = new URL(process.env.DR_VALIDATION_DATABASE_URL || "invalid:");
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["postgres:", "postgresql:"].includes(dbUrl.protocol));
  assert(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
  assert.equal(dbUrl.pathname, "/oferta_validation");
  assert.equal(base.protocol, "http:");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const secret = process.env.DR_VALIDATION_ADMIN_SECRET, token = process.env.DR_VALIDATION_HUBLA_TOKEN;
  assert(secret && secret.startsWith("funnel-validation-"));
  assert(token && token.startsWith("hubla-validation-"));
  // A aplicacao sob teste deve usar: HUBLA_FRONT_PRODUCT_IDS=qa-front-product,qa-front-offer e HUBLA_MENTORSHIP_PRODUCT_IDS=qa-mentor-product
  const pool = new Pool({ connectionString: dbUrl.href, ssl: false });
  const prefix = "qa" + crypto.randomBytes(5).toString("hex");
  let groups = 0;
  const pass = label => { groups++; console.log("PASS " + label); };
  const http = async (path, { body, status = 200, headers = {}, method } = {}) => {
    const response = await fetch(new URL(path, base), { method: method || (body == null ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...headers }, ...(body == null ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    assert.equal(response.status, status, path + ": " + JSON.stringify(json));
    return json;
  };
  const admin = (path, options = {}) => http(path, { ...options, headers: { "x-admin-secret": secret } });
  const scalar = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  let sequence = 0;
  function notice(o = {}) {
    const id = o.invoice || prefix + "-inv-" + (++sequence), mentor = o.kind === "mentorship";
    const history = o.history || [["unpaid", 60], ["paid", 59]];
    const product = o.product || (mentor ? "qa-mentor-product" : "qa-front-product");
    return { type: o.type || "invoice.status_updated", version: "2.0.0", event: {
      product: { id: product, name: mentor ? "Mentoria QA" : "Front QA" },
      products: [{ id: product, name: mentor ? "Mentoria QA" : "Front QA", offers: [{ id: o.product ? o.product + "-offer" : mentor ? "qa-mentor-offer" : "qa-front-offer", name: "Principal" }] }],
      invoice: { id, orderId: id + "-order", parentInvoiceId: null, childInvoiceIds: [], payerId: o.payer || id + "-payer", sellerId: "qa-seller",
        payer: { id: o.payer || id + "-payer", firstName: "Comprador", lastName: "QA", document: "12345678900",
          email: o.email === undefined ? id + "@example.test" : o.email, phone: "+55119" + String(parseInt(crypto.createHash("sha256").update(o.payer || id).digest("hex").slice(0, 8), 16) % 1e8).padStart(8, "0") },
        installments: 1, paymentMethod: "pix", currency: "BRL", type: "sell", status: o.status || history[history.length - 1][0],
        statusAt: history.map(([status, minutes]) => ({ status, when: ago(minutes) })),
        amount: o.amount || { subtotalCents: mentor ? 500000 : 29700, subtotal: mentor ? 5000 : 297, discountCents: 0, discount: 0,
          prorataCents: 0, prorata: 0, installmentFeeCents: 0, installmentFee: 0, totalCents: mentor ? 500000 : 29700, total: mentor ? 5000 : 297 },
        receivers: [{ id: "platform", role: "platform", email: "plataforma@example.test", paysForFees: false, totalCents: 2970, currency: "BRL" },
          { id: "qa-seller", role: "seller", email: "vendedor@example.test", paysForFees: true, totalCents: 26730, currency: "BRL" }],
        paymentSession: { ip: "203.0.113.9", userAgent: "QA-Agent", url: "https://pay.hub.la/qa-front-offer",
          utm: { source: "meta", medium: "paid" }, params: o.click ? { click_id: o.click, sck: "utmify" } : { sck: "utmify" } },
        billingAddress: { city: "Sao Paulo", postalCode: "01310-200" }, version: history.length } } };
  }
  const keyOf = new Map();
  async function send(body, { idem, sandbox = false, status = 200, auth = token } = {}) {
    const key = idem || prefix + "-idem-" + crypto.randomUUID();
    const result = await http("/api/integrations/hubla/webhook", { body, status,
      headers: { ...(auth ? { "x-hubla-token": auth } : {}), "x-hubla-idempotency": key, "x-hubla-sandbox": sandbox ? "TRUE" : "FALSE" } });
    keyOf.set(body, (sandbox ? "sandbox:" : "") + key);
    return result;
  }
  async function settle() {
    for (let n = 0; n < 200; n++) {
      await admin("/api/integrations/hubla/process", { body: {} });
      if (!await scalar("SELECT COUNT(*)::int AS n FROM dr_hubla_events WHERE status IN ('received','processing') OR (status = 'failed' AND next_attempt_at <= NOW())")) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("fila da Hubla nao estabilizou");
  }
  const row = async body => (await pool.query("SELECT * FROM dr_hubla_events WHERE idempotency_key = $1", [keyOf.get(body)])).rows[0];
  const deliver = async (body, options) => { await send(body, options); await settle(); return row(body); };
  const order = async invoice => (await pool.query(`SELECT o.valor, o.status, o.click_id, f.kind, f.front_order_id, f.refunded_value
    FROM dr_orders o JOIN dr_funnel_orders f ON f.order_id = o.order_id WHERE o.order_id = $1`, ["hubla:" + invoice])).rows[0];
  const refunds = async invoice => (await pool.query(`SELECT COALESCE(SUM(value),0) AS total, COUNT(*)::int AS n,
    MAX(raw_payload->>'payment_status') AS mode FROM dr_events WHERE event_name = 'refund' AND raw_payload->>'order_id' = $1`, ["hubla:" + invoice])).rows[0];
  try {
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events"), 0, "Use um banco novo e vazio de eventos");
    await http("/health");
    await send(notice(), { auth: null, status: 401 });
    await send(notice(), { auth: "hubla-validation-errado", status: 401 });
    await http("/api/integrations/hubla/webhook", { body: { semTipo: true }, status: 400, headers: { "x-hubla-token": token } });
    await http("/api/integrations/hubla/status", { status: 401 });
    await http("/api/integrations/hubla/events", { status: 401 });
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_hubla_events"), 0);
    let status = await admin("/api/integrations/hubla/status");
    assert.equal(status.provider_connected, false); assert.equal(status.token_configured, true);
    assert.deepEqual(status.products_configured, { front: 2, mentorship: 1, bump: 0 });
    assert.equal(JSON.stringify(status).includes(token), false);
    // Router real: o click_id usado nos avisos e o mesmo entregue a LP.
    await admin("/api/experiments/" + prefix, { method: "PUT", body: { name: "Homologacao Hubla", active: true,
      variants: [{ name: "Unica", destination_url: "https://example.test/lp", weight: 100, active: true }] } });
    const capture = async n => {
      const response = await fetch(new URL("/go/" + prefix + "?utm_source=meta&campaign_id=" + prefix + "c&visitor_id=" + prefix + n, base), { redirect: "manual" });
      assert.equal(response.status, 302);
      return new URL(response.headers.get("location")).searchParams.get("click_id");
    };
    const clicks = []; for (let n = 0; n < 12; n++) clicks.push(await capture(n));
    await pool.query("UPDATE dr_clicks SET created_at = NOW() AT TIME ZONE 'UTC' - INTERVAL '3 hours' WHERE click_id = ANY($1::text[])", [clicks]);
    pass("autenticacao por x-hubla-token, rotas administrativas protegidas e status honesto antes de qualquer aviso");

    const sandboxed = await deliver(notice({ click: clicks[0] }), { sandbox: true });
    assert.equal(sandboxed.status, "sandbox"); assert.match(sandboxed.reason, /front, R\$ 297\.00, com click_id/);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders"), 0);
    status = await admin("/api/integrations/hubla/status");
    assert.equal(status.provider_connected, false); assert.equal(status.sandbox.events, 1); assert.equal(status.live.events, 0);
    pass("aviso do sandbox e lido, fica separado e nao grava pedido, lead nem evento");

    const pendingPix = await deliver(notice({ click: clicks[0], history: [["unpaid", 30]] }));
    assert.equal(pendingPix.status, "ignored");
    const expired = await deliver(notice({ click: clicks[0], history: [["unpaid", 30], ["overdue", 5]] }));
    assert.equal(expired.status, "ignored");
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders"), 0);
    const paid = notice({ click: clicks[0] }), invoice = paid.event.invoice.id;
    const first = await deliver(paid, { idem: prefix + "-paid" });
    assert.equal(first.status, "processed"); assert.equal(first.kind, "front"); assert.equal(Number(first.amount), 297);
    let stored = await order(invoice);
    assert.equal(Number(stored.valor), 297); assert.equal(stored.kind, "front"); assert.equal(stored.click_id, clicks[0]);
    const lead = (await pool.query("SELECT lifecycle_stage, utm_source FROM dr_leads WHERE email = $1", [paid.event.invoice.payer.email])).rows[0];
    assert.equal(lead.lifecycle_stage, "customer"); assert.equal(lead.utm_source, "meta");
    assert.equal((await pool.query("SELECT created_at AT TIME ZONE 'UTC' AS at FROM dr_events WHERE event_id = $1", ["purchase_hubla:" + invoice])).rows[0].at.toISOString(),
      paid.event.invoice.statusAt[1].when, "horario real do pagamento, nao do recebimento");
    assert.equal((await send(paid, { idem: prefix + "-paid" })).duplicate, true);
    await Promise.all(Array.from({ length: 10 }, () => send(notice({ invoice, click: clicks[0] }))));
    for (const type of ["invoice.payment_succeeded", "invoice.created"]) await send(notice({ invoice, click: clicks[0], type }));
    await settle();
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders"), 1);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_name = 'purchase'"), 1);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_hubla_events WHERE invoice_id = $1 AND status = 'ignored'", [invoice]), 2);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_hubla_events WHERE payload::text ~ '12345678900|203\\.0\\.113\\.9|QA-Agent|01310-200|vendedor@example'"), 0);
    status = await admin("/api/integrations/hubla/status");
    assert.equal(status.provider_connected, true);
    const card = notice({ click: clicks[1], amount: { subtotalCents: 120000, subtotal: 1200, discountCents: 24000, discount: 240,
      installmentFeeCents: 16320, installmentFee: 163.2, totalCents: 112320, total: 1123.2 } });
    assert.equal((await deliver(card)).status, "processed");
    assert.equal(Number((await order(card.event.invoice.id)).valor), 960);
    pass("pendente/vencido nao viram compra; pago vira 1 pedido R$297 com click, lead e horario reais; reenvios e 10 avisos concorrentes nao duplicam; juros do parcelamento ficam fora");

    // Fora de ordem: reembolso total chega antes de qualquer aviso de pagamento.
    const lateInvoice = prefix + "-late", refundedHistory = [["unpaid", 50], ["paid", 49], ["refunded", 10]];
    await send(notice({ invoice: lateInvoice, click: clicks[2], history: refundedHistory }));
    await send(notice({ invoice: lateInvoice, click: clicks[2], history: refundedHistory, type: "invoice.refunded" }));
    await settle();
    await deliver(notice({ invoice: lateInvoice, click: clicks[2] }));
    stored = await order(lateInvoice);
    assert.equal(stored.status, "refunded"); assert.equal(Number(stored.refunded_value), 297);
    assert.deepEqual({ ...(await refunds(lateInvoice)) }, { total: "297", n: 1, mode: "refunded" });
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_hubla_events WHERE invoice_id = $1 AND status <> 'processed'", [lateInvoice]), 0);
    // Reembolso sem invoice.refunded: pode ser parcial e o valor nao vem no aviso.
    const partialInvoice = prefix + "-partial";
    await deliver(notice({ invoice: partialInvoice, click: clicks[3] }));
    const partial = notice({ invoice: partialInvoice, click: clicks[3], history: refundedHistory });
    assert.equal((await deliver(partial)).status, "pending_refund_confirmation");
    assert.equal(Number((await order(partialInvoice)).refunded_value), 0);
    await pool.query("UPDATE dr_hubla_events SET received_at = NOW() - INTERVAL '2 hours', next_attempt_at = NOW() WHERE idempotency_key = $1", [keyOf.get(partial)]);
    await settle();
    const review = await row(partial);
    assert.equal(review.status, "needs_review"); assert.equal(review.reason_code, "refund_unconfirmed");
    assert.equal(Number((await order(partialInvoice)).refunded_value), 0);
    await admin("/api/integrations/hubla/events/" + review.id + "/resolve-refund", { body: { value: 300 }, status: 409 });
    await admin("/api/integrations/hubla/events/" + review.id + "/resolve-refund", { body: { value: true }, status: 400 });
    await admin("/api/integrations/hubla/events/" + review.id + "/resolve-refund", { body: { value: 100.5 } });
    await admin("/api/integrations/hubla/events/" + review.id + "/resolve-refund", { body: { value: 100.5 }, status: 409 });
    stored = await order(partialInvoice);
    assert.equal(stored.status, "partially_refunded"); assert.equal(Number(stored.refunded_value), 100.5);
    pass("reembolso total fora de ordem desconta uma vez; reembolso sem confirmacao nao desconta ate o valor ser conferido");

    const disputeInvoice = prefix + "-dispute", disputed = [["unpaid", 50], ["paid", 49], ["disputed", 20]];
    await deliver(notice({ invoice: disputeInvoice, click: clicks[4] }));
    assert.equal((await deliver(notice({ invoice: disputeInvoice, click: clicks[4], history: disputed }))).reason_code, "disputed");
    assert.equal(Number((await order(disputeInvoice)).refunded_value), 0);
    await deliver(notice({ invoice: disputeInvoice, type: "refund_request.created" }));
    assert.equal(Number((await order(disputeInvoice)).refunded_value), 0);
    const charged = [...disputed, ["chargeback", 5]];
    await Promise.all(Array.from({ length: 5 }, () => send(notice({ invoice: disputeInvoice, click: clicks[4], history: charged }))));
    await settle();
    stored = await order(disputeInvoice);
    assert.equal(stored.status, "refunded"); assert.equal(Number(stored.refunded_value), 297);
    assert.deepEqual({ ...(await refunds(disputeInvoice)) }, { total: "297", n: 1, mode: "chargeback" });
    const wonInvoice = prefix + "-won";
    await deliver(notice({ invoice: wonInvoice, click: clicks[5], history: [...disputed, ["paid", 3]] }));
    assert.equal((await order(wonInvoice)).status, "paid"); assert.equal(Number((await refunds(wonInvoice)).n), 0);
    assert.equal((await deliver(notice({ invoice: disputeInvoice, click: clicks[4], history: [...charged, ["paid", 1]] }))).reason_code, "paid_after_reversal");
    pass("disputa e solicitacao de reembolso nao descontam; chargeback desconta uma unica vez; disputa ganha mantem a venda");

    const noClick = notice({});
    const orphan = await deliver(noClick);
    assert.equal(orphan.status, "pending_attribution"); assert.equal(orphan.reason_code, "missing_click"); assert.equal(Number(orphan.amount), 297);
    const lateClick = "dr_" + prefix + "_late", unknown = notice({ click: lateClick });
    assert.equal((await deliver(unknown)).reason_code, "unknown_click");
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders WHERE order_id = ANY($1::text[])", [["hubla:" + noClick.event.invoice.id, "hubla:" + unknown.event.invoice.id]]), 0);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_leads WHERE email = $1", [noClick.event.invoice.payer.email]), 0, "sem atribuicao por email");
    status = await admin("/api/integrations/hubla/status");
    assert.deepEqual(status.payments_not_integrated, { invoices: 2, known_value: 594 });
    assert.equal(status.clicks_recovered_from_checkout, 0);
    await http("/track/click", { body: { click_id: lateClick, utm_source: "meta" } });
    await pool.query("UPDATE dr_clicks SET created_at = NOW() AT TIME ZONE 'UTC' - INTERVAL '3 hours' WHERE click_id = $1", [lateClick]);
    const retried = await admin("/api/integrations/hubla/events/" + (await row(unknown)).id + "/retry", { body: {} });
    assert.equal(retried.event.status, "processed");
    await admin("/api/integrations/hubla/events/" + retried.event.id + "/retry", { body: {}, status: 409 });
    const unmapped = await deliver(notice({ click: clicks[6], product: "produto-desconhecido" }));
    assert.equal(unmapped.status, "unmapped_product");
    assert.equal((await deliver(notice({ click: clicks[6], amount: { totalCents: 29700, total: 29700 } }))).reason_code, "amount_units");
    const listed = await admin("/api/integrations/hubla/events?status=pending_attribution");
    assert.equal(listed.events.length, 1, JSON.stringify(listed)); assert.equal(JSON.stringify(listed).includes("example.test"), false);
    // Aviso de reembolso que desistiu de tentar volta sozinho para a fila quando o pagamento da mesma fatura entra.
    const sibClick = "dr_" + prefix + "_sib", sibInvoice = prefix + "-sib";
    const sibPaid = notice({ invoice: sibInvoice, click: sibClick });
    const sibRefund = notice({ invoice: sibInvoice, click: sibClick, history: refundedHistory, type: "invoice.refunded" });
    await deliver(sibPaid); await deliver(sibRefund);
    assert.equal((await row(sibRefund)).status, "pending_attribution");
    await pool.query("UPDATE dr_hubla_events SET next_attempt_at = NULL, attempts = 99 WHERE invoice_id = $1", [sibInvoice]);
    status = await admin("/api/integrations/hubla/status");
    assert.equal(status.reversals_not_integrated.invoices, 1);
    await http("/track/click", { body: { click_id: sibClick, utm_source: "meta" } });
    await pool.query("UPDATE dr_clicks SET created_at = NOW() AT TIME ZONE 'UTC' - INTERVAL '3 hours' WHERE click_id = $1", [sibClick]);
    await admin("/api/integrations/hubla/events/" + (await row(sibPaid)).id + "/retry", { body: {} });
    await settle();
    assert.equal((await row(sibRefund)).status, "processed");
    assert.equal((await order(sibInvoice)).status, "refunded");
    assert.equal((await admin("/api/integrations/hubla/status")).reversals_not_integrated.invoices, 0);
    const weird = notice({ click: clicks[6] }); weird.event.invoice.statusAt = [];
    assert.equal((await deliver(weird)).reason_code, "missing_paid_history");
    pass("pagamento sem click fica pendente e visivel (sem inventar click nem atribuir por email); click tardio libera o reprocessamento; produto desconhecido nao e contado");

    // Sem redirecionamento: a tag cria o clique na pagina. Se o aviso do clique nao chegou, o checkout devolve a origem.
    const tagClick = "dr_" + crypto.randomUUID(), recovered = notice({ click: tagClick });
    Object.assign(recovered.event.invoice.paymentSession, { utm: { source: "FB", medium: "Conj|120222222222", campaign: "Camp|120211111111", content: "Ad|120233333333" },
      params: { click_id: tagClick, fbclid: "fb-recuperado", sck: "utmify" } });
    assert.equal((await deliver(recovered)).status, "processed");
    const recoveredClick = (await pool.query("SELECT * FROM dr_clicks WHERE click_id = $1", [tagClick])).rows[0];
    assert.equal(recoveredClick.capture_source, "checkout_recovered"); assert.equal(recoveredClick.utm_source, "FB");
    assert.deepEqual([recoveredClick.campaign_id, recoveredClick.adset_id, recoveredClick.ad_id], ["120211111111", "120222222222", "120233333333"]);
    assert.equal(recoveredClick.fbclid, "fb-recuperado");
    assert(recoveredClick.created_at <= (await pool.query("SELECT created_at FROM dr_events WHERE event_id = $1", ["purchase_hubla:" + recovered.event.invoice.id])).rows[0].created_at);
    assert.equal((await order(recovered.event.invoice.id)).click_id, tagClick);
    assert.equal((await admin("/api/integrations/hubla/status")).clicks_recovered_from_checkout, 1);
    // Clique avisado pela tag antes da compra: vale o registro da tag, e o checkout nao troca a origem.
    const reported = "dr_" + crypto.randomUUID();
    await http("/track/click", { body: { click_id: reported, utm_source: "FB", utm_campaign: "Original|120299999999", page_url: "https://lp.example.test/vsl-10" } });
    await http("/track/click", { body: { click_id: reported, utm_source: "trocado", utm_campaign: "Outra|120200000000", ad_id: "120244444444" } });
    await pool.query("UPDATE dr_clicks SET created_at = NOW() AT TIME ZONE 'UTC' - INTERVAL '3 hours' WHERE click_id = $1", [reported]);
    const viaTag = notice({ click: reported });
    viaTag.event.invoice.paymentSession.utm = { source: "outra-origem", campaign: "Diferente|120288888888" };
    assert.equal((await deliver(viaTag)).status, "processed");
    const kept = (await pool.query("SELECT * FROM dr_clicks WHERE click_id = $1", [reported])).rows[0];
    assert.equal(kept.capture_source, "tag"); assert.equal(kept.utm_source, "FB"); assert.equal(kept.campaign_id, "120299999999");
    assert.equal(kept.ad_id, null, "um segundo envio nao mistura IDs de outra origem no clique");
    // O router tambem nao troca a origem de um clique que ja existe.
    await fetch(new URL("/go/" + prefix + "?click_id=" + reported + "&utm_source=sequestro&campaign_id=666", base), { redirect: "manual" });
    assert.equal((await pool.query("SELECT utm_source, campaign_id FROM dr_clicks WHERE click_id = $1", [reported])).rows[0].utm_source, "FB");
    // Clique de acesso direto (sem origem) aceita a origem uma unica vez, inteira.
    const direct = "dr_" + crypto.randomUUID();
    await http("/track/click", { body: { click_id: direct } });
    await http("/track/click", { body: { click_id: direct, utm_source: "FB", utm_campaign: "A|120211111111" } });
    await http("/track/click", { body: { click_id: direct, utm_source: "outra", ad_id: "120255555555" } });
    const directRow = (await pool.query("SELECT utm_source, campaign_id, ad_id FROM dr_clicks WHERE click_id = $1", [direct])).rows[0];
    assert.deepEqual({ ...directRow }, { utm_source: "FB", campaign_id: "120211111111", ad_id: null });
    assert.equal((await admin("/api/integrations/hubla/status")).clicks_recovered_from_checkout, 1);
    await http("/track/click", { body: { click_id: "tem espaco" }, status: 400 });
    // Rotas antigas: receita e pos-compra exigem senha; navegacao continua publica.
    await http("/track/purchase", { body: { order_id: prefix + ":forjado", click_id: reported, email: "x@example.test", valor: 297 }, status: 401 });
    await http("/track/spend", { body: { spend_date: "2026-10-01", campaign_id: "1", spend: 10 }, status: 401 });
    for (const event_name of ["purchase", "refund", "mentorship_purchase", "call_attended"]) {
      await http("/track/event", { body: { event_name, event_id: prefix + ":forjado:" + event_name, click_id: reported, value: event_name.includes("call") ? 0 : 297 }, status: 401 });
    }
    await http("/track/event", { body: { event_name: "landing_view", event_id: prefix + ":lv", click_id: reported, value: 50 }, status: 401 });
    await http("/track/event", { body: { event_name: "landing_view", event_id: prefix + ":lv", click_id: reported } });
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders WHERE order_id = $1", [prefix + ":forjado"]), 0);
    pass("clique criado pela tag: recuperado pelo checkout quando o aviso falha, nunca sobrescrito; rotas antigas de receita fechadas");

    const frontInvoice = prefix + "-mfront", buyer = prefix + "-buyer";
    const mentorEarly = notice({ kind: "mentorship", payer: buyer, history: [["unpaid", 9], ["paid", 8]] });
    assert.equal((await deliver(mentorEarly)).status, "pending_front_order");
    await deliver(notice({ invoice: frontInvoice, payer: buyer, click: clicks[7], history: [["unpaid", 40], ["paid", 39]] }));
    assert.equal((await admin("/api/integrations/hubla/events/" + (await row(mentorEarly)).id + "/retry", { body: {} })).event.status, "processed");
    stored = await order(mentorEarly.event.invoice.id);
    assert.equal(stored.kind, "mentorship"); assert.equal(stored.front_order_id, "hubla:" + frontInvoice);
    assert.equal(stored.click_id, clicks[7]); assert.equal(Number(stored.valor), 5000);
    assert.equal((await pool.query("SELECT lifecycle_stage FROM dr_leads WHERE click_id = $1", [clicks[7]])).rows[0].lifecycle_stage, "mentorship_customer");
    await deliver(notice({ payer: buyer, click: clicks[8], history: [["unpaid", 30], ["paid", 29]] }));
    const ambiguous = await deliver(notice({ kind: "mentorship", payer: buyer, history: [["unpaid", 7], ["paid", 6]] }));
    assert.equal(ambiguous.reason_code, "ambiguous_front_order");
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_name = 'mentorship_purchase'"), 1);
    pass("mentoria na Hubla entra com pedido proprio ligado ao front pelo ID do comprador; antes do front espera; vinculo ambiguo nao e adivinhado");

    const failing = notice({ click: clicks[9] }), failingId = "purchase_hubla:" + failing.event.invoice.id;
    await pool.query(`CREATE FUNCTION ${prefix}_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_event_id = '${failingId}' THEN RAISE EXCEPTION 'QA queue failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${prefix}_t BEFORE INSERT ON dr_automation_runs FOR EACH ROW EXECUTE FUNCTION ${prefix}_fail()`);
    try {
      assert.equal((await send(failing)).received, true);
      for (let n = 0; n < 100 && (await row(failing)).status !== "failed"; n++) {
        await admin("/api/integrations/hubla/process", { body: {} }); await new Promise(resolve => setTimeout(resolve, 50));
      }
      const failed = await row(failing);
      assert.equal(failed.status, "failed"); assert(new Date(failed.next_attempt_at) > new Date());
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders WHERE order_id = $1", ["hubla:" + failing.event.invoice.id]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_leads WHERE email = $1", [failing.event.invoice.payer.email]), 0);
    } finally {
      await pool.query(`DROP TRIGGER ${prefix}_t ON dr_automation_runs`); await pool.query(`DROP FUNCTION ${prefix}_fail()`);
    }
    await pool.query("UPDATE dr_hubla_events SET next_attempt_at = NOW() WHERE idempotency_key = $1", [keyOf.get(failing)]);
    await settle();
    assert.equal((await row(failing)).status, "processed");
    assert.equal(Number((await order(failing.event.invoice.id)).valor), 297);
    // Aviso preso em "processing" (queda do servidor no meio) e recuperado.
    const stuck = notice({ click: clicks[10] });
    await pool.query(`INSERT INTO dr_hubla_events (idempotency_key, event_type, invoice_id, payload, status, locked_at, next_attempt_at)
      VALUES ($1, 'invoice.status_updated', $2, $3::jsonb, 'processing', NOW() - INTERVAL '10 minutes', NULL)`,
    [prefix + "-stuck", stuck.event.invoice.id, JSON.stringify(stuck)]);
    await settle();
    assert.equal(Number((await order(stuck.event.invoice.id)).valor), 297);
    pass("ACK somente apos persistir; falha interna reverte tudo, agenda nova tentativa e conclui depois; aviso preso e recuperado");

    // Os avisos tem ate 1h de idade: perto da meia-noite de Sao Paulo eles caem no dia anterior.
    const day = offset => new Date(Date.now() - 3 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
    const ltv = (await admin("/api/revenue/ltv?from=" + day(1) + "&to=" + day(0))).ltv;
    const fronts = await scalar("SELECT COUNT(*)::int AS n FROM dr_funnel_orders WHERE kind = 'front'");
    assert.equal(Number(ltv.front_purchases), fronts);
    assert.equal(Number(ltv.front_revenue), await scalar("SELECT SUM(o.valor) AS n FROM dr_orders o JOIN dr_funnel_orders f USING (order_id) WHERE f.kind = 'front'"));
    assert.equal(Number(ltv.mentorship_revenue), 5000);
    assert.equal(Number(ltv.refunds), 297 + 100.5 + 297 + 297);
    assert.equal((await admin("/api/integrations/funnel/status")).provider_connected, false, "canal canonico continua honesto");
    status = await admin("/api/integrations/hubla/status");
    pass("LTV soma front, mentoria e reversoes uma unica vez");
    console.log("HUBLA_E2E_PASS groups=" + groups + " fronts=" + fronts + " live_events=" + status.live.events +
      " by_status=" + JSON.stringify(status.live.by_status) + " synthetic=true production_touched=false");
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { main };

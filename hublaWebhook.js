// Receptor dedicado de webhooks da Hubla.
// Recebe -> autentica -> persiste (inbox duravel) -> ACK -> processa de forma assincrona
// traduzindo para o contrato canonico do funil (funnelIntegration.js).
const crypto = require("crypto");
const { requireAdmin } = require("./trackingHealth");
const { normalizeFunnelEvent, ingestFunnelEvent } = require("./funnelIntegration");

const ENDPOINT = "/api/integrations/hubla/webhook";
const FINANCIAL_TRAIL = "invoice.status_updated";
const REFUND_CONFIRMATION = "invoice.refunded";
const REQUIRED_EVENTS = [FINANCIAL_TRAIL, REFUND_CONFIRMATION];
const REFUND_GRACE_MS = 30 * 60 * 1000;
const REFUND_RECHECK_MS = 2 * 60 * 1000;
const MAX_AUTO_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const STALE_PROCESSING_MINUTES = 5;
const DEFAULT_WORKER_INTERVAL_MS = 30000;
const RETRYABLE = ["received", "failed", "pending_attribution", "pending_front_order",
  "pending_refund_confirmation", "unmapped_product"];
const PENDING_MONEY = ["received", "failed", "processing", "pending_attribution", "pending_front_order",
  "unmapped_product", "needs_review"];
// Removidos antes de persistir: documento, endereco, IP e user agent nao sao necessarios ao funil.
const SENSITIVE_KEYS = new Set(["document", "documents", "cpf", "cnpj", "billingaddress", "address", "ip", "ipaddress", "useragent"]);
const STUCK_ATTEMPTS = 30;

function list(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}
function hublaConfig(env = process.env) {
  const kinds = new Map(), conflicts = new Set();
  for (const [kind, name] of [["front", "HUBLA_FRONT_PRODUCT_IDS"], ["mentorship", "HUBLA_MENTORSHIP_PRODUCT_IDS"],
    ["bump", "HUBLA_BUMP_PRODUCT_IDS"]]) {
    for (const id of list(env[name])) {
      if (kinds.has(id) && kinds.get(id) !== kind) conflicts.add(id);
      kinds.set(id, kind);
    }
  }
  const param = String(env.HUBLA_CLICK_ID_PARAM || "click_id").trim().toLowerCase();
  return { token: String(env.HUBLA_WEBHOOK_TOKEN || "").trim(), kinds, conflicts,
    clickParam: /^[a-z0-9_]{1,40}$/.test(param) ? param : "click_id" };
}
function tokenMatches(expected, received) {
  const a = crypto.createHash("sha256").update(String(expected || "")).digest();
  const b = crypto.createHash("sha256").update(String(received || "").trim()).digest();
  return Boolean(expected) && crypto.timingSafeEqual(a, b);
}
function isSandbox(value) { return /^(true|1)$/i.test(String(value ?? "").trim()); }
// Os avisos de "Testar configuracao" usam o produto real da conta e IDs terminados em "-tester".
// Segunda trava: mesmo sem o cabecalho de sandbox, esses avisos nunca sao tratados como venda.
function looksLikeTest(body) {
  const invoice = body?.event?.invoice;
  return [invoice?.id, invoice?.orderId, invoice?.payerId].some(id => typeof id === "string" && /-tester$/i.test(id.trim()));
}
function clean(value, max = 200) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).replace(/[\u0000-\u001f]/g, " ").trim();
  return result && result.length <= max ? result : null;
}
function sanitizePayload(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizePayload(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 2000) : value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))) continue;
    if (key === "receivers" && Array.isArray(item)) {
      // Dados de contato de terceiros (plataforma/coprodutores) nao sao persistidos.
      result.receivers = item.slice(0, 20).map(r => ({ role: r?.role ?? null, paysForFees: r?.paysForFees ?? null,
        totalCents: r?.totalCents ?? null, currency: r?.currency ?? null }));
      continue;
    }
    result[key] = sanitizePayload(item, depth + 1);
  }
  return result;
}
function bodyHash(body) { return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); }
function idempotencyKey(header, body, sandbox) {
  const key = clean(header, 200) || "body:" + bodyHash(body);
  // Um teste do sandbox nunca pode ocupar a chave de um aviso real.
  return (sandbox ? "sandbox:" : "") + key;
}
function cents(value) { return Number.isInteger(value) && Math.abs(value) <= 1e9 ? value : null; }
function statusTime(invoice, status, last = false) {
  const entries = (Array.isArray(invoice?.statusAt) ? invoice.statusAt : []).filter(e => e && e.status === status);
  const when = (last ? entries[entries.length - 1] : entries[0])?.when;
  const parsed = typeof when === "string" ? new Date(when) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function productIds(event) {
  const ids = new Set();
  const add = id => { const value = clean(id, 100); if (value) ids.add(value); };
  add(event?.product?.id);
  for (const product of Array.isArray(event?.products) ? event.products : []) {
    add(product?.id);
    for (const offer of Array.isArray(product?.offers) ? product.offers : []) add(offer?.id);
  }
  return [...ids];
}
function clickFromSession(invoice, param) {
  const session = invoice?.paymentSession;
  const found = [];
  if (session?.params && typeof session.params === "object") {
    for (const [key, value] of Object.entries(session.params)) if (key.toLowerCase() === param) found.push(value);
  }
  if (!found.length && typeof session?.url === "string") {
    try {
      for (const [key, value] of new URL(session.url).searchParams) if (key.toLowerCase() === param) found.push(value);
    } catch { /* URL de checkout ilegivel: tratar como sem click */ }
  }
  const values = [...new Set(found.map(value => clean(value, 200)).filter(Boolean))];
  if (found.length && values.length !== 1) return { click_id: null, problem: "click_id invalido ou repetido no checkout" };
  return { click_id: values[0] || null, problem: values[0] ? null : "click_id ausente no checkout (paymentSession.params)" };
}
function envelope(body) {
  const event = body?.event && typeof body.event === "object" ? body.event : {};
  const invoice = event.invoice && typeof event.invoice === "object" ? event.invoice : null;
  return { event_type: clean(body?.type, 100), payload_version: clean(body?.version, 20),
    invoice_id: clean(invoice?.id, 100), invoice_status: clean(invoice?.status, 40),
    invoice_version: Number.isInteger(invoice?.version) ? invoice.version : null,
    payer_id: clean(invoice?.payerId ?? invoice?.payer?.id, 100), product_ids: productIds(event) };
}
// Interpreta um aviso de fatura sem tocar no banco. Nunca inventa valor, produto ou atribuicao.
function interpretInvoice(body, config) {
  const type = clean(body?.type, 100);
  if (type !== FINANCIAL_TRAIL && type !== REFUND_CONFIRMATION) {
    const why = type && type.startsWith("invoice.") ? "trilha redundante; " + FINANCIAL_TRAIL + " e a trilha financeira"
      : type && type.startsWith("refund_request.") ? "solicitacao de reembolso nao e devolucao confirmada"
      : "evento sem efeito financeiro neste receptor";
    return { outcome: "ignored", code: "not_financial_trail", reason: why };
  }
  const event = body.event, invoice = event?.invoice;
  const review = (code, reason) => ({ outcome: "needs_review", code, reason });
  if (!invoice || typeof invoice !== "object") return review("invalid_invoice", "aviso sem fatura");
  const invoiceId = clean(invoice.id, 80), status = clean(invoice.status, 40);
  if (!invoiceId || !status) return review("invalid_invoice", "fatura sem id ou status");
  const paidAt = statusTime(invoice, "paid");
  if (!paidAt) {
    // So e seguro ignorar status sabidamente nao pagos; qualquer outro sem historico legivel exige revisao.
    if (["unpaid", "overdue", "canceled"].includes(status) && type === FINANCIAL_TRAIL) {
      return { outcome: "ignored", code: "never_paid", reason: "fatura sem pagamento confirmado (" + status + ")" };
    }
    return review("missing_paid_history", "fatura " + status + " sem data de pagamento legivel no historico");
  }
  if (type === REFUND_CONFIRMATION && status !== "refunded") return review("refund_status_mismatch",
    "invoice.refunded recebido com fatura em status " + status);
  const ids = productIds(event);
  const kinds = new Set(ids.map(id => config.kinds.get(id)).filter(Boolean));
  if (ids.some(id => config.conflicts.has(id))) return { outcome: "unmapped_product", code: "product_conflict",
    reason: "o mesmo ID esta configurado em mais de um tipo de produto" };
  if (!kinds.size) return { outcome: "unmapped_product", code: "unmapped_product",
    reason: "produto/oferta nao configurado: " + (ids.join(", ") || "sem id") };
  const products = Array.isArray(event.products) ? event.products : [];
  if (kinds.size > 1 || products.length > 1) return review("multi_product",
    "venda com mais de um produto; divisao de valor por produto ainda nao confirmada");
  const kind = [...kinds][0];
  if (invoice.type !== "sell") return review("unsupported_invoice_type", "fatura do tipo " + clean(invoice.type, 40) + " (renovacao/upgrade) exige revisao");
  if (invoice.parentInvoiceId) return review("child_invoice", "fatura filha de outra fatura; evitando contar a mesma venda duas vezes");
  const smart = invoice.smartInstallment;
  if (smart && Number(smart.installment) > 1) return review("installment_followup",
    "parcela " + Number(smart.installment) + " de parcelamento inteligente; recebimentos posteriores ainda nao sao integrados");
  if (invoice.currency !== "BRL" || invoice.amount?.settlement || invoice.currencyConversion) {
    return review("currency", "venda fora de BRL ou com liquidacao em outra moeda");
  }
  const total = cents(invoice.amount?.totalCents), fee = cents(invoice.amount?.installmentFeeCents ?? 0);
  if (total == null || fee == null || fee < 0 || total - fee <= 0) return review("amount", "valores da fatura ausentes ou invalidos");
  // Desde 23/09/2026 a Hubla envia reais ao lado de centavos; usamos centavos e apenas conferimos a unidade.
  if (invoice.amount.total != null && Math.round(Number(invoice.amount.total) * 100) !== total) {
    return review("amount_units", "amount.total diverge de amount.totalCents");
  }
  const seller = (Array.isArray(invoice.receivers) ? invoice.receivers : []).filter(r => r?.role === "seller");
  const payer = invoice.payer && typeof invoice.payer === "object" ? invoice.payer : {};
  const email = clean(payer.email, 254)?.toLowerCase() || null;
  const phone = clean(payer.phone, 40)?.replace(/[^0-9]/g, "") || null;
  const click = clickFromSession(invoice, config.clickParam);
  return { outcome: "ok", sale: { kind, invoice_id: invoiceId, order_id: "hubla:" + invoiceId, status,
    // Valor bruto da venda: total cobrado menos juros de parcelamento do comprador (nao e receita do produtor).
    value: (total - fee) / 100, charged_total: total / 100,
    seller_net: seller.length === 1 && cents(seller[0].totalCents) != null && seller[0].currency === "BRL" ? seller[0].totalCents / 100 : null,
    paid_at: paidAt, refunded_at: statusTime(invoice, "refunded", true), chargeback_at: statusTime(invoice, "chargeback", true),
    repaid_after_reversal: ["refunded", "chargeback"].some(s => {
      const at = statusTime(invoice, s, true), again = statusTime(invoice, "paid", true);
      return at && again && again > at;
    }),
    click_id: click.click_id, click_problem: click.problem, email, telefone: /^\d{8,15}$/.test(phone || "") ? phone : null,
    nome: clean([payer.firstName, payer.lastName].filter(Boolean).join(" "), 200),
    produto: clean(event.product?.name ?? products[0]?.name, 300),
    payer_id: clean(invoice.payerId ?? payer.id, 100) } };
}
function backoff(attempts) { return Math.min(MAX_BACKOFF_MS, 60000 * 2 ** Math.max(0, attempts - 1)); }

async function initHublaDb(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dr_hubla_events (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    sandbox BOOLEAN NOT NULL DEFAULT FALSE,
    event_type TEXT NOT NULL, payload_version TEXT,
    invoice_id TEXT, invoice_status TEXT, invoice_version INTEGER, payer_id TEXT,
    product_ids TEXT[] NOT NULL DEFAULT '{}',
    payload JSONB NOT NULL, body_hash TEXT,
    status TEXT NOT NULL DEFAULT 'received',
    reason_code TEXT, reason TEXT, kind TEXT, amount NUMERIC,
    canonical_order_id TEXT, canonical_event_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ DEFAULT NOW(), locked_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS dr_hubla_events_queue_idx ON dr_hubla_events(status, next_attempt_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS dr_hubla_events_invoice_idx ON dr_hubla_events(invoice_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS dr_hubla_events_payer_idx ON dr_hubla_events(payer_id) WHERE kind = 'front'");
}
async function storeHublaEvent(pool, body, headers = {}) {
  const sandbox = isSandbox(headers.sandbox) || looksLikeTest(body), meta = envelope(body), hash = bodyHash(body);
  const key = idempotencyKey(headers.idempotency, body, sandbox);
  const insert = useKey => pool.query(`INSERT INTO dr_hubla_events
    (idempotency_key, sandbox, event_type, payload_version, invoice_id, invoice_status, invoice_version, payer_id, product_ids, payload, body_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
  [useKey, sandbox, meta.event_type, meta.payload_version, meta.invoice_id,
    meta.invoice_status, meta.invoice_version, meta.payer_id, meta.product_ids, JSON.stringify(sanitizePayload(body)), hash]);
  let inserted = await insert(key);
  if (!inserted.rows.length) {
    // Mesma chave com conteudo diferente nao e reenvio: guardamos como aviso proprio em vez de descartar.
    const known = (await pool.query("SELECT body_hash FROM dr_hubla_events WHERE idempotency_key = $1", [key])).rows[0];
    if (known && known.body_hash && known.body_hash !== hash) inserted = await insert(key + "#" + hash);
  }
  return { inserted: inserted.rows.length > 0, id: inserted.rows[0]?.id || null, sandbox };
}
async function ledgerOrder(pool, orderId) {
  return (await pool.query(`SELECT f.kind, f.front_order_id, f.refunded_value, f.paid_at, o.valor
    FROM dr_funnel_orders f JOIN dr_orders o ON o.order_id = f.order_id WHERE f.order_id = $1`, [orderId])).rows[0] || null;
}
function fromIngestError(error, kind) {
  if (!error.statusCode) throw error;
  if (error.statusCode === 422) return { status: "pending_attribution", code: "unknown_click",
    reason: "click_id recebido nao existe no Oferta DR; pagamento preservado sem atribuicao" };
  if (error.statusCode === 409 && /ainda nao foi integrado/.test(error.message)) return { status: "pending_front_order",
    code: "front_order_missing", reason: "compra front original ainda nao integrada" };
  return { status: "needs_review", code: error.statusCode === 409 ? "ledger_conflict" : "canonical_rejected",
    reason: (kind ? kind + ": " : "") + error.message };
}
async function ensurePaidOrder(pool, sale, hooks, now) {
  if (await ledgerOrder(pool, sale.order_id)) return null;
  const base = { order_id: sale.order_id, value: sale.value, currency: "BRL", payment_status: "approved",
    occurred_at: sale.paid_at, produto: sale.produto };
  let input;
  if (sale.kind === "front") {
    if (!sale.click_id) return { status: "pending_attribution", code: "missing_click", reason: sale.click_problem };
    if (!sale.email && !sale.telefone) return { status: "needs_review", code: "missing_contact", reason: "comprador sem email ou telefone valido" };
    input = { ...base, event_name: "purchase", click_id: sale.click_id, email: sale.email, telefone: sale.telefone, nome: sale.nome };
  } else if (sale.kind === "mentorship") {
    // Vinculo pelo ID estavel do comprador na Hubla (nunca por email/nome). Zero ou mais de um pedido front = pendencia.
    const fronts = sale.payer_id ? (await pool.query(`SELECT DISTINCT h.canonical_order_id FROM dr_hubla_events h
      JOIN dr_funnel_orders f ON f.order_id = h.canonical_order_id AND f.kind = 'front'
      WHERE h.payer_id = $1 AND h.kind = 'front' AND h.sandbox = FALSE`, [sale.payer_id])).rows : [];
    if (!fronts.length) return { status: "pending_front_order", code: "front_order_missing",
      reason: "nenhuma compra front integrada para este comprador da Hubla" };
    if (fronts.length > 1) return { status: "needs_review", code: "ambiguous_front_order",
      reason: "comprador possui mais de uma compra front; vinculo da mentoria exige decisao" };
    input = { ...base, event_name: "mentorship_purchase", front_order_id: fronts[0].canonical_order_id };
  } else {
    return { status: "needs_review", code: "bump_not_enabled", reason: "order bump ainda nao habilitado neste receptor" };
  }
  try { await ingestFunnelEvent(pool, normalizeFunnelEvent(input, now), hooks); return null; }
  catch (error) { return fromIngestError(error, "pagamento"); }
}
async function applyReversal(pool, sale, hooks, now, mode, value) {
  const order = await ledgerOrder(pool, sale.order_id);
  const remaining = Math.round((Number(order.valor) - Number(order.refunded_value)) * 100) / 100;
  if (remaining <= 0) return { status: "processed", code: "already_reversed", reason: "pedido ja revertido integralmente; nada a descontar" };
  const amount = value == null ? remaining : value;
  const occurred = mode === "chargeback" ? sale.chargeback_at : sale.refunded_at;
  const eventId = "hubla:" + sale.invoice_id + ":" + mode + (mode === "refunded" ? ":" + occurred : "");
  try {
    const result = await ingestFunnelEvent(pool, normalizeFunnelEvent({ event_name: "refund", event_id: eventId,
      order_id: sale.order_id, value: amount, currency: "BRL", payment_status: mode, occurred_at: occurred }, now), hooks);
    return { status: "processed", code: mode, canonical_event_id: result.event_id,
      reason: (mode === "chargeback" ? "chargeback confirmado" : "reembolso confirmado") + (result.duplicate ? " (ja integrado)" : "") };
  } catch (error) { return fromIngestError(error, mode); }
}
// Decide e aplica o efeito de um aviso. Idempotente: pode ser repetido apos falha ou fora de ordem.
async function processHublaEvent(pool, row, config, hooks, now = new Date()) {
  const interpreted = interpretInvoice(row.payload, config);
  const sale = interpreted.sale;
  const details = sale ? { kind: sale.kind, amount: sale.value, canonical_order_id: sale.order_id } : {};
  if (row.sandbox) {
    return { status: "sandbox", code: interpreted.code || "dry_run", ...(sale ? { kind: sale.kind, amount: sale.value } : {}),
      reason: "teste do sandbox; nada gravado no funil. Leitura: " + (sale
        ? sale.kind + ", R$ " + sale.value.toFixed(2) + ", " + (sale.click_id ? "com click_id" : "sem click_id")
        : interpreted.outcome + " - " + interpreted.reason) };
  }
  if (interpreted.outcome !== "ok") return { status: interpreted.outcome, code: interpreted.code, reason: interpreted.reason };
  // Todo aviso carrega o historico de status: o pagamento e garantido mesmo se o aviso "paid" se perdeu.
  const blocked = await ensurePaidOrder(pool, sale, hooks, now);
  if (blocked) return { ...details, ...blocked };
  const ok = (code, reason, extra = {}) => ({ ...details, status: "processed", code, reason, ...extra });
  if (sale.status === "paid") {
    const order = await ledgerOrder(pool, sale.order_id);
    if (Number(order.refunded_value) > 0 && sale.repaid_after_reversal) return { ...details, status: "needs_review",
      code: "paid_after_reversal", reason: "fatura voltou para paga depois de reembolso/chargeback ja descontado" };
    return ok("paid", "pagamento integrado");
  }
  if (sale.status === "disputed") return ok("disputed", "disputa aberta registrada; nao e perda definitiva e nada foi descontado");
  if (sale.status === "chargeback") {
    if (!sale.chargeback_at) return { ...details, status: "needs_review", code: "invalid_invoice", reason: "chargeback sem data no historico" };
    return { ...details, ...await applyReversal(pool, sale, hooks, now, "chargeback") };
  }
  if (sale.status === "refunded") {
    if (!sale.refunded_at) return { ...details, status: "needs_review", code: "invalid_invoice", reason: "reembolso sem data no historico" };
    const order = await ledgerOrder(pool, sale.order_id);
    if (Number(order.refunded_value) >= Number(order.valor)) return ok("already_reversed", "pedido ja revertido integralmente; nada a descontar");
    // A Hubla envia invoice.refunded somente no reembolso total; no parcial o valor nao vem no aviso.
    const confirmed = row.event_type === REFUND_CONFIRMATION || (await pool.query(`SELECT 1 FROM dr_hubla_events
      WHERE invoice_id = $1 AND event_type = $2 AND sandbox = FALSE LIMIT 1`, [sale.invoice_id, REFUND_CONFIRMATION])).rows.length > 0;
    if (confirmed) return { ...details, ...await applyReversal(pool, sale, hooks, now, "refunded") };
    if (now.getTime() - new Date(row.received_at).getTime() < REFUND_GRACE_MS) return { ...details,
      status: "pending_refund_confirmation", code: "refund_unconfirmed", retry_ms: REFUND_RECHECK_MS,
      reason: "aguardando invoice.refunded para confirmar reembolso total" };
    return { ...details, status: "needs_review", code: "refund_unconfirmed",
      reason: "reembolso sem confirmacao de valor total; pode ser parcial e a Hubla nao informa o valor no aviso" };
  }
  return { ...details, status: "needs_review", code: "unexpected_status", reason: "fatura paga mudou para " + sale.status };
}
async function finishRow(pool, row, result) {
  const terminal = !RETRYABLE.includes(result.status);
  const exhausted = row.attempts >= MAX_AUTO_ATTEMPTS && result.status !== "pending_refund_confirmation";
  // unmapped_product so volta a ser tentado quando a configuracao muda (reinicio) ou por pedido manual.
  const next = terminal || exhausted || result.status === "unmapped_product" ? null
    : new Date(Date.now() + (result.retry_ms || backoff(row.attempts)));
  await pool.query(`UPDATE dr_hubla_events SET status = $2, reason_code = $3, reason = $4, kind = COALESCE($5, kind),
    amount = COALESCE($6, amount), canonical_order_id = COALESCE($7, canonical_order_id),
    canonical_event_id = COALESCE($8, canonical_event_id), next_attempt_at = $9, locked_at = NULL,
    processed_at = CASE WHEN $2 IN ('processed','ignored','sandbox') THEN NOW() ELSE processed_at END, updated_at = NOW()
    WHERE id = $1`, [row.id, result.status, result.code || null, clean(result.reason, 500), result.kind || null,
    result.amount ?? null, result.status === "processed" ? result.canonical_order_id || null : null,
    result.canonical_event_id || null, next]);
}
// Quando um pedido entra no funil, avisos da mesma fatura (ex.: reembolso) e mentorias do mesmo comprador
// que tinham parado de tentar voltam para a fila, para que nenhuma reversao fique esquecida.
async function reopenRelated(pool, row, result) {
  if (result.status !== "processed" || row.sandbox) return;
  await pool.query(`UPDATE dr_hubla_events SET next_attempt_at = NOW(), attempts = 0, updated_at = NOW()
    WHERE sandbox = FALSE AND id <> $1 AND status = ANY($2::text[]) AND next_attempt_at IS NULL
      AND (($3::text IS NOT NULL AND invoice_id = $3) OR ($4::text IS NOT NULL AND payer_id = $4 AND status = 'pending_front_order'))`,
  [row.id, RETRYABLE.filter(status => status !== "unmapped_product"), row.invoice_id, result.kind === "front" ? row.payer_id : null]);
}
async function processRow(pool, row, config, hooks) {
  const lockKey = row.invoice_id && !row.sandbox ? "hubla-invoice:" + row.invoice_id : null;
  let lock = null, locked = false, result;
  try {
    if (lockKey) {
      lock = await pool.connect();
      // Serializa avisos da mesma fatura entre instancias; se ocupado, o aviso volta para a fila sem gastar tentativa.
      locked = (await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [lockKey])).rows[0].ok;
      if (!locked) {
        await pool.query(`UPDATE dr_hubla_events SET status = 'received', attempts = GREATEST(attempts - 1, 0), locked_at = NULL,
          next_attempt_at = NOW() + INTERVAL '5 seconds', updated_at = NOW() WHERE id = $1`, [row.id]);
        return "busy";
      }
    }
    result = await processHublaEvent(pool, row, config, hooks);
  } catch (error) {
    console.error("Hubla: falha ao processar aviso " + row.id + " (" + (error.code || "erro interno") + ")");
    result = { status: "failed", code: "internal_error", reason: "falha interna; nova tentativa agendada" };
  } finally {
    if (lock) {
      let broken = false;
      if (locked) { try { await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]); } catch { broken = true; } }
      lock.release(broken); // conexao com trava nao liberada e destruida, nunca devolvida ao pool
    }
  }
  await finishRow(pool, row, result);
  try { await reopenRelated(pool, row, result); } catch { console.error("Hubla: falha ao reabrir avisos relacionados ao aviso " + row.id); }
  return result.status;
}
// Uma execucao por vez neste processo: cada aviso usa no maximo duas conexoes do pool.
let queueTail = Promise.resolve();
function processHublaQueue(pool, hooks, options = {}) {
  const run = queueTail.then(() => runHublaQueue(pool, hooks, options));
  queueTail = run.catch(() => {});
  return run;
}
async function runHublaQueue(pool, hooks, options = {}) {
  const config = options.config || hublaConfig(), limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  // Aviso que derruba o processamento repetidamente sai do ciclo automatico e fica visivel para revisao.
  await pool.query(`UPDATE dr_hubla_events SET status = 'needs_review', reason_code = 'stuck', locked_at = NULL, next_attempt_at = NULL,
    reason = 'processamento interrompido repetidamente; exige revisao', updated_at = NOW()
    WHERE status = 'processing' AND attempts >= $1 AND locked_at < NOW() - make_interval(mins => $2)`, [STUCK_ATTEMPTS, STALE_PROCESSING_MINUTES]);
  const claimed = await pool.query(`UPDATE dr_hubla_events SET status = 'processing', locked_at = NOW(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM dr_hubla_events
      WHERE ($2::bigint IS NULL OR id = $2) AND ((status = ANY($3::text[]) AND next_attempt_at <= NOW())
        OR (status = 'processing' AND locked_at < NOW() - make_interval(mins => $4)))
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,
  [limit, options.id || null, RETRYABLE, STALE_PROCESSING_MINUTES]);
  const summary = { claimed: claimed.rows.length };
  for (const row of claimed.rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    const status = await processRow(pool, row, config, hooks);
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}
function startHublaWorker(pool, hooks, options = {}) {
  const interval = Math.max(1000, Number(options.intervalMs) || DEFAULT_WORKER_INTERVAL_MS);
  let running = false, again = false, stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; if ((await processHublaQueue(pool, hooks)).claimed === 25) again = true; } while (again && !stopped);
    } catch { console.error("Hubla worker tick failed"); }
    finally { running = false; }
  };
  // Produtos recem-configurados: avisos antes sem mapeamento voltam para a fila a cada inicializacao.
  pool.query("UPDATE dr_hubla_events SET next_attempt_at = NOW(), status = 'unmapped_product' WHERE status = 'unmapped_product'")
    .catch(() => console.error("Hubla worker: falha ao reabrir avisos sem produto")).finally(() => {
      const first = setTimeout(tick, 1000); if (first.unref) first.unref();
    });
  const timer = setInterval(tick, interval); if (timer.unref) timer.unref();
  const stop = () => { stopped = true; clearInterval(timer); };
  stop.kick = () => { setImmediate(tick); };
  return stop;
}
const PUBLIC_COLUMNS = `id, sandbox, event_type, invoice_id, invoice_status, invoice_version, status, reason_code, reason,
  kind, amount, canonical_order_id, attempts, next_attempt_at, received_at, processed_at`;
function registerHublaRoutes(app, pool, hooks, runtime = {}) {
  const fail = (res, error) => res.status(error.statusCode || 500).json({ ok: false, error: error.statusCode ? error.message : "erro interno" });
  app.post(ENDPOINT, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const config = hublaConfig();
    if (!config.token) return res.status(503).json({ ok: false, error: "receptor Hubla nao configurado" });
    if (!tokenMatches(config.token, req.get("x-hubla-token"))) return res.status(401).json({ ok: false, error: "nao autorizado" });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string" || !clean(body.type, 100)) {
      return res.status(400).json({ ok: false, error: "aviso invalido" });
    }
    try {
      // O ACK so sai depois da gravacao duravel; o processamento acontece fora da requisicao.
      const stored = await storeHublaEvent(pool, body, { idempotency: req.get("x-hubla-idempotency"), sandbox: req.get("x-hubla-sandbox") });
      res.status(200).json({ ok: true, received: true, duplicate: !stored.inserted });
      if (stored.inserted && runtime.kick) runtime.kick();
    } catch (error) {
      console.error("Hubla webhook: falha ao persistir aviso (" + (error.code || "erro interno") + ")");
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });
  app.get("/api/integrations/hubla/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    try {
      const config = hublaConfig();
      const rows = (await pool.query(`SELECT sandbox, status, COUNT(*)::int AS events, MAX(received_at) AS last_received_at
        FROM dr_hubla_events GROUP BY sandbox, status`)).rows;
      // Pagamentos recebidos da Hubla que ainda nao entraram no funil (uma linha por fatura).
      const waiting = (await pool.query(`SELECT COUNT(*)::int AS invoices, COALESCE(SUM(amount), 0)::numeric AS value FROM (
        SELECT h.invoice_id, MAX(h.amount) AS amount FROM dr_hubla_events h
        WHERE h.sandbox = FALSE AND h.invoice_id IS NOT NULL AND h.status = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM dr_funnel_orders f WHERE f.order_id = 'hubla:' || h.invoice_id)
        GROUP BY h.invoice_id) pending`, [PENDING_MONEY])).rows[0];
      // Reembolsos/chargebacks recebidos que ainda nao foram descontados (aguardando, em revisao ou com falha).
      const reversals = (await pool.query(`SELECT COUNT(DISTINCT invoice_id)::int AS invoices FROM dr_hubla_events
        WHERE sandbox = FALSE AND invoice_status IN ('refunded','chargeback') AND status = ANY($1::text[])`,
      [[...PENDING_MONEY, "pending_refund_confirmation"]])).rows[0];
      const side = sandbox => {
        const mine = rows.filter(r => r.sandbox === sandbox), by = {};
        for (const r of mine) by[r.status] = r.events;
        const last = mine.map(r => r.last_received_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
        return { events: mine.reduce((sum, r) => sum + r.events, 0), by_status: by, last_received_at: last };
      };
      const live = side(false), count = kind => [...config.kinds.values()].filter(k => k === kind).length;
      res.json({ ok: true, provider: "hubla", endpoint: ENDPOINT, auth_header: "x-hubla-token",
        token_configured: Boolean(config.token), click_id_param: config.clickParam,
        products_configured: { front: count("front"), mentorship: count("mentorship"), bump: count("bump") },
        required_events: REQUIRED_EVENTS,
        // Conexao real = pelo menos um aviso autenticado fora do sandbox. Testes nao contam.
        provider_connected: live.events > 0, live, sandbox: side(true),
        payments_not_integrated: { invoices: waiting.invoices, known_value: Number(waiting.value) },
        reversals_not_integrated: { invoices: reversals.invoices } });
    } catch (error) { fail(res, error); }
  });
  app.get("/api/integrations/hubla/events", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    try {
      const status = clean(req.query.status, 40), limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const sandbox = req.query.sandbox == null ? null : isSandbox(req.query.sandbox);
      // Sem payload e sem dados pessoais: somente o necessario para auditar pendencias.
      res.json({ ok: true, events: (await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM dr_hubla_events
        WHERE ($1::text IS NULL OR status = $1) AND ($2::boolean IS NULL OR sandbox = $2) ORDER BY id DESC LIMIT $3`,
      [status, sandbox, limit])).rows });
    } catch (error) { fail(res, error); }
  });
  app.post("/api/integrations/hubla/process", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.json({ ok: true, summary: await processHublaQueue(pool, hooks) }); } catch (error) { fail(res, error); }
  });
  app.post("/api/integrations/hubla/events/:id/retry", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "id invalido" });
      const reopened = await pool.query(`UPDATE dr_hubla_events SET status = 'received', next_attempt_at = NOW(), attempts = 0, updated_at = NOW()
        WHERE id = $1 AND sandbox = FALSE AND status = ANY($2::text[]) RETURNING id`, [req.params.id, [...RETRYABLE, "needs_review"]]);
      if (!reopened.rows.length) return res.status(409).json({ ok: false, error: "aviso inexistente ou ja concluido" });
      await processHublaQueue(pool, hooks, { id: req.params.id });
      await processHublaQueue(pool, hooks); // avisos relacionados reabertos pelo pedido recem-integrado
      res.json({ ok: true, event: (await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM dr_hubla_events WHERE id = $1`, [req.params.id])).rows[0] });
    } catch (error) { fail(res, error); }
  });
  // Reembolso sem valor no aviso (possivel parcial): um responsavel informa o valor conferido na Hubla.
  app.post("/api/integrations/hubla/events/:id/resolve-refund", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      if (!/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "id invalido" });
      const raw = req.body?.value;
      const value = typeof raw === "number" || (typeof raw === "string" && /^\d+(\.\d{1,2})?$/.test(raw.trim())) ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        return res.status(400).json({ ok: false, error: "value em reais, positivo, com ate duas casas" });
      }
      const row = (await pool.query(`SELECT * FROM dr_hubla_events WHERE id = $1 AND sandbox = FALSE
        AND status = 'needs_review' AND reason_code = 'refund_unconfirmed'`, [req.params.id])).rows[0];
      if (!row) return res.status(409).json({ ok: false, error: "aviso nao esta aguardando valor de reembolso" });
      const sale = interpretInvoice(row.payload, hublaConfig()).sale;
      if (!sale || !sale.refunded_at || !(await ledgerOrder(pool, sale.order_id))) return res.status(409).json({ ok: false, error: "pedido original nao integrado" });
      const result = await applyReversal(pool, sale, hooks, new Date(), "refunded", Math.round(value * 100) / 100);
      if (result.status === "processed") await finishRow(pool, row, { ...result, reason: "reembolso com valor informado manualmente" });
      res.status(result.status === "processed" ? 200 : 409).json({ ok: result.status === "processed", status: result.status, reason: result.reason });
    } catch (error) { fail(res, error); }
  });
}
module.exports = { ENDPOINT, REQUIRED_EVENTS, REFUND_GRACE_MS, hublaConfig, tokenMatches, isSandbox, looksLikeTest, sanitizePayload,
  idempotencyKey, envelope, interpretInvoice, clickFromSession, initHublaDb, storeHublaEvent, processHublaEvent,
  processHublaQueue, startHublaWorker, registerHublaRoutes };

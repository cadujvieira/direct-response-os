const crypto = require("crypto");
const { requireAdmin } = require("./trackingHealth");
const { invalid, text, amount, writeTrackingEvent } = require("./trackingIngestion");

const PAID = new Map([["purchase", "front"], ["mentorship_purchase", "mentorship"], ["order_bump_purchase", "bump"]]);
const CALLS = new Set(["call_booked", "call_attended", "call_no_show", "mentorship_offer"]);
const FIELDS = new Set(["event_name", "event_id", "order_id", "front_order_id", "click_id", "email",
  "telefone", "nome", "produto", "value", "currency", "occurred_at", "payment_status"]);
function normalizeFunnelEvent(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("payload invalido");
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) invalid("campo desconhecido: " + key);
  const name = text(input.event_name, "event_name", 100, true);
  if (!PAID.has(name) && !CALLS.has(name) && !["checkout_started", "refund"].includes(name)) invalid("evento do funil invalido");
  const monetary = PAID.has(name) || name === "refund";
  const timestamp = text(input.occurred_at, "occurred_at", 40, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) invalid("occurred_at exige data, hora e fuso");
  const calendar = new Date(timestamp.slice(0, 10) + "T00:00:00Z"), occurred = new Date(timestamp);
  if (!Number.isFinite(occurred.getTime()) || !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== timestamp.slice(0, 10) || occurred.getTime() > now.getTime() + 300000) invalid("occurred_at invalido ou no futuro");
  const orderId = text(input.order_id, "order_id", 100, monetary);
  let frontId = text(input.front_order_id, "front_order_id", 100, PAID.get(name) === "mentorship" || PAID.get(name) === "bump" || CALLS.has(name));
  if (name === "purchase") {
    if (frontId && frontId !== orderId) invalid("pedido front nao pode apontar para outro pedido");
    frontId = orderId;
  }
  if (!monetary && name !== "checkout_started" && orderId) invalid("use front_order_id para eventos de call");
  if (name === "checkout_started" && (orderId || frontId)) invalid("checkout_started usa click_id; pedido pago ainda nao existe");
  const externalId = text(input.event_id, "event_id", 100, !PAID.has(name));
  const clickId = text(input.click_id, "click_id", 200, name === "purchase" || name === "checkout_started");
  const email = text(input.email, "email", 254)?.toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid("email invalido");
  const rawPhone = text(input.telefone, "telefone", 40);
  const phone = rawPhone?.replace(/[^0-9]/g, "") || null;
  if (phone && !/^\d{8,15}$/.test(phone)) invalid("telefone invalido");
  if (name === "purchase" && !email && !phone) invalid("compra front exige email ou telefone do comprador");
  const currency = monetary ? text(input.currency, "currency", 3, true)?.toUpperCase() : "BRL";
  if (currency !== "BRL") invalid("integracao do funil exige valores em BRL");
  const value = monetary ? amount(input.value, "value", true) : 0;
  if (!monetary && input.value != null && amount(input.value, "value") !== 0) invalid("evento de call/checkout nao registra receita");
  if (PAID.has(name) && input.payment_status !== "approved") invalid("registre receita somente com payment_status approved");
  // chargeback = estorno definitivo pela operadora; desconta como reembolso confirmado, nunca disputa em aberto.
  if (name === "refund" && !["refunded", "chargeback"].includes(input.payment_status)) invalid("registre somente reembolso confirmado (refunded) ou chargeback definitivo");
  const key = PAID.has(name) ? [name, orderId] : [name, name === "refund" ? orderId : frontId || clickId, externalId];
  const eventId = name === "purchase" ? "purchase_" + orderId : "funnel_" + crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex");
  return { event_name: name, event_id: eventId, source_event_id: externalId, order_id: orderId,
    front_order_id: frontId, click_id: clickId, email, telefone: phone,
    nome: text(input.nome, "nome", 200), produto: text(input.produto, "produto", 300),
    value, currency, occurred_at: occurred.toISOString(), payment_status: input.payment_status || null };
}
function eventFingerprint(event) {
  return crypto.createHash("sha256").update(JSON.stringify([event.event_name, event.order_id,
    event.front_order_id, event.click_id, event.value, event.currency, event.occurred_at])).digest("hex");
}
async function initFunnelDb(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dr_funnel_orders (
    order_id TEXT PRIMARY KEY REFERENCES dr_orders(order_id),
    kind TEXT NOT NULL CHECK (kind IN ('front','mentorship','bump')),
    front_order_id TEXT NOT NULL REFERENCES dr_orders(order_id),
    currency TEXT NOT NULL CHECK (currency = 'BRL'),
    paid_event_id TEXT NOT NULL UNIQUE REFERENCES dr_events(event_id),
    lead_id INTEGER NOT NULL REFERENCES dr_leads(id),
    paid_at TIMESTAMPTZ NOT NULL,
    refunded_value NUMERIC NOT NULL DEFAULT 0 CHECK (refunded_value >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dr_funnel_receipts (
    event_id TEXT PRIMARY KEY REFERENCES dr_events(event_id),
    payload_hash TEXT NOT NULL, event_name TEXT NOT NULL,
    order_id TEXT, front_order_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS dr_funnel_orders_front_idx ON dr_funnel_orders(front_order_id)");
}
async function managedOrder(client, orderId) {
  return (await client.query(`SELECT f.*, o.click_id, o.email, o.telefone, o.valor
    FROM dr_funnel_orders f JOIN dr_orders o ON o.order_id = f.order_id
    WHERE f.order_id = $1`, [orderId])).rows[0] || null;
}
async function ensureLead(client, event, linkedLeadId = null) {
  if (linkedLeadId) {
    const lead = (await client.query("SELECT id FROM dr_leads WHERE id = $1 FOR UPDATE", [linkedLeadId])).rows[0];
    if (!lead) invalid("comprador original nao encontrado", 409);
    return lead.id;
  }
  const find = async () => (await client.query(`SELECT id FROM dr_leads WHERE
    ($1::text IS NOT NULL AND click_id = $1) OR ($2::text IS NOT NULL AND LOWER(email) = $2)
    OR ($3::text IS NOT NULL AND regexp_replace(telefone, '[^0-9]', '', 'g') = $3)
    ORDER BY id FOR UPDATE`, [event.click_id, event.email, event.telefone])).rows;
  let leads = await find();
  if (leads.length > 1) invalid("identidade ambigua: email, telefone ou click_id apontam para leads diferentes", 409);
  if (leads[0]) return leads[0].id;
  if (!event.email && !event.telefone) return null;
  await client.query(`INSERT INTO dr_leads (click_id,nome,email,telefone,status,utm_source,utm_medium,utm_campaign,utm_content)
    SELECT $1,$2,$3,$4,'lead',utm_source,utm_medium,utm_campaign,utm_content FROM dr_clicks WHERE click_id = $1
    ON CONFLICT DO NOTHING`, [event.click_id, event.nome, event.email, event.telefone]);
  leads = await find();
  if (leads.length !== 1) invalid("nao foi possivel vincular um unico comprador", 409);
  return leads[0].id;
}
async function ingestFunnelEvent(pool, event, hooks) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["funnel-event:" + event.event_id]);
    if (event.order_id) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["funnel-order:" + event.order_id]);
    let sourceOrder = null;
    if (event.event_name === "refund") sourceOrder = await managedOrder(client, event.order_id);
    else if (event.event_name !== "purchase" && event.front_order_id) sourceOrder = await managedOrder(client, event.front_order_id);
    if (event.event_name === "refund" || CALLS.has(event.event_name) || ["mentorship_purchase","order_bump_purchase"].includes(event.event_name)) {
      if (!sourceOrder) invalid("pedido original ainda nao foi integrado; reenvie depois da compra front", 409);
      if (event.event_name !== "refund" && sourceOrder.kind !== "front") invalid("front_order_id deve identificar uma compra front", 409);
      if (event.front_order_id && event.front_order_id !== sourceOrder.front_order_id) invalid("front_order_id diverge do pedido original", 409);
      if (event.click_id && event.click_id !== sourceOrder.click_id) invalid("click_id diverge da aquisicao original", 409);
      event.click_id = sourceOrder.click_id; event.front_order_id = sourceOrder.front_order_id;
      event.email = sourceOrder.email; event.telefone = sourceOrder.telefone;
      if (new Date(event.occurred_at) < new Date(sourceOrder.paid_at)) invalid("evento posterior nao pode ocorrer antes do pagamento original", 409);
    }
    const click = (await client.query("SELECT click_id FROM dr_clicks WHERE click_id = $1", [event.click_id])).rows[0];
    if (!click) invalid("click_id nao encontrado; preserve o ID capturado na entrada do funil", 422);
    const hash = eventFingerprint(event);
    const receipt = (await client.query("SELECT payload_hash FROM dr_funnel_receipts WHERE event_id = $1", [event.event_id])).rows[0];
    if (receipt) {
      if (receipt.payload_hash !== hash) invalid("evento ja integrado com dados diferentes", 409);
      await client.query("COMMIT");
      return { duplicate: true, event_id: event.event_id, order_id: event.order_id, front_order_id: event.front_order_id };
    }
    if (event.event_name === "refund" && Math.round((Number(sourceOrder.refunded_value) + event.value) * 100) > Math.round(Number(sourceOrder.valor) * 100)) {
      invalid("reembolsos acumulados excedem o valor pago deste pedido", 409);
    }
    event.raw_payload = { integration: "funnel_v1", source_event_id: event.source_event_id,
      order_id: event.order_id, front_order_id: event.front_order_id, occurred_at: event.occurred_at,
      payment_status: event.payment_status };
    // A refund references an existing order; other paid events create their own order.
    const write = { ...event, order_id: PAID.has(event.event_name) ? event.order_id : null };
    let leadId;
    await writeTrackingEvent(client, write, hooks, { repairDuplicate: true, beforeEffects: async payload => {
      leadId = await ensureLead(client, event, sourceOrder?.lead_id);
      payload.lead_id = leadId;
    } });
    if (PAID.has(event.event_name)) {
      if (!leadId) invalid("comprador do pedido nao identificado", 409);
      const existing = await managedOrder(client, event.order_id);
      if (existing && (existing.kind !== PAID.get(event.event_name) || existing.front_order_id !== event.front_order_id)) invalid("pedido ja integrado com tipo ou origem diferente", 409);
      await client.query(`INSERT INTO dr_funnel_orders (order_id,kind,front_order_id,currency,paid_event_id,lead_id,paid_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id) DO NOTHING`,
      [event.order_id, PAID.get(event.event_name), event.front_order_id, event.currency, event.event_id, leadId, event.occurred_at]);
    } else if (event.event_name === "refund") {
      const refunded = Math.round((Number(sourceOrder.refunded_value) + event.value) * 100) / 100;
      await client.query("UPDATE dr_funnel_orders SET refunded_value = $1 WHERE order_id = $2", [refunded, event.order_id]);
      await client.query("UPDATE dr_orders SET status = $1 WHERE order_id = $2",
        [refunded === Number(sourceOrder.valor) ? "refunded" : "partially_refunded", event.order_id]);
    }
    await client.query(`INSERT INTO dr_funnel_receipts (event_id,payload_hash,event_name,order_id,front_order_id)
      VALUES ($1,$2,$3,$4,$5)`, [event.event_id, hash, event.event_name, event.order_id, event.front_order_id]);
    await client.query("COMMIT");
    return { duplicate: false, event_id: event.event_id, order_id: event.order_id, front_order_id: event.front_order_id };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
function registerFunnelRoutes(app, pool, hooks) {
  app.get("/api/integrations/funnel/status", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    res.set("Cache-Control", "no-store");
    try {
      const stats = (await pool.query(`SELECT COUNT(*)::int AS integrated_events,
        MAX(created_at) AS last_received_at FROM dr_funnel_receipts`)).rows[0];
      res.json({ ok:true, schema_version:1, endpoint:"/api/integrations/funnel/events",
        provider_connected:false, mode:"canonical_server_api", ...stats });
    } catch { res.status(500).json({ ok:false,error:"erro interno" }); }
  });
  app.post("/api/integrations/funnel/events", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    res.set("Cache-Control", "no-store");
    try { res.json({ ok:true, ...await ingestFunnelEvent(pool, normalizeFunnelEvent(req.body), hooks) }); }
    catch (error) { res.status(error.statusCode || 500).json({ ok:false,
      error:error.statusCode ? error.message : "erro interno" }); }
  });
}
module.exports = { normalizeFunnelEvent, eventFingerprint, initFunnelDb, ingestFunnelEvent, registerFunnelRoutes };

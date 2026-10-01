const crypto = require("crypto");

function invalid(message, statusCode = 400) {
  const error = new Error(message); error.statusCode = statusCode; throw error;
}
function text(value, field, max = 200, required = false) {
  if (value == null || value === "") {
    if (required) invalid(field + " obrigatorio");
    return null;
  }
  if (typeof value !== "string") invalid(field + " deve ser texto");
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) invalid(field + " invalido");
  return result;
}
function amount(value, field, positive = false) {
  if (typeof value !== "number" && typeof value !== "string") invalid(field + " deve ser numerico");
  if (typeof value === "string" && !/^-?\d+(\.\d{1,2})?$/.test(value.trim())) invalid(field + " invalido");
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 10000000 || (positive && result <= 0)) invalid(field + " invalido");
  if (Math.abs(result * 100 - Math.round(result * 100)) > 0.000001) invalid(field + " deve ter no maximo duas casas decimais");
  return Math.round(result * 100) / 100;
}
function normalizeTracking(input = {}, purchase = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("payload invalido");
  const orderId = purchase ? text(input.order_id, "order_id", 100, true) : null;
  const email = text(input.email, "email", 254)?.toLowerCase() || null;
  const phone = text(input.telefone, "telefone", 40);
  const currency = (text(input.currency, "currency", 3) || "BRL").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) invalid("currency invalida");
  return { event_id: purchase ? "purchase_" + orderId : text(input.event_id, "event_id", 200) || crypto.randomUUID(),
    click_id: text(input.click_id, "click_id"), email, telefone: phone,
    event_name: purchase ? "purchase" : text(input.event_name, "event_name", 100, true),
    value: amount((purchase ? input.valor : input.value) ?? 0, purchase ? "valor" : "value", purchase),
    currency, order_id: orderId, produto: purchase ? text(input.produto, "produto", 300) : null,
    raw_payload: input, occurred_at: null };
}
function sameEvent(stored, input) {
  return stored.event_name === input.event_name && (stored.click_id || null) === (input.click_id || null) &&
    Number(stored.value) === input.value && stored.currency === input.currency &&
    (!input.occurred_at || new Date(stored.created_at).getTime() === new Date(input.occurred_at).getTime());
}
async function writeTrackingEvent(client, input, hooks, options = {}) {
  let order = null;
  if (input.order_id && input.event_name !== "refund") {
    const inserted = await client.query(`INSERT INTO dr_orders
      (order_id, click_id, email, telefone, produto, valor, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'paid',COALESCE($7::timestamptz AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'))
      ON CONFLICT (order_id) DO NOTHING RETURNING id, order_id, click_id, produto, valor, status`,
    [input.order_id, input.click_id, input.email, input.telefone, input.produto, input.value, input.occurred_at]);
    order = inserted.rows[0] || (await client.query(`SELECT id, order_id, click_id, produto, valor, status
      FROM dr_orders WHERE order_id = $1 FOR UPDATE`, [input.order_id])).rows[0];
    if (!order || Number(order.valor) !== input.value || (order.click_id || null) !== (input.click_id || null)) {
      invalid("order_id ja utilizado com valor ou atribuicao diferente", 409);
    }
  }
  const inserted = await client.query(`INSERT INTO dr_events
    (event_id, click_id, email, telefone, event_name, value, currency, raw_payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'))
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id, event_id, click_id, event_name, value, currency, created_at AT TIME ZONE 'UTC' AS created_at`,
  [input.event_id, input.click_id, input.email, input.telefone, input.event_name, input.value,
    input.currency, JSON.stringify(input.raw_payload), input.occurred_at]);
  const event = inserted.rows[0] || (await client.query(`SELECT id, event_id, click_id, event_name, value,
    currency, created_at AT TIME ZONE 'UTC' AS created_at FROM dr_events WHERE event_id = $1`, [input.event_id])).rows[0];
  if (!event || !sameEvent(event, input)) invalid("event_id ja utilizado com dados diferentes", 409);
  if (inserted.rows.length || options.repairDuplicate) {
    // Both effects share the same transaction as the financial/event writes.
    if (options.beforeEffects) await options.beforeEffects(input);
    await hooks.syncLeadCrmFromEvent(null, input, { client });
    await hooks.enqueueAutomationEvent(client, { ...input, created_at: event.created_at });
  }
  return { duplicate: !inserted.rows.length, order, event };
}
async function ingestTracking(pool, input, hooks) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await writeTrackingEvent(client, input, hooks);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
module.exports = { invalid, text, amount, normalizeTracking, sameEvent, writeTrackingEvent, ingestTracking };

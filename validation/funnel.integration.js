// Run against a fresh, isolated application + PostgreSQL database only.
// No dotenv: these explicit validation variables never fall back to real secrets/DBs.
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
  const secret = process.env.DR_VALIDATION_ADMIN_SECRET;
  assert(secret && secret.startsWith("funnel-validation-"));
  const pool = new Pool({ connectionString: dbUrl.href, ssl: false });
  const prefix = "qa" + crypto.randomBytes(5).toString("hex");
  let groups = 0;
  const pass = label => { groups++; console.log("PASS " + label); };
  const request = async (path, body, status = 200, auth = true, method) => {
    const response = await fetch(new URL(path, base), {
      method: method || (body == null ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(auth ? { "x-admin-secret": secret } : {}) },
      ...(body == null ? {} : { body: JSON.stringify(body) })
    });
    const json = await response.json();
    assert.equal(response.status, status, path + ": " + JSON.stringify(json));
    return json;
  };
  const post = (body, status = 200) => request("/api/integrations/funnel/events", body, status);
  const scalar = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);
  const stage = async click => (await pool.query("SELECT lifecycle_stage FROM dr_leads WHERE click_id=$1", [click])).rows[0]?.lifecycle_stage;
  const now = new Date();
  const todayTime = new Date(now.getTime() - 60000).toISOString();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  const from = month.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const time = day => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day, 15)).toISOString();
  const params = "?from=" + from + "&to=" + to;
  const front = (n, click, occurred = time(2)) => ({ event_name: "purchase", order_id: prefix + ":front:" + n,
    click_id: click, email: prefix + "." + n + "@example.test", nome: "Comprador QA",
    produto: "Front QA", value: 297, currency: "BRL", payment_status: "approved", occurred_at: occurred });
  const refund = (order, id, value) => ({ event_name: "refund", order_id: order,
    event_id: prefix + ":refund:" + id, value, currency: "BRL", payment_status: "refunded", occurred_at: time(20) });
  try {
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events"), 0, "Use um banco novo e vazio de eventos");
    await request("/health");
    await request("/api/integrations/funnel/status", null, 401, false);
    await request("/api/integrations/funnel/events", {}, 401, false);
    assert.equal((await request("/api/integrations/funnel/status")).provider_connected, false);
    // Prove the HTTP application sees this exact disposable database before HTTP writes.
    await pool.query("INSERT INTO dr_experiments(slug,name,active) VALUES($1,$2,FALSE)", [prefix, "Validation marker " + prefix]);
    assert(JSON.stringify(await request("/api/admin/experiments")).includes("Validation marker " + prefix),
      "A API HTTP deve estar conectada ao mesmo banco isolado");
    await request("/api/experiments/" + prefix, { name: "Homologacao funil", active: true,
      variants: [{ name: "Unica", destination_url: "https://example.test/checkout", weight: 100, active: true }] }, 200, true, "PUT");
    const clicks = [];
    const capture = async n => {
      const query = new URLSearchParams({ utm_source: "meta", utm_medium: "paid", utm_campaign: prefix,
        campaign_id: prefix + "campaign", adset_id: prefix + "adset", ad_id: prefix + "ad", visitor_id: prefix + n });
      const response = await fetch(new URL("/go/" + prefix + "?" + query, base), { redirect: "manual" });
      assert.equal(response.status, 302);
      const destination = new URL(response.headers.get("location"));
      const click = destination.searchParams.get("click_id");
      assert(click && click.length > 10);
      for (const field of ["campaign_id", "adset_id", "ad_id", "utm_source"]) assert.equal(destination.searchParams.get(field), query.get(field));
      return click;
    };
    for (let n = 0; n < 30; n++) clicks.push(await capture(n));
    assert.equal(new Set(clicks).size, 30);
    // Age only the synthetic captures to build a closed, mature reporting cohort.
    await pool.query("UPDATE dr_clicks SET created_at=$1::timestamptz AT TIME ZONE 'UTC' WHERE click_id=ANY($2::text[])", [time(2), clicks]);
    pass("autenticacao, status honesto e router preservando click/IDs de midia");

    await post({ event_name: "checkout_started", event_id: prefix + ":checkout", click_id: clicks[0],
      email: front(0, clicks[0]).email, occurred_at: time(2) });
    assert.equal(await stage(clicks[0]), "checkout");
    for (let n = 0; n < 30; n++) await post(front(n, clicks[n]));
    assert.equal(await stage(clicks[0]), "customer");
    const repeated = await Promise.all(Array.from({ length: 10 }, (_, n) => post({ ...front(0, clicks[0]), event_id: "delivery-" + n })));
    assert(repeated.every(r => r.duplicate));
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders"), 30);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_lead_crm_history WHERE note='evento: purchase'"), 30);
    const paidId = "purchase_" + front(0, clicks[0]).order_id;
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_automation_runs WHERE source_event_id=$1", [paidId]), 1);
    await post({ ...front(0, clicks[0]), value: 298 }, 409);
    await post({ ...front(0, clicks[1]) }, 409);
    await post({ ...front(0, clicks[0]), occurred_at: time(3) }, 409);
    await post({ ...front("unknown", "missing-click") }, 422);
    await post({ ...front("pending", clicks[0]), payment_status: "pending" }, 400);
    await post({ ...front("usd", clicks[0]), currency: "USD" }, 400);
    const identity = front("ambiguous", clicks[0]); identity.email = front(1, clicks[1]).email;
    await post(identity, 409);
    pass("30 compras R$297, reenvios concorrentes, conflitos e identidade ambigua");

    const firstOrder = front(0, clicks[0]).order_id;
    const call = { event_name: "call_booked", event_id: prefix + ":call", front_order_id: firstOrder, occurred_at: time(5) };
    await post(call); assert.equal(await stage(clicks[0]), "call_booked");
    await post({ ...call, event_name: "call_attended", occurred_at: time(7) });
    await post({ ...call, event_name: "mentorship_offer", occurred_at: time(8) });
    assert.equal(await stage(clicks[0]), "mentorship_opportunity");
    assert((await post(call)).duplicate);
    await post({ ...call, event_id: "unknown-front", front_order_id: "missing-front" }, 409);
    await post({ ...call, event_id: "wrong-click", click_id: clicks[1] }, 409);
    await post({ ...call, event_id: "too-early", occurred_at: time(1) }, 409);
    const mentors = [];
    for (let n = 0; n < 3; n++) {
      const mentor = { event_name: "mentorship_purchase", order_id: prefix + ":mentor:" + n,
        front_order_id: front(n, clicks[n]).order_id, value: 5000, currency: "BRL", payment_status: "approved", occurred_at: time(17) };
      mentors.push(mentor); await post(mentor);
      assert((await post({ ...mentor, event_id: "new-delivery" })).duplicate);
    }
    assert.equal(await stage(clicks[0]), "mentorship_customer");
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_name='purchase'"), 30);
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_name='mentorship_purchase'"), 3);
    await request("/api/crm/leads");
    const lead = (await pool.query("SELECT id FROM dr_leads WHERE click_id=$1", [clicks[1]])).rows[0];
    // Manual CRM changes must not break immutable post-purchase identity/origin.
    await pool.query("UPDATE dr_leads SET click_id=NULL,email=$1 WHERE id=$2", [prefix + ".edited@example.test", lead.id]);
    const boundCall = await post({ ...call, event_name: "call_attended", event_id: "edited-contact-call",
      front_order_id: front(1, clicks[1]).order_id, occurred_at: time(18) });
    assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_automation_runs WHERE source_event_id=$1 AND lead_id=$2", [boundCall.event_id, lead.id]), 1);
    await pool.query("UPDATE dr_leads SET click_id=$1,email=$2 WHERE id=$3", [clicks[1], front(1, clicks[1]).email, lead.id]);
    await request("/api/crm/leads/" + lead.id + "/timeline");
    pass("calls, mentoria, CRM e automacoes vinculados ao comprador original");

    const partial = refund(mentors[0].order_id, "partial", 300);
    const partialResults = await Promise.all(Array.from({ length: 8 }, () => post(partial)));
    assert.equal(partialResults.filter(r => !r.duplicate).length, 1);
    assert.equal((await pool.query("SELECT status FROM dr_orders WHERE order_id=$1", [mentors[0].order_id])).rows[0].status, "partially_refunded");
    const races = await Promise.all([150, 200].map((value, n) =>
      fetch(new URL("/api/integrations/funnel/events", base), { method: "POST", headers: { "Content-Type": "application/json", "x-admin-secret": secret },
        body: JSON.stringify(refund(firstOrder, "race" + n, value)) }).then(async r => ({ status: r.status, body: await r.json() }))));
    assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
    const refunded = Number((await pool.query("SELECT refunded_value FROM dr_funnel_orders WHERE order_id=$1", [firstOrder])).rows[0].refunded_value);
    assert(refunded === 150 || refunded === 200);
    await post(refund(firstOrder, "remaining", 297 - refunded));
    await post(refund(firstOrder, "over", 0.01), 409);
    await post({ ...partial, value: 301 }, 409);
    assert.equal((await pool.query("SELECT status FROM dr_orders WHERE order_id=$1", [firstOrder])).rows[0].status, "refunded");
    assert.equal(await stage(clicks[0]), "refunded");
    assert.equal(await scalar("SELECT SUM(value) AS n FROM dr_events WHERE event_name='refund'"), 597);
    pass("refund parcial, integral, duplicado e concorrente sem exceder o pagamento");

    const rollbackClick = await capture("rollback");
    const rollbackFront = front("rollback", rollbackClick, todayTime);
    const legacyClick = await capture("legacy");
    const legacyEmail = prefix + ".legacy@example.test";
    await request("/track/lead", { click_id: legacyClick, email: legacyEmail, nome: "Lead QA" });
    const legacyOrder = prefix + ":legacy";
    const failures = ["purchase_" + rollbackFront.order_id, "purchase_" + legacyOrder];
    await pool.query(`CREATE FUNCTION ${prefix}_fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_event_id = ANY(ARRAY['${failures[0]}','${failures[1]}']) THEN RAISE EXCEPTION 'QA queue failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${prefix}_queue BEFORE INSERT ON dr_automation_runs FOR EACH ROW EXECUTE FUNCTION ${prefix}_fail_queue()`);
    try {
      await post(rollbackFront, 500);
      const legacy = { order_id: legacyOrder, click_id: legacyClick, email: legacyEmail, valor: 297 };
      await request("/track/purchase", legacy, 500);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders WHERE order_id=ANY($1::text[])", [[rollbackFront.order_id, legacyOrder]]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_id=ANY($1::text[])", [failures]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_funnel_receipts WHERE event_id=ANY($1::text[])", [failures]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_leads WHERE email=$1", [rollbackFront.email]), 0);
      assert.equal(await stage(legacyClick), "lead");
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_lead_crm_history h JOIN dr_leads l ON l.id=h.lead_id WHERE l.click_id=$1 AND h.note='evento: purchase'", [legacyClick]), 0);
    } finally {
      await pool.query(`DROP TRIGGER ${prefix}_queue ON dr_automation_runs`);
      await pool.query(`DROP FUNCTION ${prefix}_fail_queue()`);
    }
    const firstConcurrent = await Promise.all(Array.from({ length: 10 }, () => post(rollbackFront)));
    assert.equal(firstConcurrent.filter(r => !r.duplicate).length, 1);
    const legacy = { order_id: legacyOrder, click_id: legacyClick, email: legacyEmail, valor: 297 };
    await request("/track/purchase", legacy);
    assert((await request("/track/purchase", legacy)).duplicate);
    await request("/track/purchase", { ...legacy, valor: 298 }, 409);
    const legacyCall = { event_name: "call_booked", event_id: prefix + ":legacy-call", click_id: legacyClick, email: legacyEmail };
    await request("/track/event", legacyCall);
    assert((await request("/track/event", legacyCall)).duplicate);
    await request("/track/event", { ...legacyCall, event_name: "refund" }, 409);
    pass("falha na fila reverte pedido/evento/CRM/lead/recibo; retry e rotas legadas");

    const auditClick = await capture("audit");
    const auditFront = front("audit", auditClick, todayTime);
    await pool.query(`CREATE FUNCTION ${prefix}_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.note='evento: purchase' THEN RAISE EXCEPTION 'QA audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${prefix}_audit BEFORE INSERT ON dr_lead_crm_history FOR EACH ROW EXECUTE FUNCTION ${prefix}_fail_audit()`);
    try {
      await post(auditFront, 500);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_orders WHERE order_id=$1", [auditFront.order_id]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_events WHERE event_id=$1", ["purchase_" + auditFront.order_id]), 0);
      assert.equal(await scalar("SELECT COUNT(*)::int AS n FROM dr_leads WHERE email=$1", [auditFront.email]), 0);
    } finally {
      await pool.query(`DROP TRIGGER ${prefix}_audit ON dr_lead_crm_history`);
      await pool.query(`DROP FUNCTION ${prefix}_fail_audit()`);
    }
    await post(auditFront);
    pass("falha na auditoria CRM tambem reverte todas as gravacoes");

    // Synthetic local UTMify snapshot; no provider credentials or external calls.
    await pool.query("INSERT INTO dr_utmify_connection(id,dashboard_id,currency) VALUES(1,$1,'BRL') ON CONFLICT(id) DO UPDATE SET dashboard_id=EXCLUDED.dashboard_id,currency='BRL'", [prefix]);
    const sync = (await pool.query("INSERT INTO dr_utmify_syncs(dashboard_id,date_from,date_to,levels,status,finished_at) VALUES($1,$2,$3,'[\"campaign\",\"adset\",\"ad\"]','completed',NOW()) RETURNING id", [prefix, from, to])).rows[0].id;
    for (const level of ["campaign", "adset", "ad"]) await pool.query(`INSERT INTO dr_utmify_ad_objects(sync_id,level,object_id,campaign_id,adset_id,ad_id,name,metrics)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [sync, level, prefix + level,
      prefix + "campaign", level === "campaign" ? null : prefix + "adset", level === "ad" ? prefix + "ad" : null,
      "Midia QA", JSON.stringify({ spend: 6000, purchases: 30, revenue: 8910 })]);
    const ltv = (await request("/api/revenue/ltv" + params)).ltv;
    assert.equal(Number(ltv.front_purchases), 30); assert.equal(Number(ltv.front_revenue), 8910);
    assert.equal(Number(ltv.mentorship_revenue), 15000); assert.equal(Number(ltv.refunds), 597);
    assert.equal(Number(ltv.net_revenue), 23313); assert.equal(Number(ltv.ltv_per_front_buyer), 777.1);
    const health = await request("/api/tracking-health" + params);
    assert.equal(health.report.status, "good", JSON.stringify(health.report.issues));
    let settings = await request("/api/cpa-max/settings");
    assert.equal(settings.settings.costs_confirmed, false);
    let decisions = await request("/api/decisions" + params + "&level=ad");
    assert.equal(decisions.counts.opportunity, 0);
    // Explicit fixture-only zero costs: never calibrates staging/production.
    await request("/api/cpa-max/settings", { expected_revision: settings.revision, settings: { ...settings.settings, costs_confirmed: true } }, 200, true, "PUT");
    for (const level of ["campaign", "adset", "ad"]) {
      const cpa = await request("/api/cpa-max" + params + "&level=" + level);
      assert.equal(cpa.summary.mature_buyers, 30); assert.equal(cpa.summary.current_cpa, 200);
      assert.equal(cpa.summary.economics.net_revenue_per_buyer, 777.1);
      assert.equal(cpa.summary.economics.cpa_max, 543.97);
      assert.equal(cpa.summary.economics.prudent_cpa_max, 489.57);
      assert.equal(cpa.summary.recommendation_eligible, true, JSON.stringify(cpa.summary.reasons));
      assert.equal(cpa.rows[0].object_id, prefix + level);
      assert.equal(cpa.rows[0].recommendation_eligible, true);
      decisions = await request("/api/decisions" + params + "&level=" + level);
      assert(decisions.cards.some(card => card.kind === "scale_opportunity"));
    }
    settings = await request("/api/cpa-max/settings");
    await request("/api/cpa-max/settings", { expected_revision: settings.revision, settings: { ...settings.settings, costs_confirmed: false } }, 200, true, "PUT");
    assert.equal((await request("/api/decisions" + params)).counts.opportunity, 0);
    pass("LTV, Tracking Health, CPA e decisoes reconciliados nos tres niveis; custos bloqueiam escala");
    const status = await request("/api/integrations/funnel/status");
    assert.equal(status.provider_connected, false); assert(status.integrated_events > 40);
    console.log("FUNNEL_E2E_PASS groups=" + groups + " mature_buyers=30 ltv=777.10 cpa=200.00 cpa_max=543.97 production_touched=false");
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

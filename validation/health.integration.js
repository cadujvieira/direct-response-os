// Homologacao local do monitor de saude. Mesmas travas dos outros roteiros: somente PostgreSQL em loopback
// no banco oferta_validation e aplicacao HTTP em loopback. Os sinais abaixo sao SINTETICOS.
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
  const call = async (path, { method = "GET", body, admin = true, status = 200, headers = {} } = {}) => {
    const response = await fetch(new URL(path, base), { method, redirect: "manual",
      headers: { "Content-Type": "application/json", ...(admin ? { "x-admin-secret": secret } : {}), ...headers },
      ...(body == null ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, path);
    return response.json();
  };
  try {
    await call("/api/operation-health", { admin: false, status: 401 });
    await call("/api/operation-health/diagnosis", { method: "POST", admin: false, status: 401, body: {} });
    console.log("PASS rotas de saude exigem a sessao administrativa");

    // Sinais: uma rota com pagina inalcancavel, uma rota sem pagina, avisos com token errado,
    // uma venda sem origem e um erro interno registrado.
    await call("/api/experiments/" + prefix + "a", { method: "PUT", body: { name: "Com pagina", active: true,
      variants: [{ name: "Mulheres", destination_url: "https://example.test/lp-mulheres", weight: 100, active: true }] } });
    await call("/api/experiments/" + prefix + "b", { method: "PUT", body: { name: "Sem pagina", active: true,
      variants: [{ name: "Pausada", destination_url: "https://example.test/lp", weight: 100, active: true }] } });
    await pool.query(`UPDATE dr_experiment_variants SET active = FALSE WHERE experiment_id = (SELECT id FROM dr_experiments WHERE slug = $1)`, [prefix + "b"]);
    for (let n = 0; n < 3; n++) await call("/api/integrations/hubla/webhook", { method: "POST", admin: false, status: 401,
      body: { type: "invoice.status_updated" }, headers: { "x-hubla-token": "errado" } });
    const visit = await fetch(new URL("/go/" + prefix + "a?utm_source=meta", base), { redirect: "manual" });
    assert.equal(visit.status, 302);
    await pool.query(`INSERT INTO dr_hubla_events (idempotency_key, event_type, invoice_id, payload, status, next_attempt_at, received_at)
      VALUES ($1,'invoice.status_updated',$2,'{}','pending_attribution',NULL,NOW())`, [prefix + "k1", prefix + "i1"]);
    await pool.query("INSERT INTO dr_monitor_log (source, ok, detail) VALUES ('erro', FALSE, 'GET /api/x: HTTP 500')");
    await new Promise(resolve => setTimeout(resolve, 300));

    const health = await call("/api/operation-health");
    const titles = health.alerts.map(a => a.title);
    assert.equal(health.level, "critical");
    assert(titles.includes("Landing page fora do ar: Mulheres"), JSON.stringify(titles));
    assert(titles.includes("Rota sem página ativa: " + prefix + "b"));
    // Fila parada so acontece com o processador morto (ele mesmo recupera avisos presos); a regra e coberta no teste unitario.
    assert.equal(health.metrics.hubla.stuck, 0); assert.equal(health.metrics.hubla.queue_late, 0);
    assert(titles.includes("Venda sem origem"));
    assert(titles.includes("Avisos recusados por token errado"));
    assert(titles.includes("Erro interno registrado"));
    assert(titles.includes("Monitor sem endereço público"), "sem endereco publico configurado o monitor avisa, nao inventa");
    assert.deepEqual(health.alerts.map(a => a.level), [...health.alerts.map(a => a.level)].sort((a, b) =>
      ({ critical: 0, attention: 1, info: 2 }[a] - { critical: 0, attention: 1, info: 2 }[b])));
    for (const alert of health.alerts) assert(alert.text && alert.action, "todo alerta explica o que houve e o que fazer");
    const m = health.metrics;
    assert(m.db_ms >= 0); assert.equal(m.active_routes, 1); assert.equal(m.clicks.m60, 1); assert.equal(m.clicks.router_m60, 1);
    assert.equal(m.router.queue, 0); assert.equal(m.router_latency.samples, 1);
    assert.equal(m.pages.length, 1); assert.equal(m.pages[0].page, "example.test/lp-mulheres"); assert.equal(m.pages[0].ok, false);
    assert.equal(m.hubla.token_configured, true); assert.equal(m.hubla.refused.failures, 3);
    const text = JSON.stringify(health);
    assert.equal(text.includes(secret), false); assert.equal(text.includes(process.env.DR_VALIDATION_HUBLA_TOKEN), false);
    assert.equal(/"(payload|email|telefone|ip_hash|user_agent)"/.test(text), false, "nenhum dado pessoal ou payload na saude");
    console.log("PASS semaforo critico com 6 sinais reais do banco, do router, da Hubla e das paginas; sem segredos nem dados pessoais");

    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM dr_monitor_log WHERE source = 'lp' AND NOT ok")).rows[0].n, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM dr_monitor_log WHERE source = 'hubla_auth'")).rows[0].n, 3);
    console.log("PASS sinais ficam registrados em dr_monitor_log");

    const diagnosis = await call("/api/operation-health/diagnosis", { method: "POST", body: {} });
    assert.match(diagnosis.error, /ANTHROPIC_API_KEY/);
    console.log("PASS diagnostico com IA sem chave cadastrada explica o que falta, sem erro");
    console.log("HEALTH_E2E_PASS");
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exit(1); });

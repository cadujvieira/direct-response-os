const test = require("node:test");
const assert = require("node:assert/strict");
const { createRouter } = require("./resilientRouter");

// Banco simulado: guarda o que foi gravado e pode ser derrubado ou ficar lento.
function fakeDb() {
  const db = { down: false, hang: false, clicks: new Map(), assignments: new Map(), queries: 0,
    experiment: { id: 7, slug: "vsl", name: "VSL" },
    variants: [{ id: 1, name: "Maes", destination_url: "https://lp.example.test/maes", weight: 50, active: true },
      { id: 2, name: "Jovens", destination_url: "https://lp.example.test/jovens", weight: 50, active: true }] };
  db.pool = { query: async (sql, values) => {
    db.queries += 1;
    if (db.hang) return new Promise(() => {});
    if (db.down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    if (/FROM dr_experiments/.test(sql)) return { rows: values[0] === db.experiment.slug ? [db.experiment] : [] };
    if (/FROM dr_experiment_variants/.test(sql)) return { rows: db.variants.filter(v => v.active && v.weight > 0) };
    if (/FROM dr_experiment_assignments/.test(sql)) {
      const found = [...db.assignments.values()].find(a => a.click === values[1] || a.visitor === values[2]);
      return { rows: found ? [{ variant_id: found.variant }] : [] };
    }
    if (/INSERT INTO dr_clicks/.test(sql)) { if (!db.clicks.has(values[0])) db.clicks.set(values[0], { utm_source: values[1], at: values[15] }); return { rows: [] }; }
    if (/INSERT INTO dr_experiment_assignments/.test(sql)) { db.assignments.set(values[2], { variant: values[1], click: values[2], visitor: values[3] }); return { rows: [] }; }
    throw new Error("consulta inesperada: " + sql.slice(0, 40));
  } };
  return db;
}
function visit(router, { slug = "vsl", query = {}, cookie = "" } = {}) {
  return new Promise(resolve => {
    const out = { cookies: [] };
    const res = { append: (name, value) => out.cookies.push(value), status: code => ({ json: json => resolve({ ...out, status: code, json }) }),
      redirect: (code, url) => resolve({ ...out, status: code, url: new URL(url) }) };
    router.handler({ params: { slug }, query, headers: { cookie, "x-forwarded-for": "1.2.3.4" }, get: name => ({ host: "go.example.test" })[name.toLowerCase()] || "",
      protocol: "https", originalUrl: "/go/" + slug, socket: {} }, res);
  });
}
const make = (db, extra = {}) => { let clock = 1000000; const router = createRouter({ pool: db.pool, hashIp: ip => "h:" + ip,
  cookieHeader: (name, value) => name + "=" + value, env: {}, now: () => clock, ...extra }); router.tick = ms => { clock += ms; }; return router; };

test("com o banco normal: redireciona para uma LP, grava clique e distribuicao antes de responder", async () => {
  const db = fakeDb(), router = make(db);
  const result = await visit(router, { query: { utm_source: "FB", campaign_id: "120211111111" } });
  assert.equal(result.status, 302); assert.match(result.url.pathname, /^\/(maes|jovens)$/);
  const clickId = result.url.searchParams.get("click_id");
  assert.match(clickId, /^dr_[0-9a-f-]{36}$/); assert.equal(result.url.searchParams.get("utm_source"), "FB");
  assert.equal(result.url.searchParams.get("dr_experiment"), "vsl");
  assert.equal(db.clicks.get(clickId).utm_source, "FB"); assert.equal(db.assignments.has(clickId), true);
  assert.equal(result.cookies.length, 2); assert.equal(router.health().degraded, 0);
  router.stop();
});
test("visitante que volta cai na mesma LP, com um clique novo", async () => {
  const db = fakeDb(), router = make(db);
  const first = await visit(router, { cookie: "dr_visitor_id=visitante-1" });
  for (let n = 0; n < 5; n++) {
    const again = await visit(router, { cookie: "dr_visitor_id=visitante-1" });
    assert.equal(again.url.pathname, first.url.pathname);
    assert.notEqual(again.url.searchParams.get("click_id"), first.url.searchParams.get("click_id"));
  }
  router.stop();
});
test("banco fora do ar depois de carregada a rota: continua redirecionando e grava quando o banco volta", async () => {
  const db = fakeDb(), router = make(db);
  const before = await visit(router, { cookie: "dr_visitor_id=v1" });
  db.down = true; router.tick(60000); // configuracao em memoria ja vencida
  const during = [];
  for (let n = 0; n < 20; n++) during.push(await visit(router, { cookie: "dr_visitor_id=v1", query: { utm_source: "FB" } }));
  assert(during.every(r => r.status === 302), "nenhum visitante recebe erro");
  assert(during.every(r => r.url.pathname === before.url.pathname), "mesmo visitante, mesma LP, mesmo sem consultar o banco");
  assert.equal(router.health().queue, 20); assert.equal(router.health().database_paused, true);
  assert(db.queries < 12, "com o banco fora, as consultas sao pausadas em vez de repetidas a cada visita");
  db.down = false; router.tick(6000); await router.flush();
  assert.equal(router.health().queue, 0); assert.equal(router.health().persisted_late, 20);
  for (const r of during) { const id = r.url.searchParams.get("click_id"); assert(db.clicks.has(id)); assert(db.assignments.has(id)); }
  assert.equal(db.clicks.get(during[0].url.searchParams.get("click_id")).at, new Date(1060000).toISOString(), "horario real do clique, nao o da gravacao tardia");
  router.stop();
});
test("banco lento: o visitante segue no prazo e a gravacao termina depois", async () => {
  const db = fakeDb(), router = make(db);
  await visit(router);
  db.hang = true;
  const started = Date.now(), result = await visit(router);
  assert.equal(result.status, 302); assert(Date.now() - started < 1500, "espera limitada");
  router.stop();
});
test("servico recem-iniciado com o banco fora: usa o destino de emergencia quando configurado", async () => {
  const db = fakeDb(); db.down = true;
  const none = make(db); assert.equal((await visit(none)).status, 503); none.stop();
  const router = make(db, { env: { DR_ROUTER_FALLBACK_URL: "https://lp.example.test/geral" } });
  const result = await visit(router, { query: { utm_source: "FB" } });
  assert.equal(result.status, 302); assert.equal(result.url.pathname, "/geral");
  assert.match(result.url.searchParams.get("click_id"), /^dr_/); assert.equal(result.url.searchParams.get("utm_source"), "FB");
  assert.equal(router.health().fallback, 1);
  router.stop();
});
test("rota inexistente responde 404 e rota sem LP ativa responde 503", async () => {
  const db = fakeDb(), router = make(db);
  assert.equal((await visit(router, { slug: "nao-existe" })).status, 404);
  db.variants.forEach(v => { v.weight = 0; });
  assert.equal((await visit(router)).status, 503);
  router.stop();
});
test("mudanca de peso vale em ate 10 segundos e LP retirada deixa de receber quem ja estava nela", async () => {
  const db = fakeDb(), router = make(db);
  const first = await visit(router, { cookie: "dr_visitor_id=v9" });
  const removed = db.variants.find(v => "/" + v.name.toLowerCase() === first.url.pathname);
  removed.weight = 0;
  assert.equal((await visit(router, { cookie: "dr_visitor_id=v9" })).url.pathname, first.url.pathname, "dentro da janela de 10s ainda vale a configuracao anterior");
  router.tick(11000);
  assert.notEqual((await visit(router, { cookie: "dr_visitor_id=v9" })).url.pathname, first.url.pathname);
  router.stop();
});

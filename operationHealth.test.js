const test = require("node:test");
const assert = require("node:assert");
const { evaluate, createMonitor, createCollector, probeAllowed, publicBase } = require("./operationHealth");

const healthy = () => ({ now: "2026-10-05T15:00:00.000Z", uptime_min: 600, memory_mb: 120, db_ms: 12, public_url_configured: true,
  router: { queue: 0, dropped: 0, database_paused: false, cached_routes: 1, emergency_destination_configured: true },
  router_latency: { samples: 20, avg_ms: 90, max_ms: 300 }, active_routes: 1, routes_without_page: [],
  site: { service: { ok: true, status: 200, ms: 180 }, tag: { ok: true, status: 200, ms: 150 } },
  pages: [{ route: "vsl", name: "Mulheres", page: "felipelona.com/vsl-10", ok: true, status: 200, ms: 700 }],
  clicks: { m30: 40, m60: 80, h6: 400, previous_24h: 1500, router_m60: 70, tag_m60: 10, recovered_24h: 0 },
  sales: { m60: 2, h6: 9, h24: 30, d7: 200, last_at: "2026-10-05T14:40:00.000Z" },
  hubla: { token_configured: true, queue_late: 0, stuck: 0, failed_1h: 0, unattributed_24h: 0, review: 0, unmapped_24h: 0,
    notices_24h: 60, notices_prev_7d: 400, last_at: "2026-10-05T14:41:00.000Z", refused: { total: 0, failures: 0 } },
  utmify: { token_configured: true, last_status: "completed", last_ok_at: "2026-10-05T12:00:00.000Z" },
  automations: { failed_1h: 0, late: 0 }, errors: { total: 0, failures: 0, reason: "" } });
const titles = result => result.alerts.map(a => a.title);

test("operacao saudavel fica verde e sem alertas", () => {
  const result = evaluate(healthy());
  assert.equal(result.level, "ok");
  assert.deepEqual(result.alerts, []);
  assert.equal(result.metrics.sales.minutes_since_last, 20);
  assert.equal(result.time, "12:00");
});

test("banco fora do ar e critico e interrompe as demais leituras", () => {
  const s = { ...healthy(), db_ms: null, db_error: "ECONNREFUSED", router: { queue: 4, cached_routes: 1 } };
  const result = evaluate(s);
  assert.equal(result.level, "critical");
  assert.deepEqual(titles(result), ["Banco de dados fora do ar", "Cliques aguardando gravação"]);
  assert.match(result.alerts[0].action, /router continua/);
});

test("landing page fora do ar e critica; bloqueio contra robos e so aviso", () => {
  const s = healthy();
  s.pages = [{ route: "vsl", name: "Jovens", page: "a.com/x", ok: false, status: 0, ms: 10000, error: "sem resposta em 10 s" },
    { route: "vsl", name: "30+", page: "a.com/y", ok: false, status: 403, ms: 90 },
    { route: "vsl", name: "Maes", page: "a.com/z", ok: true, status: 200, ms: 6000 }];
  const result = evaluate(s);
  assert.equal(result.level, "critical");
  assert.equal(result.alerts[0].title, "Landing page fora do ar: Jovens");
  assert.equal(result.alerts.find(a => a.title.includes("30+")).level, "info");
  assert.equal(result.alerts.find(a => a.title.includes("Maes")).level, "attention");
});

test("router: rota sem pagina, descarte e fila", () => {
  const s = healthy();
  s.routes_without_page = ["black"]; s.router.dropped_1h = 2; s.router.queue = 7;
  const found = titles(evaluate(s));
  assert.ok(found.includes("Rota sem página ativa: black"));
  assert.ok(found.includes("Router descartou cliques"));
  assert.ok(found.includes("Cliques aguardando gravação"));
});

test("destino de emergencia ausente e apenas aviso e nao muda o semaforo", () => {
  const s = healthy(); s.router.emergency_destination_configured = false;
  const result = evaluate(s);
  assert.equal(result.level, "ok");
  assert.equal(result.alerts[0].level, "info");
});

test("trafego parado e trafego sem venda viram atencao, nunca critico", () => {
  const stopped = healthy(); stopped.clicks.m60 = 0;
  assert.deepEqual(titles(evaluate(stopped)), ["O tráfego parou"]);
  const quiet = healthy(); quiet.sales.h6 = 0;
  const result = evaluate(quiet);
  assert.equal(result.level, "attention");
  assert.deepEqual(titles(result), ["Tráfego chegando, nenhuma venda em 6 horas"]);
  const fresh = healthy(); fresh.sales = { m60: 0, h6: 0, h24: 0, d7: 0, last_at: null };
  assert.equal(evaluate(fresh).level, "ok", "operacao nova, sem historico de vendas, nao gera alarme");
});

test("Hubla: token ausente, fila parada e vendas sem origem", () => {
  const s = healthy();
  s.hubla.token_configured = false; s.hubla.queue_late = 2; s.hubla.stuck = 1; s.hubla.unattributed_24h = 8;
  const result = evaluate(s), found = titles(result);
  assert.equal(result.level, "critical");
  assert.ok(found.includes("Hubla não está ligada neste ambiente"));
  assert.ok(found.includes("Fila de vendas da Hubla parada"));
  assert.ok(found.includes("Vendas chegando sem origem"));
  const busy = healthy(); busy.hubla.unattributed_24h = 3; busy.sales.h24 = 200;
  assert.equal(evaluate(busy).level, "attention", "3 em 200 vendas nao e critico");
  const paused = healthy(); paused.router.database_paused = true;
  assert.equal(evaluate(paused).level, "ok", "pausa de 5 segundos do router e so aviso");
  const one = healthy(); one.hubla.unattributed_24h = 1; one.hubla.review = 2; one.hubla.failed_1h = 1;
  const mild = evaluate(one);
  assert.equal(mild.level, "attention");
  assert.equal(mild.alerts.length, 3);
});

test("tag sem avisar cliques e erros do servidor", () => {
  const s = healthy(); s.clicks.recovered_24h = 12; s.errors = { total: 6, reason: "GET /go/x: HTTP 500" };
  const result = evaluate(s);
  assert.equal(result.alerts[0].title, "Erros no servidor");
  assert.ok(titles(result).includes("A tag das páginas não está avisando os cliques"));
});

test("alertas saem ordenados por gravidade", () => {
  const s = healthy(); s.uptime_min = 2; s.db_ms = 900; s.errors = { total: 9, reason: "x" };
  assert.deepEqual(evaluate(s).alerts.map(a => a.level), ["critical", "attention", "info"]);
});

test("monitor nunca derruba quem chamou e respeita o teto por minuto", async () => {
  let writes = 0;
  const broken = createMonitor({ query: async () => { throw new Error("banco fora"); } });
  await broken.record("erro", false, 10, "x");
  const monitor = createMonitor({ query: async sql => { if (sql.startsWith("INSERT")) writes += 1; return { rows: [] }; } }, () => 1000);
  for (let i = 0; i < 400; i++) await monitor.record("erro", false, 1, "rajada");
  for (let i = 0; i < 50; i++) await monitor.record("hubla_auth", false, null, "token recusado");
  assert.equal(writes, 105, "teto por fonte: 100 erros + 5 recusas");
  assert.equal(await monitor.record("saude", true, null, "voltou ao normal"), true, "uma rajada nao tira a vez das outras fontes");
});

test("middleware registra 5xx, token recusado da Hubla e tempo do router", async () => {
  const rows = []; let clock = 0;
  const monitor = createMonitor({ query: async (sql, args) => { if (sql.startsWith("INSERT")) rows.push(args); return { rows: [] }; } }, () => clock);
  const run = (path, status, took) => {
    const handlers = {}; const res = { statusCode: status, on: (name, fn) => { handlers[name] = fn; } };
    monitor.middleware({ path, method: "GET" }, res, () => {});
    clock += took; handlers.finish();
  };
  run("/go/vsl", 302, 120); run("/go/vsl", 302, 80); run("/api/x", 500, 5);
  run("/api/integrations/hubla/webhook", 401, 1); run("/api/crm/leads", 401, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(monitor.routerLatency(), { samples: 2, avg_ms: 100, max_ms: 120 });
  assert.deepEqual(rows.map(r => r[0]), ["erro", "hubla_auth"]);
  assert.equal(rows[0][3], "GET /api/x: HTTP 500");
});

test("monitor so consulta enderecos publicos e so aceita https como endereco proprio", () => {
  assert.equal(probeAllowed("https://felipelona.com/vsl-10"), true);
  for (const bad of ["http://localhost:3000", "http://localhost./", "http://127.0.0.1/x", "http://10.0.0.4", "http://192.168.1.1", "http://172.20.0.1",
    "http://100.64.0.9/", "http://169.254.169.254/latest", "ftp://a.com", "http://[::1]/", "http://direct-response-db:5432/",
    "http://srv-abc:10000/", "http://x.internal/", "https://user:pass@a.com/", "nada"]) assert.equal(probeAllowed(bad), false, bad);
  assert.equal(publicBase({ RENDER_EXTERNAL_URL: "https://x.onrender.com/" }), "https://x.onrender.com");
  assert.equal(publicBase({ DR_PUBLIC_URL: "http://x.com" }), "");
});

test("coletor: banco fora devolve sinal sem tentar o resto", async () => {
  let calls = 0;
  const collector = createCollector({ pool: { query: async () => { calls += 1; throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } },
    router: { health: () => ({ queue: 1, cached_routes: 1 }) }, monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {},
    fetchImpl: async () => { throw new Error("nao deveria consultar"); } });
  const s = await collector.collect();
  assert.equal(s.db_ms, null); assert.equal(s.db_error, "ECONNREFUSED"); assert.equal(calls, 1);
  assert.equal(evaluate(s).level, "critical");
});

const fakePool = rows => ({ query: async sql => ({ rows: sql.includes("FROM dr_experiments e\n      JOIN") || sql.includes("JOIN dr_experiment_variants") ? rows : [{}] }) });
const reply = (status, location) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => location || null } });

test("pagina: falha isolada e repetida antes de acusar queda; redirecionamento para endereco interno e barrado", async () => {
  const seen = []; let flaky = 0;
  const fetchImpl = async url => {
    seen.push(url);
    if (url.includes("flaky")) return reply(++flaky === 1 ? 502 : 200);
    if (url.includes("down")) return reply(500);
    if (url.includes("moved")) return reply(302, "http://10.0.0.5/admin");
    if (url.includes("hop")) return reply(301, "https://a.com/final");
    return reply(200);
  };
  const routes = [["flaky", "https://a.com/flaky?utm=1"], ["down", "https://a.com/down"], ["moved", "https://a.com/moved"],
    ["hop", "https://a.com/hop"], ["checkout", "https://pay.hub.la/abc"], ["rebind", "https://rebind.example.com/"]]
    .map(([name, destination_url]) => ({ slug: "vsl", name, destination_url }));
  const monitor = createMonitor({ query: async () => ({ rows: [] }) });
  const collector = createCollector({ pool: fakePool(routes), router: null, monitor, env: {}, fetchImpl, retryMs: 0,
    lookup: async host => [{ address: host === "rebind.example.com" ? "10.1.2.3" : "93.184.216.34" }] });
  const s = await collector.collect(), by = Object.fromEntries(s.pages.map(page => [page.name, page]));
  assert.equal(by.flaky.ok, true); assert.equal(by.flaky.page, "a.com/flaky", "sem query string");
  assert.equal(by.down.ok, false); assert.equal(by.down.status, 500);
  assert.equal(seen.filter(url => url.includes("down")).length, 2, "duas tentativas antes de acusar");
  assert.equal(by.moved.skipped, true); assert.equal(by.rebind.skipped, true);
  assert.equal(by.hop.ok, true);
  assert.equal(by.checkout, undefined, "checkout nunca e consultado");
  assert.equal(seen.some(url => url.includes("10.0.0.5") || url.includes("rebind")), false);
  const found = evaluate({ ...healthy(), pages: s.pages }).alerts.map(a => a.title);
  assert.deepEqual(found, ["Landing page fora do ar: down"]);
});

test("pagina com falha e conferida de novo no minuto seguinte; saudavel so a cada 5 minutos", async () => {
  let clock = 0, calls = 0, status = 500;
  const routes = [{ slug: "vsl", name: "A", destination_url: "https://a.com/x" }];
  const collector = createCollector({ pool: fakePool(routes), router: null, monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {},
    fetchImpl: async () => { calls += 1; return reply(status); }, retryMs: 0, now: () => clock, lookup: async () => [{ address: "93.184.216.34" }] });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  await collector.collect(); assert.equal(calls, 2);
  clock += 30000; await collector.collect(); assert.equal(calls, 2, "dentro de 1 minuto usa a leitura guardada");
  // vencido o prazo, devolve a leitura anterior na hora e confere de novo em segundo plano
  clock += 40000; status = 200; const stale = await collector.collect(); assert.equal(stale.pages[0].ok, false);
  await settle(); assert.equal(calls, 3); assert.equal((await collector.collect()).pages[0].ok, true);
  clock += 120000; await collector.collect(); await settle(); assert.equal(calls, 3, "pagina saudavel: nova consulta so depois de 5 minutos");
  clock += 200000; await collector.collect(); await settle(); assert.equal(calls, 4);
});

test("descartes do router: so o que aconteceu na ultima hora vira alerta", async () => {
  let clock = 0, dropped = 0;
  const collector = createCollector({ pool: fakePool([]), router: { health: () => ({ queue: 0, dropped }) },
    monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {}, fetchImpl: async () => reply(200), now: () => clock });
  assert.equal((await collector.collect()).router.dropped_1h, 0);
  clock += 60000; dropped = 4; assert.equal((await collector.collect()).router.dropped_1h, 4);
  clock += 2 * 3600000; assert.equal((await collector.collect()).router.dropped_1h, 0);
});

test("dominio inteiro respondendo 404 ao monitor e um unico alerta de atencao, nao 12 criticos", () => {
  const s = healthy();
  s.pages = [{ route: "mmd", name: "Geral", host: "a.com", page: "a.com", ok: true, status: 200, ms: 300 }]
    .concat([1, 2, 3, 4].map(n => ({ route: "mmd", name: "VSL 0" + n, host: "b.com", page: "b.com/vsl-0" + n, ok: false, status: 404, ms: 200 })));
  const result = evaluate(s);
  assert.equal(result.level, "attention");
  assert.deepEqual(result.alerts.map(a => a.title), ["Não consegui conferir as páginas de b.com"]);
  assert.match(result.alerts[0].text, /4 páginas de b\.com responderam 404/);
  assert.equal(result.metrics.pages.filter(p => p.refused_by_host).length, 4);
  // uma unica pagina com 404 entre outras saudaveis do mesmo dominio continua sendo queda
  const one = healthy();
  one.pages = [1, 2, 3].map(n => ({ route: "mmd", name: "P" + n, host: "b.com", page: "b.com/p" + n, ok: n !== 2, status: n === 2 ? 404 : 200, ms: 100 }));
  assert.deepEqual(evaluate(one).alerts.map(a => a.title), ["Landing page fora do ar: P2"]);
  // dominio inteiro sem conexao ou com erro 5xx e queda de verdade
  const down = healthy();
  down.pages = [1, 2, 3].map(n => ({ route: "mmd", name: "P" + n, host: "b.com", page: "b.com/p" + n, ok: false, status: n === 1 ? 503 : 0, ms: 100, error: "sem conexão" }));
  assert.equal(evaluate(down).level, "critical");
  assert.equal(evaluate(down).alerts.length, 3);
});

test("paginas do mesmo dominio sao consultadas uma por vez; dominio barrado nao acelera as consultas", async () => {
  let clock = 0, active = 0, maxActive = 0, calls = 0;
  const routes = [1, 2, 3, 4].map(n => ({ slug: "mmd", name: "P" + n, destination_url: "https://b.com/p" + n }));
  const collector = createCollector({ pool: fakePool(routes), router: null, monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {},
    fetchImpl: async () => { calls += 1; active += 1; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 5)); active -= 1; return reply(404); },
    retryMs: 0, gapMs: 0, now: () => clock, lookup: async () => [{ address: "93.184.216.34" }] });
  const s = await collector.collect();
  assert.equal(maxActive, 1, "nunca duas consultas simultaneas ao mesmo dominio");
  assert.equal(s.pages.every(p => p.host === "b.com" && p.status === 404), true);
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 4, "resposta 4xx nao e repetida");
  const first = calls; clock += 70000; await collector.collect(); await settle();
  assert.equal(calls, first, "com o dominio inteiro recusando, nao reconsulta a cada minuto");
  clock += 300000; const again = await collector.collect(); await settle();
  assert.equal(calls, first + 1, "dominio barrado: uma unica consulta de sondagem por rodada");
  assert.equal(again.pages.length, 4);
  assert.equal((await collector.collect()).pages.every(p => p.status === 404), true);
});

test("dominio que volta a aceitar o monitor e conferido por inteiro de novo", async () => {
  let clock = 0, calls = 0, status = 404;
  const routes = [1, 2, 3].map(n => ({ slug: "mmd", name: "P" + n, destination_url: "https://b.com/p" + n }));
  const collector = createCollector({ pool: fakePool(routes), router: null, monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {},
    fetchImpl: async () => { calls += 1; return reply(status); }, retryMs: 0, gapMs: 0, now: () => clock, lookup: async () => [{ address: "93.184.216.34" }] });
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(evaluate({ ...healthy(), pages: (await collector.collect()).pages }).level, "attention");
  clock += 400000; status = 200; await collector.collect(); await settle();
  assert.equal(calls, 3 + 3, "sondagem respondeu: as outras paginas sao conferidas na mesma rodada");
  const back = await collector.collect();
  assert.equal(back.pages.every(p => p.ok), true);
  assert.equal(evaluate({ ...healthy(), pages: back.pages }).level, "ok");
});

test("a leitura de saude nao espera a conferencia das paginas", async () => {
  let release;
  const routes = [{ slug: "mmd", name: "Lenta", destination_url: "https://b.com/lenta" }];
  const collector = createCollector({ pool: fakePool(routes), router: null, monitor: createMonitor({ query: async () => ({ rows: [] }) }), env: {},
    fetchImpl: () => new Promise(resolve => { release = () => resolve(reply(200)); }), retryMs: 0, gapMs: 0, firstWaitMs: 30,
    lookup: async () => [{ address: "93.184.216.34" }] });
  const started = Date.now(), s = await collector.collect();
  assert(Date.now() - started < 1000); assert.deepEqual(s.pages, []); assert.equal(s.pages_pending, true);
  const result = evaluate(s); assert.equal(result.metrics.pages_pending, true);
  assert.equal(result.alerts.some(a => /Landing page|conferir/.test(a.title)), false, "sem leitura ainda, sem alarme de pagina");
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await collector.collect()).pages[0].ok, true);
});

test("investimento automatico da UTMify: alerta so quando todas as buscas recentes falham", () => {
  const titles = feed => evaluate({ ...healthy(), utmify: { token_configured: true, last_status: "completed", feed } }).alerts.map(a => a.title);
  const name = "Investimento da UTMify não está atualizando";
  assert.ok(titles({ total: 3, failures: 3, reason: "UTMify MCP indisponivel" }).includes(name));
  assert.ok(!titles({ total: 3, failures: 2, reason: "x" }).includes(name), "uma busca boa recente basta");
  assert.ok(!titles({ total: 1, failures: 1, reason: "x" }).includes(name), "uma falha isolada nao alarma");
  assert.ok(!titles({ total: 0, failures: 0 }).includes(name));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeClick, idFromUtm, saveClick, createRateLimiter, publicEventAllowed, hasAdminSecret, registerClickRoutes,
  TAG_CLICK_ID, newClickId, beaconBody, saveCheckoutClick, CHECKOUT_CLICK } = require("./clickCapture");

test("click_id precisa ter formato seguro; campos sao limitados e limpos", () => {
  for (const bad of [null, [], {}, { click_id: "" }, { click_id: "tem espaco aqui" }, { click_id: "x".repeat(201) },
    { click_id: "<script>alert(1)</script>" }, { click_id: { $ne: 1 } }]) assert.equal(normalizeClick(bad), null);
  const click = normalizeClick({ click_id: " dr_abc-123 ", utm_source: "FB\u0000", utm_campaign: "x".repeat(900), campaign_id: "12 34",
    ad_id: "120233333333", page_url: "https://lp.example/vsl", extra: "ignorado", fbclid: 123 });
  assert.equal(click.click_id, "dr_abc-123"); assert.equal(click.utm_source, "FB"); assert.equal(click.utm_campaign.length, 500);
  assert.equal(click.campaign_id, null); assert.equal(click.ad_id, "120233333333"); assert.equal(click.fbclid, "123");
  assert.equal("extra" in click, false);
});
test("IDs de midia saem do padrao nome|id da UTMify somente quando o ID explicito nao veio", () => {
  assert.equal(idFromUtm("Campanha Fria|120211111111"), "120211111111");
  for (const value of ["Campanha Fria", "Campanha|abc", "Campanha|123", "120211111111", "a|120211111111|b", null, 5]) assert.equal(idFromUtm(value), null);
  const click = normalizeClick({ click_id: "dr_teste1", utm_campaign: "Camp|120211111111", utm_medium: "Conj|120222222222",
    utm_content: "Ad|120233333333" });
  assert.deepEqual([click.campaign_id, click.adset_id, click.ad_id], ["120211111111", "120222222222", "120233333333"]);
  assert.equal(click.utm_campaign, "Camp|120211111111");
  const explicit = normalizeClick({ click_id: "dr_teste2", utm_campaign: "Camp|120211111111", campaign_id: "999999" });
  assert.equal(explicit.campaign_id, "999999");
  assert.equal(normalizeClick({ click_id: "dr_teste3", utm_campaign: "Camp" }).campaign_id, null);
});
test("o clique gravado nunca tem a origem sobrescrita: reenvio so completa campos vazios", async () => {
  let sql, values;
  const db = { query: async (text, params) => { sql = text; values = params; return { rows: [{ created: true }] }; } };
  const result = await saveClick(db, normalizeClick({ click_id: "dr_teste1", utm_source: "meta" }), { source: "tag", ipHash: "h", userAgent: "UA" });
  assert.equal(result.created, true);
  assert.match(sql, /ON CONFLICT \(click_id\) DO UPDATE SET/);
  const update = sql.split("DO UPDATE SET")[1];
  // origem = bloco unico: so entra se o clique existente nao tiver nenhuma; nunca mistura duas origens
  for (const column of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "campaign_id", "adset_id", "ad_id"]) {
    assert.equal(update.includes(column + " = CASE WHEN COALESCE(c.utm_source, c.utm_medium, c.utm_campaign, c.utm_content, c.utm_term, c.campaign_id, c.adset_id, c.ad_id) IS NULL THEN EXCLUDED." + column + " ELSE c." + column + " END"), true, column);
  }
  for (const column of ["fbclid", "gclid", "page_url", "referrer"]) assert.equal(update.includes(column + " = COALESCE(c." + column + ", EXCLUDED." + column + ")"), true, column);
  assert.equal(/user_agent = |ip_hash = |capture_source = |created_at = /.test(sql.split("DO UPDATE SET")[1]), false);
  assert.equal(values[15], "tag");
  await saveClick(db, normalizeClick({ click_id: "dr_teste1" }), { source: "inventado" });
  assert.equal(values[15], "legacy");
});
test("formato de click gerado pela tag e reconhecido", () => {
  assert.equal(TAG_CLICK_ID.test(newClickId()), true);
  for (const other of ["dr_veio-da-url", "stg_e2e_20261001_001", "dr_" + "g".repeat(36), "xx_3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"]) assert.equal(TAG_CLICK_ID.test(other), false);
});
test("limite de volume por origem libera de novo apos a janela", () => {
  const allow = createRateLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => allow("ip", 0)), [true, true, true, false, false]);
  assert.equal(allow("outro", 0), true);
  assert.equal(allow("ip", 1000), true);
  // IP forjado a cada pedido nao fura o teto geral
  const capped = createRateLimiter(3, 1000, 10);
  assert.equal(Array.from({ length: 30 }, (_, n) => capped("ip-" + n, 0)).filter(Boolean).length, 10);
  assert.equal(capped("novo", 1000), true);
});
test("eventos de receita e pos-compra nao sao publicos; navegacao continua", () => {
  for (const body of [{ event_name: "landing_view" }, { event_name: "checkout_started", value: 0 }, { event_name: "lead", value: "0" }]) assert.equal(publicEventAllowed(body), true);
  for (const body of [{ event_name: "purchase" }, { event_name: "refund" }, { event_name: "mentorship_purchase" }, { event_name: "call_attended" },
    { event_name: "landing_view", value: 297 }, { event_name: "qualquer", value: "abc" }, { event_name: " purchase " }]) assert.equal(publicEventAllowed(body), false);
  const previous = process.env.DR_ADMIN_SECRET;
  try {
    process.env.DR_ADMIN_SECRET = "segredo-teste";
    assert.equal(hasAdminSecret({ get: () => "segredo-teste" }), true);
    assert.equal(hasAdminSecret({ get: () => "outro" }), false);
    delete process.env.DR_ADMIN_SECRET;
    assert.equal(hasAdminSecret({ get: () => "" }), false);
  } finally { if (previous == null) delete process.env.DR_ADMIN_SECRET; else process.env.DR_ADMIN_SECRET = previous; }
});
test("rota de clique valida, limita volume e nao expoe erro interno", async () => {
  let handler; const saved = [];
  const pool = { query: async (sql, values) => { saved.push(values); return { rows: [{ created: true }] }; } };
  const paths = [];
  registerClickRoutes({ post: (path, ...fns) => { paths.push(path); if (Array.isArray(path)) handler = fns[fns.length - 1]; } }, pool, ip => "hash:" + ip);
  assert.deepEqual(paths, ["/v1/go", ["/track/click", "/v1/visit"]]);
  const call = (body, ip = "1.1.1.1") => new Promise(resolve => {
    const res = { set: () => res, status: code => ({ json: json => resolve({ status: code, json }) }), json: json => resolve({ status: 200, json }) };
    handler({ body, headers: { "x-forwarded-for": ip + ", 10.0.0.1", "user-agent": "UA" }, socket: {} }, res);
  });
  assert.equal((await call({})).status, 400);
  assert.equal(saved.length, 0);
  const ok = await call({ click_id: newClickId(), utm_source: "FB" });
  assert.equal(ok.status, 200); assert.equal(saved[0][14], "hash:1.1.1.1"); assert.equal(saved[0][15], "tag");
  assert.equal((await call({ click_id: "antigo-123" }, "2.2.2.2")).status, 200); assert.equal(saved[1][15], "legacy");
  let last; for (let n = 0; n < 125; n++) last = await call({ click_id: newClickId() }, "3.3.3.3");
  assert.equal(last.status, 429);
  registerClickRoutes({ post: (path, ...fns) => { if (Array.isArray(path)) handler = fns[fns.length - 1]; } }, { query: async () => { throw Object.assign(new Error("senha=abc"), { code: "57P01" }); } }, ip => ip);
  const failed = await call({ click_id: newClickId() }, "4.4.4.4");
  assert.equal(failed.status, 500); assert.equal(JSON.stringify(failed.json).includes("senha"), false);
});

test("clique no botao de compra: corpo do sendBeacon, uma vez por clique e sem dado indevido", async () => {
  assert.deepEqual(beaconBody('{"click_id":"dr_x"}'), { click_id: "dr_x" });
  assert.equal(beaconBody("nao e json"), null); assert.equal(beaconBody("123"), null);
  assert.deepEqual(beaconBody({ a: 1 }), { a: 1 }); assert.equal(beaconBody(undefined), null);
  assert.equal(publicEventAllowed({ event_name: "checkout_click" }), false);
  const queries = [];
  let inserted = true;
  const db = { query: async (sql, values) => { queries.push({ sql, values });
    if (sql.includes("INSERT INTO dr_events")) return { rows: inserted ? [{ id: 1 }] : [] };
    return { rows: [{ created: false }] }; } };
  const click = normalizeClick({ click_id: newClickId(), utm_source: "FB", page_url: "https://felipelona-vsl.com/" });
  assert.equal((await saveCheckoutClick(db, click, { source: "tag", to: "PAY.hub.la" })).created, true);
  assert.match(queries[0].sql, /INSERT INTO dr_clicks/);
  const event = queries[1];
  assert.equal(event.values[0], "checkout_click:" + click.click_id); assert.equal(event.values[2], CHECKOUT_CLICK);
  assert.deepEqual(JSON.parse(event.values[3]), { source: "tag", page_url: "https://felipelona-vsl.com/", checkout_host: "pay.hub.la" });
  assert.match(event.sql, /ON CONFLICT \(event_id\) DO NOTHING/);
  inserted = false;
  assert.equal((await saveCheckoutClick(db, click, { to: "https://evil.com/x?y" })).created, false);
  assert.equal(JSON.parse(queries[3].values[3]).checkout_host, null);
});
test("rota /v1/go aceita text/plain, recusa clique invalido e nao expoe erro", async () => {
  let handler, middleware; const saved = [];
  const pool = { query: async (sql, values) => { saved.push({ sql, values }); return { rows: sql.includes("dr_events") ? [{ id: 1 }] : [{ created: true }] }; } };
  registerClickRoutes({ post: (path, ...fns) => { if (path === "/v1/go") { middleware = fns[0]; handler = fns[1]; } } }, pool, ip => "hash:" + ip);
  assert.equal(typeof middleware, "function");
  const call = (body, ip = "5.5.5.5") => new Promise(resolve => {
    const res = { set: () => res, status: code => ({ json: json => resolve({ status: code, json }) }), json: json => resolve({ status: 200, json }) };
    handler({ body, headers: { "x-forwarded-for": ip, "user-agent": "UA" }, socket: {} }, res);
  });
  assert.equal((await call("lixo")).status, 400);
  assert.equal((await call({ click_id: "com espaco" })).status, 400);
  assert.equal(saved.length, 0);
  const id = newClickId();
  const ok = await call(JSON.stringify({ click_id: id, utm_campaign: "C|123456789", to: "pay.hub.la" }));
  assert.deepEqual(ok, { status: 200, json: { ok: true, counted: true } });
  assert.equal(saved[0].values[15], "tag"); assert.equal(saved[0].values[6], "123456789");
  let last; for (let n = 0; n < 125; n++) last = await call({ click_id: newClickId() }, "6.6.6.6");
  assert.equal(last.status, 429);
  registerClickRoutes({ post: (path, ...fns) => { if (path === "/v1/go") handler = fns[1]; } }, { query: async () => { throw Object.assign(new Error("senha=abc"), { code: "57P01" }); } }, ip => ip);
  const failed = await call({ click_id: newClickId() }, "7.7.7.7");
  assert.equal(failed.status, 500); assert.equal(JSON.stringify(failed.json).includes("senha"), false);
});

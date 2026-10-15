// Homologacao local: clique no botao de compra (POST /v1/go, o aviso da tag v4) conta uma vez por clique no
// resumo, registra o clique quando a visita nao chegou e nao mexe em vendas, checkouts da Hubla nem leads.
// So roda contra HTTP de loopback (banco de teste).
const assert = require("node:assert/strict");
const crypto = require("crypto");

async function main() {
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const summary = async () => {
    const r = await fetch(new URL("/api/summary?from=" + today + "&to=" + today, base));
    assert.equal(r.status, 200);
    return (await r.json()).summary;
  };
  // Igual ao navigator.sendBeacon: text/plain, sem pre-voo de CORS.
  const beacon = async (body, status = 200) => {
    const r = await fetch(new URL("/v1/go", base), { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8",
      origin: "https://felipelona-vsl.com" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal(r.status, status);
    if (status === 200) assert.equal(r.headers.get("access-control-allow-origin"), "*");
    return r.json();
  };
  // ID de campanha proprio desta rodada: a tabela de campanhas agrupa pelo ID.
  const campaign = "QA botao " + crypto.randomUUID().slice(0, 8) + "|1202" + String(Date.now()).slice(-12) + String(crypto.randomInt(100, 999));
  const s0 = await summary();
  assert.equal(typeof s0.checkout_clicks, "number");

  // A: visita registrada antes (tag v3/v4), depois dois cliques no botao (dois toques) = 1
  const clickA = "dr_" + crypto.randomUUID();
  const visit = await fetch(new URL("/v1/visit", base), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ click_id: clickA, utm_source: "FB", utm_campaign: campaign, page_url: "https://felipelona-vsl.com/" }) });
  assert.equal(visit.status, 200);
  assert.deepEqual(await beacon({ click_id: clickA, utm_source: "FB", page_url: "https://felipelona-vsl.com/", to: "pay.hub.la" }), { ok: true, counted: true });
  assert.deepEqual(await beacon({ click_id: clickA, page_url: "https://felipelona-vsl.com/", to: "pay.hub.la" }), { ok: true, counted: false });
  let s1 = await summary();
  assert.equal(s1.checkout_clicks, s0.checkout_clicks + 1);
  assert.equal(s1.clicks, s0.clicks + 1, "o aviso do botao nao cria um segundo clique");

  // B: a visita foi bloqueada; o aviso do botao registra o clique com a origem
  const clickB = "dr_" + crypto.randomUUID();
  await beacon({ click_id: clickB, utm_source: "FB", utm_campaign: campaign, page_url: "https://felipelona-vsl.com/lpdireta/", to: "pay.hub.la" });
  const s2 = await summary();
  assert.equal(s2.checkout_clicks, s0.checkout_clicks + 2);
  assert.equal(s2.clicks, s0.clicks + 2);

  // Nada muda em vendas, receita, checkouts da Hubla nem leads
  for (const key of ["checkouts", "purchases", "revenue", "leads", "spend"]) assert.equal(String(s2[key]), String(s0[key]), key);

  // Entradas invalidas e caminho publico de eventos fechado para checkout_click
  await beacon("nao e json", 400);
  await beacon({ click_id: "tem espaco" }, 400);
  const forged = await fetch(new URL("/track/event", base), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_name: "checkout_click", event_id: "forjado:" + crypto.randomUUID(), click_id: clickA }) });
  assert.equal(forged.status, 401);
  assert.equal((await summary()).checkout_clicks, s0.checkout_clicks + 2);

  // A campanha do clique continua sendo a da visita
  const campaigns = (await (await fetch(new URL("/api/campaigns?from=" + today + "&to=" + today, base))).json()).campaigns || [];
  const row = campaigns.find(c => c.campaign === campaign);
  assert(row, "campanha da visita");
  assert.equal(Number(row.clicks), 2);
  console.log("checkout_click: ok (" + (await summary()).checkout_clicks + " no dia)");
}
main().catch(error => { console.error(error); process.exit(1); });

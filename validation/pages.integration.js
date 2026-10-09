// Homologacao local do desempenho por pagina (anuncio com link direto, sem router). PostgreSQL em loopback no
// banco oferta_validation e aplicacao HTTP em loopback. Cliques entram pela rota publica da tag; compras e gasto
// sao SINTETICOS, gravados direto no banco de homologacao.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");

async function main() {
  const dbUrl = new URL(process.env.DR_VALIDATION_DATABASE_URL || "invalid:");
  const base = new URL(process.env.DR_VALIDATION_BASE_URL || "invalid:");
  assert(["127.0.0.1", "localhost"].includes(dbUrl.hostname));
  assert.equal(dbUrl.pathname, "/oferta_validation");
  assert(["127.0.0.1", "localhost"].includes(base.hostname));
  const secret = process.env.DR_VALIDATION_ADMIN_SECRET;
  const pool = new Pool({ connectionString: dbUrl.href, ssl: false });
  const http = async (path, { method = "GET", body, admin = false, status = 200, ip } = {}) => {
    const r = await fetch(new URL(path, base), { method, redirect: "manual", headers: { "content-type": "application/json",
      "x-forwarded-for": ip || "198.51.100." + Math.floor(Math.random() * 200), ...(admin ? { "x-admin-secret": secret } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, status, path);
    return r.headers.get("content-type")?.includes("json") ? r.json() : r;
  };
  const tagClick = async (page, ad) => {
    const id = "dr_" + crypto.randomUUID();
    await http("/track/click", { method: "POST", body: { click_id: id, page_url: page, utm_source: "FB",
      utm_content: "Criativo|" + ad, utm_campaign: "Camp|900000001" } });
    return id;
  };
  const buy = (click, n, value = 297) => pool.query(`INSERT INTO dr_events (event_id, click_id, event_name, value) VALUES ($1,$2,'purchase',$3)`,
    ["qa-buy-" + n, click, value]);
  try {
    // Nome das paginas vem das LPs cadastradas no router
    await http("/api/experiments/mmd", { method: "PUT", admin: true, body: { name: "MMD", active: true, variants: [
      { name: "Jovens de 18 a 29", destination_url: "https://felipelona-vsl.com/jovens", weight: 10, active: true },
      { name: "Mães", destination_url: "https://felipelona-vsl.com/maes/", weight: 10, active: true }] } });

    // Anuncio 111 -> /jovens (4 cliques, 2 compras); anuncio 222 -> /maes (3 cliques, 1 compra, com www e parametros
    // e barra final); anuncio 333 -> /clt (sem nome cadastrado); um clique recuperado pelo checkout; um clique do router.
    const jovens = [], maes = [];
    for (let i = 0; i < 4; i++) jovens.push(await tagClick("https://felipelona-vsl.com/jovens", "111000111"));
    maes.push(await tagClick("https://www.felipelona-vsl.com/maes/", "222000222"));
    maes.push(await tagClick("https://felipelona-vsl.com/maes?x=1#topo", "222000222"));
    maes.push(await tagClick("https://felipelona-vsl.com/maes", "222000222"));
    const clt = await tagClick("https://felipelona-vsl.com/clt", "333000333");
    await pool.query(`INSERT INTO dr_clicks (click_id, page_url, ad_id, capture_source) VALUES ('dr_recuperado-1', 'checkout:hubla', NULL, 'checkout_recovered')`);
    const visit = await http("/go/mmd?utm_source=FB", { status: 302 });
    assert(visit.headers.get("location"));
    await buy(jovens[0], 1); await buy(jovens[1], 2); await buy(maes[0], 3); await buy("dr_recuperado-1", 4);
    await pool.query(`INSERT INTO dr_events (event_id, click_id, event_name, value) VALUES ('qa-ref-1', $1, 'refund', -297)`, [jovens[1]]);
    // Gasto UTMify por anuncio, incluindo um anuncio sem nenhum clique
    for (const [ad, spend] of [["111000111", 200], ["222000222", 90], ["333000333", 30], ["444000444", 15]]) {
      await pool.query(`INSERT INTO dr_ad_spend (spend_date, source, campaign_id, ad_id, spend) VALUES ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, 'utmify', '900000001', $1, $2)`, [ad, spend]);
    }

    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const data = await http("/api/pages/performance?from=" + today + "&to=" + today);
    const by = Object.fromEntries(data.pages.map(p => [p.name, p]));
    assert.deepEqual(Object.keys(by).sort(), ["Anúncios sem clique registrado", "Jovens de 18 a 29", "Mães", "Página não identificada", "felipelona-vsl.com/clt"].sort(),
      JSON.stringify(data.pages.map(p => p.name)));
    assert.deepEqual([by["Jovens de 18 a 29"].clicks, by["Jovens de 18 a 29"].buyers, by["Jovens de 18 a 29"].spend, by["Jovens de 18 a 29"].net_revenue], [4, 2, 200, 297]);
    assert.deepEqual([by["Mães"].clicks, by["Mães"].buyers, by["Mães"].spend, by["Mães"].page], [3, 1, 90, "felipelona-vsl.com/maes"]);
    assert.deepEqual([by["felipelona-vsl.com/clt"].clicks, by["felipelona-vsl.com/clt"].buyers, by["felipelona-vsl.com/clt"].spend], [1, 0, 30]);
    assert.deepEqual([by["Página não identificada"].clicks, by["Página não identificada"].buyers], [1, 1]);
    assert.equal(by["Anúncios sem clique registrado"].spend, 15);
    assert(!data.pages.some(p => /go\/mmd/.test(p.page || "")), "clique do router fica de fora (aparece na rota)");
    const spend = data.pages.reduce((sum, p) => sum + p.spend, 0);
    assert.equal(spend, 335, "investimento por pagina soma o total do periodo");
    assert.equal(data.pages[0].name, "Jovens de 18 a 29", "ordenado por compradores");
    console.log("PASS paginas com link direto: cliques, compradores, receita e investimento por pagina, total batendo");

    // Anuncio com cliques em duas paginas: gasto dividido pelos cliques
    await tagClick("https://felipelona-vsl.com/jovens", "555000555");
    for (let i = 0; i < 3; i++) await tagClick("https://felipelona-vsl.com/maes", "555000555");
    await pool.query(`INSERT INTO dr_ad_spend (spend_date, source, campaign_id, ad_id, spend) VALUES ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, 'utmify', '900000001', '555000555', 100)`);
    const split = Object.fromEntries((await http("/api/pages/performance?from=" + today + "&to=" + today)).pages.map(p => [p.name, p]));
    assert.equal(split["Jovens de 18 a 29"].spend, 225);
    assert.equal(split["Mães"].spend, 165);
    console.log("PASS anuncio com cliques em mais de uma pagina divide o gasto pelos cliques");

    // Periodo sem dados e periodo invalido
    assert.deepEqual((await http("/api/pages/performance?from=2020-01-01&to=2020-01-02")).pages, []);
    await http("/api/pages/performance?from=2020-13-01&to=2020-01-02", { status: 400 });
    console.log("PASS periodo vazio e periodo invalido");
  } finally { await pool.end(); }
}
main().catch(error => { console.error("FAIL", error); process.exit(1); });

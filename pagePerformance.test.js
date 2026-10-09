const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePage } = require("./pagePerformance");

test("pagina: host + caminho, sem www, parametros, ancora ou barra final", () => {
  assert.equal(normalizePage("https://felipelona-vsl.com/jovens"), "felipelona-vsl.com/jovens");
  assert.equal(normalizePage("https://www.Felipelona-VSL.com/maes/?utm_source=FB#x"), "felipelona-vsl.com/maes");
  assert.equal(normalizePage("https://felipelona-vsl.com/"), "felipelona-vsl.com");
  assert.equal(normalizePage("checkout:hubla"), null);
  assert.equal(normalizePage(""), null);
  assert.equal(normalizePage(null), null);
});

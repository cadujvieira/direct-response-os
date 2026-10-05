/* Oferta DR - preserva click_id e UTMs da LP ate o checkout.
   Uso na LP: incluir uma tag script apontando para /assets/dr-checkout.js deste servidor (com defer).
   Opcional na tag: data-checkout-hosts="pay.hub.la,meu-dominio.com" e data-click-param="click_id".
   O script apenas repassa o que ja chegou na URL da LP; nunca cria um click_id. */
(function () {
  "use strict";
  var script = document.currentScript;
  var attr = function (name, fallback) { return (script && script.getAttribute(name)) || fallback; };
  var HOSTS = attr("data-checkout-hosts", "pay.hub.la,hub.la,app.hub.la").split(",")
    .map(function (h) { return h.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[\/?#:].*$/, ""); }).filter(Boolean);
  var CLICK = attr("data-click-param", "click_id");
  var KEYS = ["click_id", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "campaign_id", "adset_id", "ad_id", "fbclid", "gclid"];
  var STORE = "dr_tracking_v1";
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  function fromUrl() {
    var found = {}, params;
    try { params = new URL(window.location.href).searchParams; } catch (e) { return found; }
    KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value && value.length <= 500) found[key] = value;
    });
    return found;
  }
  function load() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE) || "null");
      if (saved && saved.at && Date.now() - saved.at < MAX_AGE_MS && saved.data) return saved.data;
    } catch (e) { /* armazenamento indisponivel: segue apenas com a URL */ }
    return {};
  }
  function save(data) {
    try { window.localStorage.setItem(STORE, JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* idem */ }
  }
  // Uma nova entrada com click_id substitui tudo o que estava guardado.
  // Entrada com sinais de outra origem (UTM, gclid, fbclid...) e sem click_id NAO reaproveita um click antigo:
  // a compra dessa visita fica sem click em vez de ser atribuida ao anuncio errado.
  var current = fromUrl();
  var hasSignal = Object.keys(current).length > 0;
  var data = current.click_id ? current : hasSignal ? {} : load();
  if (current.click_id) save(current);

  function isCheckout(url) {
    var host = url.hostname.toLowerCase();
    return HOSTS.some(function (h) { return host === h || host.slice(-(h.length + 1)) === "." + h; });
  }
  function decorate(href) {
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return href; }
    if (!/^https?:$/.test(url.protocol) || !isCheckout(url) || !data.click_id) return href;
    url.searchParams.set(CLICK, data.click_id);
    KEYS.forEach(function (key) {
      if (key !== "click_id" && data[key] && !url.searchParams.has(key)) url.searchParams.set(key, data[key]);
    });
    return url.toString();
  }
  function decorateAll(root) {
    var links = (root || document).querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      var next = decorate(links[i].getAttribute("href"));
      if (next !== links[i].getAttribute("href")) links[i].setAttribute("href", next);
    }
  }
  function onIntent(event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.tagName === "A" && node.getAttribute("href")) { node.setAttribute("href", decorate(node.getAttribute("href"))); return; }
      node = node.parentNode;
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { decorateAll(); });
  else decorateAll();
  // Botoes inseridos depois do carregamento (construtores de pagina) sao tratados no momento do clique.
  ["mousedown", "touchstart", "click", "keydown"].forEach(function (name) {
    document.addEventListener(name, onIntent, true);
  });
  window.DRTracking = { get: function () { return JSON.parse(JSON.stringify(data)); }, decorate: decorate, refresh: decorateAll };
})();

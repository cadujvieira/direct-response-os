/* Oferta DR - tag das paginas (versao 3).
   Cria o click_id na propria pagina quando ele nao veio na URL, avisa o Oferta DR em segundo plano e
   repassa click_id e UTMs para o link do checkout. Nada aqui bloqueia a pagina: se o aviso falhar, a
   venda segue normalmente e o clique e recuperado depois pelo aviso do checkout.
   Uso: colada direto no <head> da pagina (forma recomendada: funciona mesmo quando um bloqueador impede o
   GTM de carregar), tag script apontando para /assets/dr-checkout.js, ou colada no GTM. Se carregar mais de
   uma vez na mesma pagina, so a primeira roda.
   Opcoes na tag: data-endpoint, data-checkout-hosts, data-own-hosts, data-click-param, data-create-click="false". */
(function () {
  "use strict";
  if (window.DRTracking) return;
  var script = document.currentScript;
  var attr = function (name, fallback) { return (script && script.getAttribute(name)) || fallback; };
  var hosts = function (value) {
    return value.split(",").map(function (h) { return h.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[\/?#:].*$/, ""); }).filter(Boolean);
  };
  var origin = function (src) { try { return new URL(src).origin; } catch (e) { return ""; } };
  var ENDPOINT = attr("data-endpoint", "") || origin(script && script.src) || "__DR_ENDPOINT__";
  if (ENDPOINT.indexOf("__") === 0) ENDPOINT = "";
  ENDPOINT = ENDPOINT.replace(/\/+$/, "");
  var HOSTS = hosts(attr("data-checkout-hosts", "pay.hub.la,hub.la,app.hub.la"));
  var OWN = hosts(attr("data-own-hosts", "felipelona.com,felipelona-vsl.com"));
  var CLICK = attr("data-click-param", "click_id");
  var CREATE = attr("data-create-click", "true") !== "false";
  var SIGNALS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "campaign_id", "adset_id", "ad_id", "fbclid", "gclid"];
  var VALID_ID = /^[A-Za-z0-9_.:=+\/-]{1,200}$/;
  var STORE = "dr_tracking_v1";
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  function fromUrl() {
    var found = {}, params;
    try { params = new URL(window.location.href).searchParams; } catch (e) { return found; }
    SIGNALS.forEach(function (key) {
      var value = params.get(key);
      if (value && value.length <= 1000) found[key] = value;
    });
    /* um click_id fora do formato aceito pelo servidor e ignorado, para nao gerar venda sem atribuicao */
    var id = params.get(CLICK) || params.get("click_id");
    if (id && VALID_ID.test(id)) found.click_id = id;
    return found;
  }
  function valid(saved) {
    return saved && saved.at && Date.now() - saved.at < MAX_AGE_MS && saved.data && saved.data.click_id ? saved : null;
  }
  /* localStorage e o principal; o cookie da propria pagina cobre navegadores que bloqueiam o armazenamento */
  function load() {
    try { var a = valid(JSON.parse(window.localStorage.getItem(STORE) || "null")); if (a) return a; } catch (e) { /* segue */ }
    try {
      var match = document.cookie.match(new RegExp("(?:^|; )" + STORE + "=([^;]*)"));
      if (match) return valid(JSON.parse(decodeURIComponent(match[1])));
    } catch (e) { /* segue apenas com a URL */ }
    return null;
  }
  function save(record) {
    var text = JSON.stringify(record);
    try { window.localStorage.setItem(STORE, text); } catch (e) { /* tenta o cookie */ }
    try {
      if (encodeURIComponent(text).length < 3500) {
        document.cookie = STORE + "=" + encodeURIComponent(text) + "; path=/; max-age=" + (MAX_AGE_MS / 1000) + "; SameSite=Lax";
      }
    } catch (e) { /* idem */ }
  }
  function newId() {
    var c = window.crypto || window.msCrypto;
    if (c && typeof c.randomUUID === "function") return "dr_" + c.randomUUID();
    var bytes = [], i;
    if (c && c.getRandomValues) { var buffer = new Uint8Array(16); c.getRandomValues(buffer); for (i = 0; i < 16; i++) bytes.push(buffer[i]); }
    else for (i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = bytes.map(function (b) { return (b < 16 ? "0" : "") + b.toString(16); }).join("");
    return "dr_" + hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function sameSignals(saved, now) {
    return SIGNALS.every(function (key) { return !now[key] || saved[key] === now[key]; });
  }
  function fresh(data) { return { at: Date.now(), data: data, sent: false }; }

  /* Qual clique vale nesta visita:
     - click_id na URL: e ele (um novo substitui o guardado);
     - sinais de origem na URL (UTM, fbclid...) iguais aos guardados: mesma visita, mesmo clique;
     - sinais diferentes dos guardados: e outra origem, portanto outro clique;
     - URL sem nada: reaproveita o clique guardado por ate 7 dias, ou cria um de acesso direto. */
  var current = fromUrl();
  var saved = load();
  var hasSignal = SIGNALS.some(function (key) { return Boolean(current[key]); });
  var record = null;
  if (current.click_id) record = saved && saved.data.click_id === current.click_id ? saved : fresh(current);
  else if (hasSignal && saved && sameSignals(saved.data, current)) record = saved;
  else if (!hasSignal && saved) record = saved;
  else if (CREATE) { current.click_id = newId(); record = fresh(current); }
  var data = record ? record.data : {};
  if (record) save(record);

  function report() {
    if (!record || record.sent || !ENDPOINT || typeof window.fetch !== "function") return;
    var body = {};
    ["click_id"].concat(SIGNALS).forEach(function (key) { if (data[key]) body[key] = data[key]; });
    body.page_url = window.location.origin + window.location.pathname;
    if (document.referrer) body.referrer = document.referrer.split("?")[0].slice(0, 300);
    try {
      /* caminho neutro: listas de bloqueio costumam barrar enderecos com "track" */
      window.fetch(ENDPOINT + "/v1/visit", { method: "POST", mode: "cors", credentials: "omit", keepalive: true,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (response) {
          if (!response || !response.ok) return;
          record.sent = true;
          /* outra aba pode ter iniciado outro clique enquanto este aviso estava em curso: nao regrava por cima */
          var now = load();
          if (!now || now.data.click_id === record.data.click_id) save(record);
        })
        ["catch"](function () { /* tenta de novo na proxima pagina; a venda nao depende deste aviso */ });
    } catch (e) { /* idem */ }
  }

  function kind(url) {
    var host = url.hostname.toLowerCase();
    var matches = function (list) { return list.some(function (h) { return host === h || host.slice(-(h.length + 1)) === "." + h; }); };
    if (matches(HOSTS)) return "checkout";
    /* outra pagina propria em outro dominio: o armazenamento nao e compartilhado, entao o clique vai na URL */
    if (host !== window.location.hostname.toLowerCase() && matches(OWN)) return "own";
    return "";
  }
  function decorate(href) {
    var url;
    try { url = new URL(href, window.location.href); } catch (e) { return href; }
    if (!/^https?:$/.test(url.protocol) || !data.click_id || !kind(url)) return href;
    url.searchParams.set(CLICK, data.click_id);
    SIGNALS.forEach(function (key) {
      if (data[key] && !url.searchParams.has(key)) url.searchParams.set(key, data[key]);
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
  report();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { decorateAll(); });
  else decorateAll();
  /* Botoes liberados depois (delay do video) sao tratados no momento do clique. */
  ["mousedown", "touchstart", "click", "keydown"].forEach(function (name) {
    document.addEventListener(name, onIntent, true);
  });
  window.DRTracking = { get: function () { return JSON.parse(JSON.stringify(data)); }, decorate: decorate, refresh: decorateAll,
    reported: function () { return Boolean(record && record.sent); } };
})();

// Bloco "Saude da operacao" no topo do painel: semaforo, alertas explicados, sinais de cada parte e
// diagnostico com IA. Atualiza sozinho a cada minuto. Usa a sessao administrativa do painel.
const healthState = { request: 0, secret: null, open: true, data: null };
const HEALTH_LABEL = { ok: "Tudo funcionando", attention: "Atenção", critical: "Problema sério" };
const HEALTH_MARK = { critical: "Crítico", attention: "Atenção", info: "Aviso" };
const healthText = value => escapeHtml(value == null ? "" : String(value));
const healthTime = value => (value ? new Date(value).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : "—");
const healthMs = ms => (ms == null ? "—" : ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1).replace(".", ",") + " s");
const healthCount = value => Number(value || 0).toLocaleString("pt-BR");

function healthChip(label, value, sub, tone) {
  return '<div class="health-chip' + (tone ? " " + tone : "") + '"><span>' + healthText(label) + "</span><b>" + healthText(value) +
    "</b>" + (sub ? "<small>" + healthText(sub) + "</small>" : "") + "</div>";
}
// Sem leitura confiavel (antes da primeira resposta, sem sessao ou sem conexao) o bloco fica neutro, nunca verde.
function healthUnknown(title, when) {
  document.getElementById("healthBox").className = "health-box unknown";
  document.getElementById("healthTitle").textContent = title;
  document.getElementById("healthWhen").textContent = when;
  const dot = document.getElementById("headerStatusDot"), label = document.getElementById("headerStatusText");
  if (dot) dot.className = "dot unknown";
  if (label) label.textContent = "Sem leitura";
}
function healthChips(m) {
  if (m.db_ms == null) return healthChip("Banco de dados", "Fora do ar", "os demais sinais dependem dele", "bad") +
    healthChip("Router", m.router && m.router.queue ? healthCount(m.router.queue) + " em fila" : "Redirecionando", "com a configuração guardada em memória");
  const router = m.router || {}, latency = m.router_latency || {}, clicks = m.clicks || {}, sales = m.sales || {};
  const hubla = m.hubla || {}, pages = m.pages || [], site = m.site || {}, errors = m.errors || {}, utmify = m.utmify || {};
  const pagesOk = pages.filter(page => page.ok).length;
  const pagesUnchecked = pages.filter(page => !page.ok && (page.refused_by_host || page.skipped || [401, 403, 406, 429].indexOf(page.status) >= 0)).length;
  const pagesDown = pages.filter(page => !page.ok).length - pagesUnchecked;
  const hublaOpen = Number(hubla.queue_late || 0) + Number(hubla.stuck || 0) + Number(hubla.unattributed_24h || 0) + Number(hubla.review || 0);
  const slowest = Math.max(0, ...Object.values(site).map(item => (item && item.ms) || 0));
  return [
    healthChip("Cliques · 1 hora", healthCount(clicks.m60), healthCount(clicks.router_m60) + " pelo router · " + healthCount(clicks.tag_m60) + " pela tag"),
    healthChip("Vendas · 24 horas", healthCount(sales.h24), sales.last_at ? "última às " + healthTime(sales.last_at) : "nenhuma nos últimos 7 dias"),
    healthChip("Router", router.queue ? healthCount(router.queue) + " em fila" : "Redirecionando",
      latency.samples ? "média " + healthMs(latency.avg_ms) + " · " + healthCount(m.active_routes) + " rota(s)" : healthCount(m.active_routes) + " rota(s) ativa(s)",
      router.dropped_1h || router.queue ? "bad" : "good"),
    m.pages_pending ? healthChip("Landing pages", "Conferindo...", "primeira conferência depois de reiniciar") :
    healthChip("Landing pages", pages.length ? pagesOk + "/" + pages.length + " no ar" : "—",
      !pages.length ? "nenhuma página em rotação" : pagesUnchecked ? pagesUnchecked + " sem conferência (monitor barrado)" : "conferidas a cada 5 minutos",
      pagesDown ? "bad" : pagesUnchecked ? "" : pages.length ? "good" : ""),
    healthChip("Hubla", !hubla.token_configured ? "Não ligada" : hublaOpen ? healthCount(hublaOpen) + " pendência(s)" : "Em dia",
      hubla.last_at ? "último aviso às " + healthTime(hubla.last_at) : "nenhum aviso real ainda", !hubla.token_configured || hublaOpen ? "bad" : "good"),
    healthChip("Tag das páginas", healthCount(clicks.recovered_24h) + " recuperado(s)", "cliques que só o checkout informou (24 h)",
      Number(clicks.recovered_24h || 0) >= 3 ? "bad" : ""),
    healthChip("UTMify", !utmify.token_configured ? "Não ligada" : utmify.last_status === "failed" ? "Falhou" : "Ligada",
      utmify.feed && utmify.feed.last_ok ? "investimento às " + healthTime(utmify.feed.last_ok) : utmify.last_ok_at ? "atualizada em " + crmFormatDateTime(utmify.last_ok_at) : "sem atualização ainda",
      utmify.last_status === "failed" || (utmify.feed && utmify.feed.total >= 2 && utmify.feed.failures === utmify.feed.total) ? "bad" : ""),
    healthChip("Velocidade", healthMs(slowest || null), "banco " + healthMs(m.db_ms) + " · serviço " + (site.service ? healthMs(site.service.ms) : "—"),
      slowest > 4000 || m.db_ms > 800 ? "bad" : slowest ? "good" : ""),
    healthChip("Erros do servidor", healthCount(errors.total), "última hora", errors.total ? "bad" : "good")
  ].join("");
}
function renderHealth(data) {
  healthState.data = data;
  const box = document.getElementById("healthBox"), level = data.level || "ok";
  box.className = "health-box " + level;
  document.getElementById("healthTitle").textContent = "Saúde da operação: " + HEALTH_LABEL[level];
  document.getElementById("healthWhen").textContent = "às " + (data.time || "—") + " · conferida a cada minuto, mesmo com o painel fechado";
  const dot = document.getElementById("headerStatusDot"), label = document.getElementById("headerStatusText");
  if (dot) dot.className = "dot " + level;
  if (label) label.textContent = level === "ok" ? "Operação normal" : HEALTH_LABEL[level];
  const alerts = data.alerts || [];
  document.getElementById("healthAlerts").innerHTML = alerts.length ? alerts.map(alert =>
    '<li class="' + healthText(alert.level) + '"><strong><i>' + healthText(HEALTH_MARK[alert.level] || "") + "</i>" + healthText(alert.title) + "</strong><span>" +
    healthText(alert.text) + "</span>" + (alert.action ? "<em>O que fazer: " + healthText(alert.action) + "</em>" : "") + "</li>").join("")
    : '<li class="fine">Nenhum problema detectado. Banco, router, landing pages, Hubla e tag estão respondendo normalmente.</li>';
  document.getElementById("healthChips").innerHTML = healthChips(data.metrics || {});
  const history = data.history || [];
  document.getElementById("healthHistory").innerHTML = history.length ? "<strong>Últimas 24 horas</strong>" + history.map(item =>
    '<div class="' + (item.ok ? "fine" : "bad") + '"><time>' + healthText(healthTime(item.at)) + "</time><span>" + healthText(item.detail) + "</span></div>").join("") : "";
}
function healthNotice(text) { document.getElementById("healthNotice").textContent = text || ""; }
async function loadHealth() {
  if (!document.getElementById("healthBox")) return;
  if (!utmifyAdminSecret()) {
    healthState.request++; healthState.data = null;
    healthUnknown("Saúde da operação", "Conecte a sessão administrativa na aba CRM para acompanhar.");
    for (const id of ["healthAlerts", "healthChips", "healthHistory"]) document.getElementById(id).innerHTML = "";
    healthNotice("");
    return;
  }
  const request = ++healthState.request;
  try {
    const data = await utmifyFetch("/api/operation-health");
    if (request !== healthState.request) return;
    renderHealth(data); healthNotice("");
  } catch (error) {
    if (request !== healthState.request) return;
    healthUnknown("Saúde da operação: sem leitura", healthState.data ? "última leitura às " + (healthState.data.time || "—") + "; os números abaixo são dessa hora" : "");
    healthNotice(error.status === 401 ? "Sessão administrativa expirada. Conecte de novo na aba CRM." : "Não consegui falar com o servidor agora. Se continuar, o serviço pode estar fora do ar: abra o Render para conferir.");
  }
}
async function runHealthDiagnosis(button) {
  const box = document.getElementById("healthDiagnosis");
  button.disabled = true; button.textContent = "Analisando...";
  try {
    const data = await utmifyFetch("/api/operation-health/diagnosis", { method: "POST", body: "{}" });
    box.className = "health-diagnosis" + (data.error ? " error" : "");
    box.innerHTML = "<strong>" + (data.error ? "Diagnóstico indisponível" : "Diagnóstico") + "</strong><p>" + healthText(data.error || data.text) + "</p>" +
      (data.error ? "" : "<small>Gerado por IA às " + healthText(healthTime(data.at)) + " com base nos números acima. Confira antes de agir.</small>");
  } catch (error) {
    box.className = "health-diagnosis error";
    box.innerHTML = "<strong>Diagnóstico indisponível</strong><p>Não consegui falar com o servidor.</p>";
  }
  box.hidden = false; button.disabled = false; button.textContent = "Diagnóstico com IA";
}
function initHealth() {
  if (!document.getElementById("healthBox")) return;
  document.getElementById("healthToggle").addEventListener("click", () => {
    healthState.open = !healthState.open;
    document.getElementById("healthBody").hidden = !healthState.open;
    document.getElementById("healthToggle").setAttribute("aria-expanded", String(healthState.open));
  });
  document.getElementById("healthRefresh").addEventListener("click", () => loadHealth());
  document.getElementById("healthDiagnose").addEventListener("click", event => runHealthDiagnosis(event.currentTarget));
  loadHealth();
  setInterval(() => { if (document.visibilityState === "visible") loadHealth(); }, 60000);
  // Assim que a sessao administrativa e conectada (ou encerrada), o bloco reage sem esperar o proximo minuto.
  setInterval(() => {
    const secret = utmifyAdminSecret();
    if (secret !== healthState.secret) { healthState.secret = secret; loadHealth(); }
  }, 3000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHealth);
else initHealth();

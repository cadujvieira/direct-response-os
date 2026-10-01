const decisionState = { request: 0, data: null };
const decisionCategories = { opportunity: "Oportunidade", risk: "Risco econômico", data: "Pendência de dados" };
const decisionSeverities = { critical: "Crítico", attention: "Atenção", information: "Informação" };
function decisionValue(item) {
  if (item.value == null) return "—";
  if (item.format === "money") return formatMoney(item.value);
  if (item.format === "percent") return Number(item.value).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
  if (item.format === "multiple") return Number(item.value).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "×";
  if (item.format === "count") return Number(item.value).toLocaleString("pt-BR");
  return item.key === "tracking" ? trackingHealthStatusLabel(item.value) : String(item.value);
}
function renderDecisionCards() {
  const data = decisionState.data;
  if (!data) return;
  const category = document.getElementById("decisionCategory").value;
  const severity = document.getElementById("decisionSeverity").value;
  const search = document.getElementById("decisionSearch").value.trim().toLocaleLowerCase("pt-BR");
  const cards = data.cards.filter(card => (!category || card.category === category) &&
    (!severity || card.severity === severity) && (!search ||
      [card.title, card.scope?.name, card.scope?.object_id, card.scope?.campaign, card.scope?.adset]
        .filter(Boolean).join(" ").toLocaleLowerCase("pt-BR").includes(search)));
  document.getElementById("decisionResultCount").textContent = cards.length + " exibidos · " + data.counts.total +
    " diagnósticos no período" + (data.counts.total > data.counts.returned ? " · carregados os " + data.counts.returned + " prioritários" : "");
  document.getElementById("decisionCards").innerHTML = cards.length ? cards.map(card => {
    const scope = card.scope;
    const context = scope ? '<strong>' + escapeHtml(scope.name) + '</strong><span>ID ' + escapeHtml(scope.object_id) + '</span>' : '<strong>Coorte Meta geral</strong>';
    const reference = card.reference === "overall" && scope ? "Referência geral validada" :
      card.reference === "overall_comparison" ? "Comparação com a média geral" : scope ? "Histórico próprio do ID" : "Critérios gerais";
    return '<article class="decision-card ' + card.severity + '">' +
      '<div class="decision-card-head"><span class="decision-category">' + decisionCategories[card.category] + '</span>' +
      '<span class="decision-badge ' + card.severity + '">' + decisionSeverities[card.severity] + '</span></div>' +
      '<h3>' + escapeHtml(card.title) + '</h3><div class="decision-scope">' + context + '</div>' +
      '<p>' + escapeHtml(card.detail) + '</p><div class="decision-metrics">' + card.metrics.map(item =>
        '<div><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(decisionValue(item)) + '</strong></div>').join("") + '</div>' +
      '<div class="decision-action"><strong>Próximo passo</strong><p>' + escapeHtml(card.action) + '</p></div>' +
      '<details><summary>Critérios usados · ' + escapeHtml(reference) + '</summary><ul>' +
      card.criteria.map(text => '<li>' + escapeHtml(text) + '</li>').join("") + '</ul></details>' +
      '<a class="decision-link" href="#' + card.target + '" data-decision-target="' + card.target + '">' +
      (card.target === "tracking" ? "Abrir Tracking Health" : card.target === "integrations" ? "Abrir integração UTMify" : "Ver cálculo e parâmetros") + ' →</a></article>';
  }).join("") : '<div class="panel decision-empty">' + (data.counts.total
    ? 'Nenhum diagnóstico atende aos filtros selecionados.'
    : 'Nenhum gatilho foi acionado neste período. Escopos elegíveis podem estar dentro da faixa econômica sem a folga exigida para uma oportunidade de escala.') + '</div>';
}
function renderDecisions(data) {
  decisionState.data = data;
  for (const [id, key] of [["decisionOpportunities", "opportunity"], ["decisionRisks", "risk"],
    ["decisionDataIssues", "data"], ["decisionEligible", "eligible_scopes"]]) {
    document.getElementById(id).textContent = Number(data.counts[key]).toLocaleString("pt-BR");
  }
  document.getElementById("decisionEligibleDetail").textContent = "de " + data.counts.analyzed_scopes + " escopos analisados";
  document.getElementById("decisionPeriod").textContent = displayIsoDate(data.range.from) + " → " + displayIsoDate(data.range.to) +
    " · janela de monetização de " + data.maturity_days + " dias · parâmetros v" + data.settings_revision;
  document.getElementById("decisionStatus").textContent = data.counts.eligible_scopes ? "Diagnósticos disponíveis" : "Aguardando dados confiáveis";
  document.getElementById("decisionStatus").className = "tracking-health-status " + (data.counts.eligible_scopes ? "good" : "warn");
  document.getElementById("decisionMessage").textContent = data.reference.eligible
    ? "Referência geral elegível. Cada escopo também precisa atender aos próprios critérios de amostra e conciliação."
    : "Referência geral provisória. Comparações de LTV e gasto sem compra aguardam validação; consulte as pendências.";
  document.getElementById("decisionUpdated").textContent = "Calculado em " + new Date(data.generated_at).toLocaleString("pt-BR") +
    (data.sync?.available ? " · snapshot UTMify #" + data.sync.sync_id : " · sem snapshot UTMify neste período");
  document.getElementById("decisionMethodology").textContent = data.methodology;
  renderDecisionCards();
}
function resetDecisionDisplay(message) {
  decisionState.data = null;
  for (const id of ["decisionOpportunities", "decisionRisks", "decisionDataIssues", "decisionEligible"]) document.getElementById(id).textContent = "—";
  document.getElementById("decisionCards").textContent = message;
  for (const id of ["decisionPeriod", "decisionUpdated", "decisionResultCount", "decisionEligibleDetail", "decisionMethodology"]) document.getElementById(id).textContent = "";
  document.getElementById("decisionMessage").textContent = message;
}
async function loadDecisions() {
  const request = ++decisionState.request, secret = utmifyAdminSecret();
  document.getElementById("decisionAuthPanel").hidden = Boolean(secret);
  document.getElementById("decisionWorkspace").hidden = !secret;
  resetDecisionDisplay(secret ? "Carregando diagnósticos deste período..." : "Conecte a sessão administrativa.");
  if (!secret) return;
  document.getElementById("decisionStatus").textContent = "Verificando";
  document.getElementById("decisionStatus").className = "tracking-health-status";
  const range = trackingHealthResolvedRange();
  const params = new URLSearchParams({ from: range.from, to: range.to, level: document.getElementById("decisionLevel").value });
  try {
    const response = await fetch("/api/decisions?" + params, { cache: "no-store", headers: { "x-admin-secret": secret } });
    const data = await response.json();
    if (request !== decisionState.request || secret !== utmifyAdminSecret()) return;
    if (!response.ok) { const error = new Error(data.error || "Não foi possível carregar a Central."); error.status = response.status; throw error; }
    renderDecisions(data);
  } catch (error) {
    if (request !== decisionState.request || secret !== utmifyAdminSecret()) return;
    resetDecisionDisplay(error.message);
    document.getElementById("decisionStatus").textContent = "Indisponível";
    document.getElementById("decisionStatus").className = "tracking-health-status critical";
    if (error.status === 401) {
      sessionStorage.removeItem("dr_admin_secret"); crmState.secret = "";
      document.getElementById("decisionAuthPanel").hidden = false;
      document.getElementById("decisionWorkspace").hidden = true;
    }
  }
}
function initDecisions() {
  document.getElementById("decisionGoCrm").addEventListener("click", () => { setActiveStage("crm"); history.replaceState(null, "", "#crm"); });
  document.getElementById("decisionRefresh").addEventListener("click", loadDecisions);
  document.getElementById("decisionLevel").addEventListener("change", loadDecisions);
  document.getElementById("decisionCategory").addEventListener("change", renderDecisionCards);
  document.getElementById("decisionSeverity").addEventListener("change", renderDecisionCards);
  document.getElementById("decisionSearch").addEventListener("input", renderDecisionCards);
  document.getElementById("decisionCards").addEventListener("click", event => {
    const link = event.target.closest("[data-decision-target]");
    if (!link) return;
    event.preventDefault();
    const target = link.dataset.decisionTarget;
    if (target === "cpa") document.getElementById("cpaLevel").value = document.getElementById("decisionLevel").value;
    setActiveStage(target); history.replaceState(null, "", "#" + target);
  });
}

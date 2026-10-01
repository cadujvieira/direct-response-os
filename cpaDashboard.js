const cpaState = { request: 0, revision: null, dirty: false, saving: false };
const cpaFields = [
  ["target_pct", "Objetivo (%)", 0, 10000],
  ["safety_discount_pct", "Desconto de segurança (%)", 0, 99],
  ["maturity_days", "Janela de monetização (dias)", 1, 90],
  ["min_buyers", "Amostra madura mínima", 5, 100000],
  ["fee_pct", "Taxa de venda (%)", 0, 100],
  ["fixed_fee", "Taxa fixa por transação (R$)", 0, 100000],
  ["tax_pct", "Impostos sobre receita após refunds (%)", 0, 100],
  ["split_pct", "Split sobre receita após refunds (%)", 0, 100],
  ["front_variable_cost", "Custo variável por comprador front (R$)", 0, 100000],
  ["mentorship_variable_cost", "Custo por transação de mentoria (R$)", 0, 1000000]
];
const cpaScenarioFields = [
  ["scenario_front_ticket", "Ticket bruto front (R$)", 0, 1000000],
  ["scenario_mentorship_rate_pct", "Compradores que fecham mentoria (%)", 0, 100],
  ["scenario_mentorship_ticket", "Ticket bruto da mentoria (R$)", 0, 1000000],
  ["scenario_bump_per_buyer", "Bump bruto esperado por comprador (R$)", 0, 1000000],
  ["scenario_refund_per_buyer", "Refund esperado por comprador (R$)", 0, 1000000]
];
const cpaStatusLabels = {
  scalable: "Escalável pelas regras", near_limit: "Perto do limite",
  above_limit: "Acima do limite", negative_contribution: "Contribuição negativa",
  provisional: "Provisório", insufficient_history: "Sem histórico maduro"
};
const cpaMoney = value => value == null ? "—" : formatMoney(value);
function cpaMessage(text) { document.getElementById("cpaMessage").textContent = text; }
function cpaFillSettings(data, force = false) {
  if (cpaState.dirty && !force) return;
  cpaState.revision = data.revision;
  cpaState.dirty = false;
  for (const [key, value] of Object.entries(data.settings || {})) {
    const input = document.getElementById("cpa_" + key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  }
  document.getElementById("cpaSettingsRevision").textContent = "Parâmetros salvos · revisão " + data.revision;
}
async function cpaFetch(url, options = {}) {
  const secret = utmifyAdminSecret();
  const response = await fetch(url, { ...options, cache: "no-store", headers: {
    "Content-Type": "application/json", "x-admin-secret": secret
  } });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Erro ao carregar CPA Máximo");
    error.status = response.status; throw error;
  }
  return data;
}
function cpaRender(data) {
  cpaFillSettings(data);
  const summary = data.summary || {}, e = summary.economics || {};
  document.getElementById("cpaCurrent").textContent = cpaMoney(summary.current_cpa);
  document.getElementById("cpaMaximum").textContent = cpaMoney(e.cpa_max);
  document.getElementById("cpaPrudent").textContent = cpaMoney(e.prudent_cpa_max);
  document.getElementById("cpaHeadroom").textContent = cpaMoney(summary.headroom);
  document.getElementById("cpaContribution").textContent = cpaMoney(e.contribution_per_buyer);
  document.getElementById("cpaSample").textContent = Number(summary.mature_buyers || 0).toLocaleString("pt-BR");
  document.getElementById("cpaSampleDetail").textContent = "de " + summary.total_buyers + " compradores Meta na coorte";
  const status = document.getElementById("cpaStatus");
  status.textContent = cpaStatusLabels[summary.status] || "Provisório";
  status.className = "tracking-health-status " + (summary.status === "scalable" ? "good" : summary.status === "above_limit" || summary.status === "negative_contribution" ? "critical" : "warn");
  document.getElementById("cpaPeriod").textContent = displayIsoDate(data.range.from) + " → " + displayIsoDate(data.range.to) +
    " · janela de " + data.settings.maturity_days + " dias · Tracking: " + trackingHealthStatusLabel(data.tracking_status);
  cpaMessage(summary.recommendation_eligible ? "Comparação elegível pelas regras de tracking e amostra. Revise o contexto antes de alterar a mídia." :
    "O limite calculado é provisório. Resolva as limitações abaixo antes de usá-lo para escala.");
  document.getElementById("cpaReasons").innerHTML = (summary.reasons || []).length ?
    '<ul>' + summary.reasons.map(r => '<li>' + escapeHtml(r.message) + '</li>').join("") + '</ul>' :
    '<p>Tracking, conciliação e amostra atendem às regras configuradas.</p>';
  const parts = [["Front bruto", e.front_per_buyer], ["Mentoria por comprador front", e.mentorship_per_buyer],
    ["Bump por comprador", e.bump_per_buyer], ["Refunds", e.refunds_per_buyer],
    ["Taxas", e.fees_per_buyer], ["Impostos", e.taxes_per_buyer], ["Split", e.split_per_buyer],
    ["Custos variáveis", e.variable_cost_per_buyer], ["Contribuição antes da mídia", e.contribution_per_buyer]];
  document.getElementById("cpaBreakdown").innerHTML = parts.map(([label,value]) =>
    '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(cpaMoney(value)) + '</strong></div>').join("");
  const scenario = data.scenario || {};
  document.getElementById("cpaScenarioResult").textContent = "Hipótese salva: contribuição " + cpaMoney(scenario.contribution_per_buyer) +
    " · CPA máximo " + cpaMoney(scenario.cpa_max) + " · limite prudente " + cpaMoney(scenario.prudent_cpa_max) + ". Cenários não liberam recomendação de escala.";
  const level = data.range.level;
  document.getElementById("cpaRows").innerHTML = data.rows.length ? data.rows.map(row => {
    const re = row.economics || {};
    const name = level === "ad" ? row.ad : level === "adset" ? row.adset : row.campaign;
    return '<tr><td><strong>' + escapeHtml(name || row.object_id) + '</strong><small class="cpa-row-detail">' + escapeHtml(row.object_id) + '</small></td>' +
      '<td>' + escapeHtml(cpaMoney(row.current_cpa)) + '</td><td>' + escapeHtml(cpaMoney(re.net_revenue_per_buyer)) + '</td>' +
      '<td>' + escapeHtml(cpaMoney(re.cpa_max)) + '</td><td>' + escapeHtml(cpaMoney(re.prudent_cpa_max)) + '</td>' +
      '<td>' + escapeHtml(cpaMoney(row.headroom)) + '</td><td>' + row.mature_buyers + ' / ' + row.total_buyers + '</td>' +
      '<td><strong>' + escapeHtml(cpaStatusLabels[row.status] || "Provisório") + '</strong>' +
      '<small class="cpa-row-detail">' + escapeHtml(row.reasons.map(r=>r.message).join(" ")) + '</small></td></tr>';
  }).join("") : '<tr><td colspan="8" class="table-loading">Sem objetos UTMify ou compradores atribuídos neste período.</td></tr>';
  document.getElementById("cpaMethodology").textContent = data.methodology +
    " Refunds após a janela continuam sendo descontados. Compradores sem ID neste nível: " + data.unassigned_buyers +
    ". Para calibrar com histórico maduro, escolha uma coorte que já completou a janela.";
}
async function loadCpa() {
  const request = ++cpaState.request, secret = utmifyAdminSecret();
  document.getElementById("cpaAuthPanel").hidden = Boolean(secret);
  document.getElementById("cpaWorkspace").hidden = !secret;
  if (!secret) return;
  const range = trackingHealthResolvedRange();
  const params = new URLSearchParams({ from: range.from, to: range.to, level: document.getElementById("cpaLevel").value });
  try {
    const data = await cpaFetch("/api/cpa-max?" + params);
    if (request !== cpaState.request || secret !== utmifyAdminSecret()) return;
    cpaRender(data);
  } catch (error) {
    if (request !== cpaState.request) return;
    document.getElementById("cpaStatus").textContent = "Indisponível";
    for (const id of ["cpaCurrent", "cpaMaximum", "cpaPrudent", "cpaHeadroom", "cpaContribution", "cpaSample"]) document.getElementById(id).textContent = "—";
    document.getElementById("cpaRows").innerHTML = '<tr><td colspan="8" class="table-loading">Não foi possível carregar este período.</td></tr>';
    cpaMessage(error.message);
    if (error.status === 401 || error.status === 503) document.getElementById("cpaWorkspace").hidden = true;
    if (error.status === 401) { document.getElementById("cpaAuthPanel").hidden = false; cpaState.revision = null; }
  }
}
function initCpa() {
  const fields = list => list.map(([key,label,min,max]) => '<label>' + label +
    '<input class="crm-control" id="cpa_' + key + '" type="number" min="' + min + '" max="' + max +
    '" step="' + (["maturity_days", "min_buyers"].includes(key) ? "1" : "0.01") + '" required></label>').join("");
  document.getElementById("cpaSettingsFields").innerHTML = fields(cpaFields);
  document.getElementById("cpaScenarioFields").innerHTML = fields(cpaScenarioFields);
  document.getElementById("cpaGoCrm").addEventListener("click", () => { setActiveStage("crm"); history.replaceState(null,"","#crm"); });
  document.getElementById("cpaRefresh").addEventListener("click", loadCpa);
  document.getElementById("cpaLevel").addEventListener("change", loadCpa);
  document.getElementById("cpaConfigForm").addEventListener("input", () => {
    cpaState.dirty = true;
    document.getElementById("cpaSettingsRevision").textContent = "Alterações não salvas. Os indicadores usam os parâmetros salvos.";
  });
  document.getElementById("cpaReloadSettings").addEventListener("click", async () => {
    try { cpaFillSettings(await cpaFetch("/api/cpa-max/settings"), true); } catch(error) { cpaMessage(error.message); }
  });
  document.getElementById("cpaConfigForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (cpaState.saving || !cpaState.revision) return;
    const settings = {};
    for (const [key] of [...cpaFields,...cpaScenarioFields]) settings[key] = Number(document.getElementById("cpa_" + key).value);
    settings.target_mode = document.getElementById("cpa_target_mode").value;
    settings.costs_confirmed = document.getElementById("cpa_costs_confirmed").checked;
    cpaState.saving = true; document.getElementById("cpaSaveSettings").disabled = true;
    try {
      const data = await cpaFetch("/api/cpa-max/settings", { method:"PUT", body:JSON.stringify({ settings, expected_revision:cpaState.revision }) });
      cpaFillSettings(data,true); await loadCpa();
    } catch(error) { cpaMessage(error.message); }
    finally { cpaState.saving=false; document.getElementById("cpaSaveSettings").disabled=false; }
  });
}

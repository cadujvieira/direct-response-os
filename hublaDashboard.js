// Painel da Hubla na aba Integracoes: estado da conexao e pendencias. Somente leitura, mais duas acoes
// explicitas (tentar de novo e informar valor de reembolso). Nunca mostra payloads nem dados do comprador.
const hublaState = { request: 0 };
const hublaStatusLabels = {
  pending_attribution: "Venda sem atribuição", pending_front_order: "Aguardando a compra front",
  pending_refund_confirmation: "Reembolso aguardando confirmação", unmapped_product: "Produto não configurado",
  needs_review: "Exige revisão", failed: "Falha; nova tentativa agendada", received: "Na fila", processing: "Processando"
};
// Explicacao em linguagem simples por codigo; o texto tecnico do servidor fica como reserva.
const hublaReasonLabels = {
  missing_click: "A compra chegou sem click_id. A página não repassou o clique ao checkout.",
  unknown_click: "O click_id recebido não existe no Oferta DR.",
  front_order_missing: "A compra front deste comprador ainda não entrou.",
  ambiguous_front_order: "O comprador tem mais de uma compra front; é preciso decidir a qual ligar a mentoria.",
  refund_unconfirmed: "Reembolso sem valor informado pela Hubla; pode ser parcial. Confira o valor na Hubla e informe ao lado.",
  unmapped_product: "Produto ou oferta ainda não configurado no Oferta DR.",
  product_conflict: "O mesmo ID está configurado em dois tipos de produto.",
  multi_product: "Venda com mais de um produto; a divisão do valor ainda não é automática.",
  child_invoice: "Fatura ligada a outra fatura; evitado para não contar a mesma venda duas vezes.",
  installment_followup: "Parcela seguinte de parcelamento inteligente; ainda não somada à receita.",
  unsupported_invoice_type: "Fatura de renovação ou upgrade; exige conferência.",
  currency: "Venda fora de reais ou liquidada em outra moeda.",
  amount: "Valores da fatura ausentes ou inválidos.",
  amount_units: "Os valores em reais e em centavos não batem neste aviso.",
  missing_paid_history: "O aviso não traz a data do pagamento no histórico da fatura.",
  paid_after_reversal: "A fatura voltou para paga depois de um reembolso ou chargeback já descontado.",
  refund_status_mismatch: "Aviso de reembolso para uma fatura que não está reembolsada.",
  missing_contact: "Comprador sem e-mail ou telefone válido.",
  ledger_conflict: "O aviso diverge do que já está registrado para este pedido.",
  canonical_rejected: "O aviso foi recusado pelas regras do funil.",
  bump_not_enabled: "Order bump ainda não habilitado.",
  unexpected_status: "A fatura paga mudou para uma situação não prevista.",
  invalid_invoice: "Aviso sem dados suficientes da fatura.",
  internal_error: "Falha interna; uma nova tentativa já está agendada.",
  stuck: "O processamento foi interrompido várias vezes; exige conferência.",
  busy: "Outro aviso da mesma fatura está sendo processado."
};
const hublaText = value => escapeHtml(value == null ? "" : String(value));
function hublaMessage(text, tone = "") {
  const node = document.getElementById("hublaMessage");
  node.textContent = text;
  node.className = "integration-message" + (tone ? " " + tone : "");
}
function hublaSet(id, value) { document.getElementById(id).textContent = value; }
function renderHublaStatus(data) {
  const live = data.live || {}, pending = data.payments_not_integrated || {}, reversals = data.reversals_not_integrated || {};
  const badge = document.getElementById("hublaStatusBadge");
  badge.textContent = data.provider_connected ? "Conectado" : data.token_configured ? "Token configurado, sem venda real" : "Não configurado";
  badge.className = "status-badge " + (data.provider_connected ? "active" : "");
  hublaSet("hublaLiveEvents", Number(live.events || 0).toLocaleString("pt-BR"));
  hublaSet("hublaLastEvent", live.last_received_at ? "Último: " + crmFormatDateTime(live.last_received_at) : "Nenhum aviso real recebido");
  hublaSet("hublaPendingPayments", Number(pending.invoices || 0).toLocaleString("pt-BR"));
  hublaSet("hublaPendingValue", Number(pending.invoices || 0) ? formatMoney(pending.known_value) + " ainda fora do funil" : "Todas as vendas recebidas entraram");
  hublaSet("hublaPendingReversals", Number(reversals.invoices || 0).toLocaleString("pt-BR"));
  hublaSet("hublaRecoveredClicks", Number(data.clicks_recovered_from_checkout || 0).toLocaleString("pt-BR"));
  const products = data.products_configured || {};
  hublaSet("hublaConfig", "Produtos: front " + Number(products.front || 0) + ", mentoria " + Number(products.mentorship || 0) +
    " · testes recebidos: " + Number((data.sandbox || {}).events || 0));
}
function renderHublaPending(events) {
  const body = document.getElementById("hublaPendingBody");
  if (!events.length) {
    body.innerHTML = '<tr><td class="crm-table-empty" colspan="5">Nenhuma pendência. Tudo que a Hubla enviou foi tratado.</td></tr>';
    return;
  }
  body.innerHTML = events.map(event => {
    const id = Number(event.id);
    const refund = event.status === "needs_review" && event.reason_code === "refund_unconfirmed";
    const action = refund
      ? '<input class="hubla-refund-input" type="number" min="0.01" step="0.01" placeholder="Valor em R$" aria-label="Valor reembolsado em reais" data-hubla-refund-value="' + id + '">' +
        '<button class="crm-secondary-btn" type="button" data-hubla-refund="' + id + '">Informar valor</button>'
      : '<button class="crm-secondary-btn" type="button" data-hubla-retry="' + id + '">Tentar de novo</button>';
    return "<tr><td>" + hublaText(crmFormatDateTime(event.received_at)) + "</td><td>" +
      hublaText(hublaStatusLabels[event.status] || event.status) + "<small>" + hublaText(String(event.invoice_id || "").slice(0, 8)) + "</small></td><td>" +
      (event.amount == null ? "—" : hublaText(formatMoney(event.amount))) + "</td><td>" +
      hublaText(hublaReasonLabels[event.reason_code] || event.reason || "") +
      '</td><td><div class="hubla-actions">' + action + "</div></td></tr>";
  }).join("");
}
async function loadHublaPanel(keepMessage) {
  if (!document.getElementById("hublaCard") || !utmifyAdminSecret()) return;
  const request = ++hublaState.request;
  try {
    const [status, pending] = await Promise.all([
      utmifyFetch("/api/integrations/hubla/status"),
      utmifyFetch("/api/integrations/hubla/events?pending=true&sandbox=false&limit=100")
    ]);
    if (request !== hublaState.request) return; // resposta antiga nao sobrescreve a mais nova
    renderHublaStatus(status);
    renderHublaPending(pending.events || []);
    if (keepMessage !== true) hublaMessage("");
  } catch (error) {
    if (request !== hublaState.request) return;
    hublaMessage(error.status === 401 ? "Conecte a sessão administrativa pelo CRM." : "Não foi possível carregar o estado da Hubla.", "error");
  }
}
async function hublaAction(button, path, body, done) {
  const original = button.textContent;
  button.disabled = true; button.textContent = "Enviando...";
  try {
    await utmifyFetch(path, { method: "POST", body: JSON.stringify(body) });
    await loadHublaPanel(true);
    hublaMessage(done, "ok");
  } catch (error) {
    hublaMessage(error.status === 409 ? "Não foi possível concluir: " + (error.message || "confira o pedido na Hubla") : "Falha ao enviar. Tente novamente.", "error");
    button.disabled = false; button.textContent = original;
  }
}
function initHublaPanel() {
  const card = document.getElementById("hublaCard");
  if (!card) return;
  card.addEventListener("click", event => {
    const retry = event.target.closest("[data-hubla-retry]"), refund = event.target.closest("[data-hubla-refund]");
    if (retry) hublaAction(retry, "/api/integrations/hubla/events/" + Number(retry.dataset.hublaRetry) + "/retry", {}, "Aviso reprocessado.");
    if (refund) {
      const input = card.querySelector('[data-hubla-refund-value="' + Number(refund.dataset.hublaRefund) + '"]');
      const value = Math.round(Number(input && input.value) * 100) / 100;
      if (!Number.isFinite(value) || value <= 0) { hublaMessage("Informe o valor reembolsado, conferido na Hubla.", "error"); return; }
      hublaAction(refund, "/api/integrations/hubla/events/" + Number(refund.dataset.hublaRefund) + "/resolve-refund",
        { value: value }, "Reembolso registrado.");
    }
  });
  document.getElementById("hublaRefreshBtn").addEventListener("click", () => loadHublaPanel());
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHublaPanel);
else initHublaPanel();

// Aba Checkout: quem chegou a gerar pagamento na Hubla (Pix, boleto ou cartao), agrupado por pessoa, e por campanha.
// Somente leitura. Sem nome, e-mail ou telefone: o codigo da fatura serve para achar a pessoa no painel da Hubla.
const hublaCheckoutState = { request: 0 };
const hublaOutcomeTone = { pago: "ok", cartao_nao_aprovado: "danger", pix_sem_pagamento: "warn", boleto_sem_pagamento: "warn" };
function hublaCheckoutCard(label, value, sub, tip) {
  return '<div class="card"><div class="metric-label"' + (tip ? ' data-tooltip="' + hublaText(tip) + '"' : "") + ">" + hublaText(label) +
    '</div><div class="metric-value">' + hublaText(value) + '</div><div class="metric-sub">' + hublaText(sub) + "</div></div>";
}
// Contato so vem do servidor para quem nao pagou. Mensagem pronta no WhatsApp, editavel antes de enviar.
function hublaContactHtml(person) {
  const c = person.contact;
  if (!c) return person.outcome === "pago" ? '<span class="hubla-muted">—</span>' : '<span class="hubla-muted">Sem contato no aviso</span>';
  const first = String(c.name || "").trim().split(/\s+/)[0] || "";
  const reason = person.outcome === "cartao_nao_aprovado" ? "o pagamento no cartão não foi aprovado"
    : person.outcome === "boleto_sem_pagamento" ? "o boleto ficou em aberto" : "o Pix ficou pendente";
  const message = "Oi" + (first ? " " + first : "") + "! Vi que você tentou garantir sua vaga e " + reason +
    ". Posso te ajudar a finalizar?";
  const phone = String(c.phone || "").replace(/\D/g, "");
  return '<div class="hubla-contact">' + (c.name ? "<strong>" + hublaText(c.name) + "</strong>" : "") +
    (phone ? '<a class="hubla-wa" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + phone + "?text=" +
      encodeURIComponent(message) + '">WhatsApp +' + hublaText(phone) + "</a>" : "") +
    (c.email ? '<a href="mailto:' + encodeURIComponent(c.email).replace(/%40/g, "@") + '">' + hublaText(c.email) + "</a>" : "") + "</div>";
}
function renderHublaCheckoutReport(data) {
  const s = data.summary || {}, people = data.people || [], campaigns = data.campaigns || [];
  const by = s.by_outcome || {};
  const pending = (by["Pix gerado e não pago"] || 0) + (by["Boleto gerado e não pago"] || 0);
  document.getElementById("hublaCheckoutCards").innerHTML =
    hublaCheckoutCard("Pessoas no checkout", Number(s.people || 0).toLocaleString("pt-BR"),
      Number(s.attempts || 0) + (Number(s.attempts) === 1 ? " tentativa" : " tentativas") + " de pagamento",
      "Pessoas que chegaram a gerar Pix ou boleto ou a passar cartão na Hubla. A Meta conta 'checkout iniciado' já no clique do botão, por isso o número dela é maior.") +
    hublaCheckoutCard("Pagaram", Number(s.paid || 0).toLocaleString("pt-BR"), formatMoney(s.paid_value || 0)) +
    hublaCheckoutCard("Cartão recusado", Number(by["Cartão não aprovado"] || 0).toLocaleString("pt-BR"), "Sem pagamento até agora",
      "Pessoa que passou cartão e a Hubla não aprovou. Boa chance de recuperar oferecendo Pix ou outro cartão.") +
    hublaCheckoutCard("Pix/boleto não pago", Number(pending).toLocaleString("pt-BR"), "Gerou e não pagou");
  const peopleBody = document.getElementById("hublaCheckoutPeople");
  peopleBody.innerHTML = people.length ? people.map(p => {
    const tone = hublaOutcomeTone[p.outcome] || "";
    return "<tr><td>" + hublaText(crmFormatDateTime(p.last_at)) + '</td><td><span class="hubla-outcome ' + tone + '">' +
      hublaText(p.outcome_label) + '</span><small class="hubla-when">' + hublaText(crmFormatDateTime(p.last_at)) + "</small></td><td>" + hublaContactHtml(p) + "</td><td>" + hublaText(p.campaign) +
      (p.has_click_id ? "" : "<small>sem código do clique</small>") + "</td><td>" + hublaText((p.payment_methods || []).join(" + ")) +
      "</td><td>" + Number(p.attempts || 0) + "</td><td>" + (p.amount == null ? "—" : hublaText(formatMoney(p.amount))) + "</td><td>" +
      '<span title="' + hublaText((p.invoices || []).join(", ")) + '">' + hublaText((p.invoices || [])[0] || "—") +
      ((p.invoices || []).length > 1 ? " <small>+" + ((p.invoices || []).length - 1) + " fatura(s)</small>" : "") + "</span></td></tr>";
  }).join("") : '<tr><td class="crm-table-empty" colspan="8">Ninguém chegou a gerar pagamento na Hubla neste período.</td></tr>';
  const campaignBody = document.getElementById("hublaCheckoutCampaigns");
  campaignBody.innerHTML = campaigns.length ? campaigns.map(c => "<tr><td>" + hublaText(c.campaign) + "</td><td>" +
    Number(c.people || 0) + "</td><td>" + Number(c.paid || 0) + "</td><td>" + hublaText(formatMoney(c.paid_value || 0)) + "</td></tr>").join("")
    : '<tr><td class="crm-table-empty" colspan="4">Sem dados no período.</td></tr>';
  const first = data.webhook_first_notice_at;
  const other = Number(s.other_product_invoices || 0);
  document.getElementById("hublaCheckoutNote").textContent =
    "Pessoas que geraram Pix ou boleto ou passaram cartão na Hubla." +
    (first ? " Dados da Hubla desde " + crmFormatDateTime(first) + "." : "") +
    (other ? " " + other + (other === 1 ? " fatura de outro produto ficou de fora." : " faturas de outros produtos ficaram de fora.") : "");
  if (typeof decorateTooltips === "function") decorateTooltips(document.getElementById("hublaCheckoutPanel"));
}
async function loadHublaCheckoutReport() {
  const panel = document.getElementById("hublaCheckoutPanel");
  if (!panel) return;
  if (!utmifyAdminSecret()) {
    document.getElementById("hublaCheckoutNote").textContent = "Conecte a sessão administrativa pelo CRM para ver quem chegou ao checkout.";
    return;
  }
  const request = ++hublaCheckoutState.request;
  const range = typeof reportRange === "object" && reportRange ? reportRange : {};
  const query = range.from && range.to ? "?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to) : "";
  try {
    const data = await utmifyFetch("/api/integrations/hubla/checkout-report" + query);
    if (request !== hublaCheckoutState.request) return; // resposta antiga nao sobrescreve a mais nova
    renderHublaCheckoutReport(data);
  } catch (error) {
    if (request !== hublaCheckoutState.request) return;
    document.getElementById("hublaCheckoutNote").textContent = error.status === 401
      ? "Conecte a sessão administrativa pelo CRM para ver quem chegou ao checkout." : "Não foi possível carregar o checkout da Hubla.";
  }
}

// Desempenho por landing page na aba Router. Compara as LPs de cada rota no periodo selecionado no topo
// do painel. A leitura "na frente" so aparece com amostra minima e diferenca fora da margem de acaso.
const ROUTER_MIN_BUYERS = 30;
const routerPerfState = { request: 0 };
const routerNumber = value => Number(value || 0).toLocaleString("pt-BR");
function routerRate(part, total) { return total > 0 ? (part / total) * 100 : null; }
// Teste de duas proporcoes (compradores / cliques). |z| >= 1,96 equivale a cerca de 95% de confianca.
function routerZ(a, b) {
  const n1 = Number(a.assigned_clicks), n2 = Number(b.assigned_clicks), x1 = Number(a.buyers), x2 = Number(b.buyers);
  if (!(n1 > 0) || !(n2 > 0)) return 0;
  const pooled = (x1 + x2) / (n1 + n2), spread = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return spread > 0 ? (x1 / n1 - x2 / n2) / spread : 0;
}
function routerVerdict(rows) {
  const active = rows.filter(row => Number(row.assigned_clicks) > 0);
  if (active.length < 2) return { tone: "", text: active.length ? "Só uma LP recebeu tráfego neste período; não há comparação." : "Nenhum clique distribuído neste período." };
  // So entram na comparacao as LPs que ja tem a amostra minima; as demais sao citadas, nao julgadas.
  const ready = active.filter(row => Number(row.buyers) >= ROUTER_MIN_BUYERS)
    .sort((a, b) => (Number(b.buyers) / Number(b.assigned_clicks)) - (Number(a.buyers) / Number(a.assigned_clicks)));
  const waiting = active.length - ready.length;
  const pending = waiting ? " " + (waiting === 1 ? "1 LP ainda tem" : waiting + " LPs ainda têm") + " menos de " + ROUTER_MIN_BUYERS + " compradores e não entrou na comparação." : "";
  if (ready.length < 2) return { tone: "", text: "Ainda não dá para apontar a melhor: é preciso ter pelo menos duas LPs com " + ROUTER_MIN_BUYERS +
    " compradores cada. Até lá, as diferenças podem ser acaso." };
  const first = ready[0], second = ready[1];
  if (Math.abs(routerZ(first, second)) < 1.96) return { tone: "", text: "As duas melhores LPs em conversão (" + first.variant + " e " + second.variant +
    ") estão tecnicamente empatadas: a diferença ainda cabe na margem de acaso." + pending };
  return { tone: "ok", leader: first.variant_id, text: "Na frente em conversão: " + first.variant + ". Confira também o líquido por clique antes de mover o tráfego." + pending };
}
function renderRouterPerformance(node, rows) {
  if (!rows.length) { node.innerHTML = '<div class="section-empty">Sem LPs cadastradas nesta rota.</div>'; return; }
  const verdict = routerVerdict(rows);
  const body = rows.map(row => {
    const clicks = Number(row.assigned_clicks), buyers = Number(row.buyers), conversion = routerRate(buyers, clicks);
    const net = Number(row.net_revenue || 0), perClick = clicks > 0 ? net / clicks : null;
    const few = clicks > 0 && buyers < ROUTER_MIN_BUYERS;
    return "<tr" + (verdict.leader === row.variant_id ? ' class="router-leader"' : "") + "><td>" + escapeHtml(row.variant || "LP") +
      (row.active === false || !(Number(row.weight) > 0) ? "<small>fora da rotação</small>" : few ? "<small>amostra pequena</small>" : "") + "</td><td>" +
      routerNumber(clicks) + "</td><td>" + routerNumber(buyers) + "</td><td>" + (conversion == null ? "—" : formatPercent(conversion)) + "</td><td>" +
      escapeHtml(formatMoney(row.front_revenue)) + "</td><td>" + escapeHtml(formatMoney(row.mentorship_revenue)) + "</td><td>" +
      escapeHtml(formatMoney(row.refunds)) + "</td><td>" + escapeHtml(formatMoney(net)) + "</td><td>" +
      (perClick == null ? "—" : escapeHtml(formatMoney(perClick))) + "</td></tr>";
  }).join("");
  node.innerHTML = '<div class="router-verdict ' + verdict.tone + '">' + escapeHtml(verdict.text) + "</div>" +
    '<div class="crm-table-wrap"><table class="crm-table router-table"><thead><tr><th>Landing page</th><th>Cliques</th>' +
    '<th data-tooltip="Cliques que geraram pelo menos uma compra front.">Compradores</th><th data-tooltip="Compradores divididos pelos cliques enviados a esta LP.">Conversão</th>' +
    "<th>Front</th><th>Mentoria</th><th>Reembolsos</th>" +
    '<th data-tooltip="Front + mentoria + bump, menos reembolsos e chargebacks.">Líquido</th>' +
    '<th data-tooltip="Receita líquida dividida pelos cliques. É a medida que junta conversão, mentoria e reembolso.">Líquido por clique</th></tr></thead><tbody>' +
    body + "</tbody></table></div>";
  if (typeof decorateTooltips === "function") decorateTooltips(node);
}
async function loadRouterPerformance() {
  const nodes = [...document.querySelectorAll("[data-router-slug]")];
  if (!nodes.length) return;
  const request = ++routerPerfState.request;
  const range = typeof reportRange === "object" && reportRange ? reportRange : {};
  const query = range.from && range.to ? "?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to) : "";
  await Promise.all(nodes.map(async node => {
    try {
      const response = await fetch("/api/experiments/" + encodeURIComponent(node.dataset.routerSlug) + "/performance" + query, { cache: "no-store" });
      if (!response.ok) throw new Error("erro");
      const data = await response.json();
      if (request !== routerPerfState.request || !node.isConnected) return; // resposta antiga nao sobrescreve a mais nova
      renderRouterPerformance(node, Array.isArray(data.variants) ? data.variants : []);
    } catch (error) {
      if (request === routerPerfState.request && node.isConnected) node.innerHTML = '<div class="section-empty">Não foi possível carregar o desempenho desta rota.</div>';
    }
  }));
}

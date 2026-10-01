const { getCpaReport } = require("./cpaEngine");
const { requireAdmin } = require("./trackingHealth");

const RULES = Object.freeze({
  scale_prudent_headroom_pct: 20,
  high_ltv_multiple: 2,
  cheap_front_cpa_ratio: 0.8,
  low_ltv_ratio: 0.75,
  low_mentorship_ratio: 0.5,
  no_purchase_spend_multiple: 1.4,
  no_purchase_min_closed_days: 3,
  max_cards: 100
});
const GLOBAL_CODES = new Set(["costs_unconfirmed", "currency_mismatch", "stale_snapshot",
  "snapshot_missing", "tracking_unreliable"]);
const NO_PURCHASE_CODES = new Set(["small_sample", "no_media_purchases"]);
const finite = value => value != null && Number.isFinite(Number(value));
const metric = (key, label, value, format = "money") => ({ key, label,
  value: format === "text" ? String(value ?? "—") : finite(value) ? Number(value) : null, format });
const reportingDay = now => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo",
  year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

function buildDecisions(report, now = new Date()) {
  const summary = report.summary, baseline = summary.economics;
  const globalReasons = summary.reasons.filter(reason => GLOBAL_CODES.has(reason.code));
  const globalReady = globalReasons.length === 0;
  const referenceReady = globalReady && summary.recommendation_eligible;
  const closedPeriod = report.range.to < reportingDay(now) && report.range.days >= RULES.no_purchase_min_closed_days;
  const cards = [];
  const level = report.range.level;
  const scopeOf = row => row ? { level, object_id: row.object_id,
    name: row[level === "ad" ? "ad" : level === "adset" ? "adset" : "campaign"] || row.object_id,
    campaign: row.campaign, adset: row.adset } : null;
  const add = (row, kind, category, severity, title, detail, action, metrics, criteria, target = "cpa", reference = "scope") => {
    cards.push({ id: JSON.stringify([level, row?.object_id ?? null, kind]), kind, category, severity,
      title, detail, action, target, scope: scopeOf(row), reference,
      metrics, criteria, spend: finite(row?.spend) ? Number(row.spend) : 0 });
  };
  const rowMetrics = row => [metric("current_cpa", "CPA atual", row.current_cpa),
    metric("cpa_max", "CPA máximo", row.economics?.cpa_max),
    metric("prudent_cpa_max", "Limite prudente", row.economics?.prudent_cpa_max),
    metric("mature_buyers", "Compradores maduros", row.mature_buyers, "count"),
    metric("mature_revenue_roas", "ROAS líquido maduro", row.spend > 0 && row.economics
      ? row.economics.net_revenue_per_buyer * row.mature_buyers / row.spend : null, "multiple")];
  const qualified = report.rows.filter(row => globalReady && row.recommendation_eligible);
  const summaryReasons = summary.reasons.filter(reason => reason.code !== "immature_cohort");
  if (summaryReasons.length) {
    const critical = globalReasons.some(reason => reason.code === "currency_mismatch") ||
      report.tracking_status === "critical";
    const target = globalReasons.some(reason => ["stale_snapshot", "snapshot_missing"].includes(reason.code))
      ? "integrations" : globalReasons.some(reason => reason.code === "tracking_unreliable") ? "tracking" : "cpa";
    add(null, "readiness", "data", critical ? "critical" : "attention",
      globalReady && qualified.length ? "Referência geral ainda provisória" : "Resolva as pendências antes de decidir",
      globalReady && qualified.length
        ? "Escopos com critérios próprios atendidos podem ter diagnóstico; comparações com a média geral aguardam validação."
        : "As oportunidades dependem da conciliação, dos custos e do histórico maduro. Os números provisórios não liberam recomendações.",
      "Revise as limitações listadas e atualize os dados ou parâmetros indicados.",
      [metric("tracking", "Tracking Health", report.tracking_status, "text"),
        metric("mature_buyers", "Compradores maduros", summary.mature_buyers, "count")],
      summaryReasons.map(reason => reason.message), target, "overall");
  }
  if (report.unassigned_buyers > 0) {
    add(null, "unassigned", "data", "attention", "Compradores sem ID neste nível",
      "Parte da coorte não pode ser comparada por campanha, conjunto ou anúncio neste nível.",
      "Revise a captura dos IDs no Tracking Health.",
      [metric("unassigned_buyers", "Sem ID", report.unassigned_buyers, "count")],
      ["Atribuição por ID exato; nomes não substituem IDs ausentes."], "tracking", "overall");
  }
  for (const row of report.rows) {
    const e = row.economics;
    const ready = globalReady && row.recommendation_eligible;
    const noPurchase = referenceReady && baseline?.cpa_max > 0 && closedPeriod &&
      row.total_buyers === 0 && row.media_purchases === 0 &&
      row.spend >= baseline.cpa_max * RULES.no_purchase_spend_multiple &&
      row.reasons.every(reason => NO_PURCHASE_CODES.has(reason.code));
    if (noPurchase) {
      add(row, "spend_without_purchase", "risk", "attention", "Revisar gasto sem compra",
        "O gasto atingiu o limiar de revisão sem compra front em DR e UTMify. Este escopo usa a referência geral validada, pois ainda não possui LTV próprio.",
        "Confira a janela de conversão e a entrega do tráfego antes de decidir reduzir ou pausar.",
        [metric("spend", "Gasto sem compra", row.spend), metric("reference_cpa", "CPA máximo geral", baseline.cpa_max),
          metric("spend_multiple", "Gasto / limite geral", row.spend / baseline.cpa_max, "multiple")],
        ["Período encerrado com pelo menos 3 dias; zero compras nas duas fontes.",
          "Gasto ≥ 1,4× CPA máximo geral; referência com todos os critérios do CPA Máximo atendidos."], "cpa", "overall");
      continue;
    }
    if (!ready) {
      const reasons = row.reasons.filter(reason => !GLOBAL_CODES.has(reason.code) && reason.code !== "immature_cohort");
      if (globalReady && reasons.length && (row.spend > 0 || row.total_buyers > 0)) {
        add(row, "scope_pending", "data", "information", "Diagnóstico deste escopo em formação",
          "Os critérios próprios ainda não permitem uma recomendação econômica para este ID.",
          "Revise a conciliação ou aguarde a maturação da amostra.", rowMetrics(row),
          reasons.map(reason => reason.message));
      }
      continue;
    }
    if (e.contribution_per_buyer <= 0) {
      add(row, "negative_contribution", "risk", "critical", "Contribuição negativa antes da mídia",
        "Receita após refunds, taxas, split e custos não cobre a entrega da oferta, mesmo antes do gasto de aquisição.",
        "Revise custos, refunds e monetização antes de ampliar a aquisição.",
        [...rowMetrics(row), metric("contribution", "Contribuição / comprador", e.contribution_per_buyer)],
        ["Contribuição observada ≤ 0; custos, tracking e amostra atendem aos critérios configurados."]);
      continue;
    }
    if (row.current_cpa > e.cpa_max) {
      add(row, "above_limit", "risk", "critical", "CPA acima do limite econômico",
        "O CPA atual excede o máximo calculado para preservar o objetivo configurado deste escopo.",
        "Revise a aquisição e a monetização; avalie redução de exposição após conferir o contexto.",
        [...rowMetrics(row), metric("headroom", "Folga até o máximo", row.headroom)],
        ["CPA atual > CPA máximo próprio; histórico maduro e conciliação atendem aos critérios."]);
    } else if (row.current_cpa > e.prudent_cpa_max) {
      add(row, "near_limit", "risk", "attention", "CPA consumindo a reserva de segurança",
        "O CPA permanece dentro do máximo calculado, mas já supera o limite prudente.",
        "Acompanhe o CPA e a conversão para mentoria antes de ampliar o orçamento.", rowMetrics(row),
        ["Limite prudente < CPA atual ≤ CPA máximo próprio."]);
    } else if (e.prudent_cpa_max > 0 && row.current_cpa <= e.prudent_cpa_max * (1 - RULES.scale_prudent_headroom_pct / 100)) {
      add(row, "scale_opportunity", "opportunity", "information", "Oportunidade de escala",
        "O CPA atual está pelo menos 20% abaixo do limite prudente calculado com o histórico próprio.",
        "Avalie um teste controlado de escala e acompanhe o CPA em relação ao limite prudente.",
        [...rowMetrics(row), metric("prudent_headroom_pct", "Folga prudente", (e.prudent_cpa_max - row.current_cpa) / e.prudent_cpa_max * 100, "percent")],
        ["CPA atual ≤ 80% do limite prudente; custos, tracking, conciliação e amostra atendem aos critérios."]);
    }
    if (referenceReady && baseline.net_revenue_per_buyer > 0 && e.net_revenue_per_buyer >= baseline.net_revenue_per_buyer * RULES.high_ltv_multiple) {
      add(row, "high_ltv", "opportunity", "information", level === "ad" ? "Criativo de alto LTV" : "Escopo de alto LTV",
        "O LTV líquido observado por comprador maduro é pelo menos 2× a média geral da mesma coorte e janela.",
        "Estude a oferta e o público deste escopo; confira o CPA próprio antes de priorizar investimento.",
        [metric("ltv", "LTV líquido na janela", e.net_revenue_per_buyer),
          metric("reference_ltv", "LTV líquido geral", baseline.net_revenue_per_buyer),
          metric("ltv_multiple", "LTV / média geral", e.net_revenue_per_buyer / baseline.net_revenue_per_buyer, "multiple"),
          metric("mature_revenue_roas", "ROAS líquido maduro", row.spend > 0 ? e.net_revenue_per_buyer * row.mature_buyers / row.spend : null, "multiple")],
        ["LTV ≥ 2× média geral ponderada por compradores maduros; ambas as amostras são elegíveis.",
          "ROAS líquido maduro = receita líquida da amostra madura / gasto total da coorte; receitas dos imaturos não entram."], "cpa", "overall_comparison");
    }
    if (referenceReady && summary.current_cpa > 0 && baseline.net_revenue_per_buyer > 0 &&
      baseline.mentorship_attach_rate_pct > 0 && row.current_cpa <= summary.current_cpa * RULES.cheap_front_cpa_ratio &&
      e.net_revenue_per_buyer <= baseline.net_revenue_per_buyer * RULES.low_ltv_ratio &&
      e.mentorship_attach_rate_pct <= baseline.mentorship_attach_rate_pct * RULES.low_mentorship_ratio) {
      add(row, "front_false_winner", "risk", "attention", "Front barato, monetização abaixo da média",
        "O CPA front é baixo, mas o LTV e a conversão para mentoria ficam abaixo da média geral. Pode parecer vencedor ao olhar apenas a entrada.",
        "Compare a contribuição total e o funil de mentoria antes de priorizar este escopo.",
        [metric("current_cpa", "CPA atual", row.current_cpa), metric("reference_cpa", "CPA atual geral", summary.current_cpa),
          metric("ltv", "LTV líquido na janela", e.net_revenue_per_buyer),
          metric("mentorship_rate", "Conversão para mentoria", e.mentorship_attach_rate_pct, "percent")],
        ["CPA ≤ 80% da média; LTV ≤ 75% da média; conversão para mentoria ≤ 50% da média.",
          "Comparação de amostras maduras elegíveis; monetização inferior não implica prejuízo."], "cpa", "overall_comparison");
    }
  }
  const severityOrder = { critical: 0, attention: 1, information: 2 };
  const categoryOrder = { data: 0, risk: 1, opportunity: 2 };
  cards.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] ||
    categoryOrder[a.category] - categoryOrder[b.category] || b.spend - a.spend || a.id.localeCompare(b.id));
  const counts = { total: cards.length, opportunity: 0, risk: 0, data: 0,
    critical: 0, attention: 0, information: 0, analyzed_scopes: report.rows.length,
    eligible_scopes: qualified.length, returned: Math.min(cards.length, RULES.max_cards) };
  for (const card of cards) { counts[card.category]++; counts[card.severity]++; }
  return { range: report.range, generated_at: now.toISOString(), rules_version: 1, rules: RULES,
    settings_revision: report.revision, maturity_days: report.settings.maturity_days,
    tracking_status: report.tracking_status, sync: report.sync, counts,
    reference: { eligible: referenceReady, mature_buyers: summary.mature_buyers,
      current_cpa: summary.current_cpa, cpa_max: baseline?.cpa_max ?? null,
      prudent_cpa_max: baseline?.prudent_cpa_max ?? null, ltv: baseline?.net_revenue_per_buyer ?? null },
    cards: cards.slice(0, RULES.max_cards),
    methodology: "Mesma coorte Meta, primeira compra por click_id e IDs exatos do CPA Máximo. LTV líquido após refunds na janela configurada; custos e objetivo usam os parâmetros salvos. ROAS líquido maduro divide a receita líquida da amostra madura pelo gasto total da coorte, sem somar receitas de compradores imaturos. Diagnósticos para revisão e ação manual."
  };
}
async function getDecisionReport(pool, input) {
  return buildDecisions(await getCpaReport(pool, input));
}
function registerDecisionRoutes(app, pool) {
  app.get("/assets/decision-dashboard.js", (req, res) => res.sendFile(__dirname + "/decisionDashboard.js"));
  app.get("/api/decisions", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...await getDecisionReport(pool, req.query) }); }
    catch (error) { res.status(error.statusCode || 500).json({ ok: false,
      error: error.statusCode ? error.message : "erro interno" }); }
  });
}
module.exports = { RULES, buildDecisions, getDecisionReport, registerDecisionRoutes };

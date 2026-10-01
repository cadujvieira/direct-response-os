const { getTrackingHealth, requireAdmin } = require("./trackingHealth");
const { performanceRow } = require("./utmifyMcp");

const DEFAULT_SETTINGS = Object.freeze({
  target_mode: "contribution_reserve", target_pct: 30,
  safety_discount_pct: 10, maturity_days: 30, min_buyers: 30,
  fee_pct: 0, fixed_fee: 0, tax_pct: 0, split_pct: 0,
  front_variable_cost: 0, mentorship_variable_cost: 0,
  costs_confirmed: false,
  scenario_front_ticket: 297, scenario_mentorship_rate_pct: 0,
  scenario_mentorship_ticket: 0, scenario_bump_per_buyer: 0,
  scenario_refund_per_buyer: 0
});
const LIMITS = {
  target_pct: [0, 10000], safety_discount_pct: [0, 99],
  maturity_days: [1, 90], min_buyers: [5, 100000],
  fee_pct: [0, 100], fixed_fee: [0, 100000], tax_pct: [0, 100],
  split_pct: [0, 100], front_variable_cost: [0, 100000],
  mentorship_variable_cost: [0, 1000000],
  scenario_front_ticket: [0, 1000000], scenario_mentorship_rate_pct: [0, 100],
  scenario_mentorship_ticket: [0, 1000000], scenario_bump_per_buyer: [0, 1000000],
  scenario_refund_per_buyer: [0, 1000000]
};
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
function fail(message, statusCode = 400) {
  const error = new Error(message); error.statusCode = statusCode; throw error;
}
function normalizeSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("configuracao invalida");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) fail("campo desconhecido: " + key);
  }
  const config = { ...DEFAULT_SETTINGS, ...input };
  if (!["contribution_reserve", "media_roi"].includes(config.target_mode)) fail("objetivo invalido");
  if (typeof config.costs_confirmed !== "boolean") fail("confirme os custos com um booleano");
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(key + " fora do intervalo permitido");
  }
  if (config.target_mode === "contribution_reserve" && config.target_pct >= 100) fail("reserva deve ser menor que 100%");
  if (!Number.isInteger(config.maturity_days) || !Number.isInteger(config.min_buyers)) fail("janela e amostra devem ser inteiras");
  return config;
}
function validateRange(input = {}) {
  for (const key of ["from", "to"]) {
    const value = input[key];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(key + " deve usar YYYY-MM-DD");
    const date = new Date(value + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(key + " invalido");
  }
  const days = (new Date(input.to) - new Date(input.from)) / 86400000 + 1;
  if (days < 1 || days > 31) fail("CPA Maximo aceita um periodo de 1 a 31 dias, igual ao snapshot UTMify");
  if (input.level && !["campaign", "adset", "ad"].includes(input.level)) fail("nivel invalido");
  return { from: input.from, to: input.to, days, level: input.level || "campaign" };
}
function calculateUnitEconomics(sample = {}, config = DEFAULT_SETTINGS) {
  const buyers = num(sample.mature_buyers);
  if (buyers <= 0) return null;
  const front = num(sample.front_revenue), mentorship = num(sample.mentorship_revenue);
  const bump = num(sample.bump_revenue), refunds = num(sample.refunds);
  const gross = front + mentorship + bump;
  const netRevenue = gross - refunds;
  // Fees are assumed non-refundable; tax/split base is revenue after refunds.
  const fees = gross * config.fee_pct / 100 +
    (buyers + num(sample.mentorship_transactions) + num(sample.bump_transactions)) * config.fixed_fee;
  const taxes = Math.max(netRevenue, 0) * config.tax_pct / 100;
  const split = Math.max(netRevenue, 0) * config.split_pct / 100;
  const variableCosts = buyers * config.front_variable_cost +
    num(sample.mentorship_transactions) * config.mentorship_variable_cost;
  const contribution = (netRevenue - fees - taxes - split - variableCosts) / buyers;
  const rawLimit = config.target_mode === "media_roi"
    ? contribution / (1 + config.target_pct / 100)
    : contribution * (1 - config.target_pct / 100);
  const cpaMax = Math.max(rawLimit, 0);
  return {
    buyers, front_per_buyer: money(front / buyers),
    mentorship_per_buyer: money(mentorship / buyers), bump_per_buyer: money(bump / buyers),
    refunds_per_buyer: money(refunds / buyers), net_revenue_per_buyer: money(netRevenue / buyers),
    fees_per_buyer: money(fees / buyers), taxes_per_buyer: money(taxes / buyers),
    split_per_buyer: money(split / buyers), variable_cost_per_buyer: money(variableCosts / buyers),
    contribution_per_buyer: money(contribution), cpa_max: money(cpaMax),
    prudent_cpa_max: money(cpaMax * (1 - config.safety_discount_pct / 100)),
    mentorship_attach_rate_pct: num(sample.mentorship_buyers) / buyers * 100
  };
}
function scenarioEconomics(config) {
  const attach = config.scenario_mentorship_rate_pct / 100;
  return calculateUnitEconomics({
    mature_buyers: 1, front_revenue: config.scenario_front_ticket,
    mentorship_revenue: attach * config.scenario_mentorship_ticket,
    mentorship_buyers: attach, mentorship_transactions: attach,
    bump_revenue: config.scenario_bump_per_buyer,
    bump_transactions: config.scenario_bump_per_buyer > 0 ? 1 : 0,
    refunds: config.scenario_refund_per_buyer
  }, config);
}
function evaluateScope(sample = {}, media = {}, health = {}, config = DEFAULT_SETTINGS) {
  const currencyValid = !num(sample.non_brl_events) && health.media_currency_valid !== false;
  const economics = currencyValid ? calculateUnitEconomics(sample, config) : null;
  const currentCpa = health.media_currency_valid !== false && num(media.purchases) > 0 ? num(media.spend) / num(media.purchases) : null;
  const reasons = [];
  const reason = (code, message) => reasons.push({ code, message });
  if (!config.costs_confirmed) reason("costs_unconfirmed", "Taxas, custos e split precisam ser revisados e confirmados.");
  if (!currencyValid) reason("currency_mismatch", "Ha valores sem moeda BRL. Converta a moeda na origem antes de calcular o limite em reais.");
  if (health.snapshot_fresh === false) reason("stale_snapshot", "Snapshot de periodo em aberto tem mais de 24h. Sincronize novamente a UTMify.");
  if (!health.utmify?.available) reason("snapshot_missing", "Sincronize exatamente este periodo na UTMify.");
  if (health.status !== "good") reason("tracking_unreliable", "Tracking Health exige revisao antes de recomendar escala.");
  if (num(sample.mature_buyers) < config.min_buyers) reason("small_sample", "Amostra madura abaixo de " + config.min_buyers + " compradores.");
  if (num(sample.total_buyers) > num(sample.mature_buyers)) reason("immature_cohort", "Parte da coorte ainda nao completou a janela de monetizacao.");
  if (num(sample.total_buyers) > 0 && num(sample.mature_buyers) / num(sample.total_buyers) < 0.8) reason("maturity_low", "Menos de 80% da coorte completou a janela; o historico ainda pode mudar.");
  if (num(sample.mentorship_revenue) > 0 &&
    (num(sample.mentorship_buyers) < 3 || num(sample.max_buyer_mentorship_revenue) / num(sample.mentorship_revenue) > 0.5)) {
    reason("mentorship_concentration", "O valor de mentoria depende de poucos compradores; valide a repetibilidade.");
  }
  if (!media.matched) reason("scope_unmatched", "Este escopo nao possui objeto correspondente no snapshot UTMify.");
  if (num(media.purchases) === 0) reason("no_media_purchases", "UTMify sem compras neste escopo; CPA atual indisponivel.");
  if (num(media.spend) === 0) reason("no_spend", "Sem gasto UTMify para comparar CPA.");
  for (const [key, internal, external] of [
    ["scope_purchase_divergence", num(sample.total_buyers), num(media.purchases)],
    ["scope_revenue_divergence", num(sample.total_front_revenue), num(media.revenue)]
  ]) {
    if (external > 0 ? Math.abs(internal - external) / external > 0.05 : internal > 0) {
      reason(key, "Vendas ou receita front deste escopo divergem mais de 5% entre DR e UTMify.");
    }
  }
  const blocking = reasons.filter(r => r.code !== "immature_cohort");
  let status = economics ? "provisional" : "insufficient_history";
  if (economics && !blocking.length) {
    status = currentCpa <= economics.prudent_cpa_max ? "scalable"
      : currentCpa <= economics.cpa_max ? "near_limit" : "above_limit";
    if (economics.contribution_per_buyer <= 0) status = "negative_contribution";
  }
  return {
    total_buyers: num(sample.total_buyers), mature_buyers: num(sample.mature_buyers),
    current_cpa: currentCpa == null ? null : money(currentCpa),
    spend: num(media.spend), media_purchases: num(media.purchases),
    economics, headroom: economics && currentCpa != null ? money(economics.cpa_max - currentCpa) : null,
    headroom_pct: economics?.cpa_max > 0 && currentCpa != null ? (economics.cpa_max - currentCpa) / economics.cpa_max * 100 : null,
    status, recommendation_eligible: Boolean(economics && !blocking.length), reasons
  };
}
async function initCpaDb(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dr_cpa_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1), settings JSONB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`INSERT INTO dr_cpa_settings (id, settings) VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING`, [JSON.stringify(DEFAULT_SETTINGS)]);
}
async function getSettings(pool) {
  const result = await pool.query("SELECT settings, revision, updated_at FROM dr_cpa_settings WHERE id = 1");
  const row = result.rows[0];
  if (!row) fail("configuracao CPA indisponivel", 503);
  return { settings: normalizeSettings(row.settings), revision: row.revision, updated_at: row.updated_at };
}
async function saveSettings(pool, input = {}) {
  if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) fail("expected_revision invalida");
  const config = normalizeSettings(input.settings);
  const result = await pool.query(`UPDATE dr_cpa_settings SET settings = $1::jsonb,
    revision = revision + 1, updated_at = NOW() WHERE id = 1 AND revision = $2
    RETURNING settings, revision, updated_at`, [JSON.stringify(config), input.expected_revision]);
  if (!result.rows[0]) fail("Configuracao alterada em outra sessao. Atualize antes de salvar.", 409);
  return result.rows[0];
}
async function getMatureSamples(pool, range, config) {
  const dimension = { campaign: "campaign_id", adset: "adset_id", ad: "ad_id" }[range.level];
  const result = await pool.query(`
    WITH first_purchase AS (
      SELECT DISTINCT ON (COALESCE(NULLIF(TRIM(click_id), ''), 'event:' || event_id))
        click_id, value, created_at, event_id, currency
      FROM dr_events WHERE event_name = 'purchase'
      ORDER BY COALESCE(NULLIF(TRIM(click_id), ''), 'event:' || event_id), created_at, id
    ), cohort AS (
      SELECT p.*, NULLIF(TRIM(c.${dimension}), '') AS object_id,
        p.created_at <= NOW() AT TIME ZONE 'UTC' - make_interval(days => $3) AS mature
      FROM first_purchase p JOIN dr_clicks c ON c.click_id = p.click_id
      WHERE ((p.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
        AND (LOWER(TRIM(COALESCE(c.utm_source, ''))) IN ('meta','meta_ads','facebook_ads','facebook','fb','instagram','ig')
          OR (NULLIF(TRIM(c.utm_source), '') IS NULL AND
            COALESCE(NULLIF(TRIM(c.campaign_id), ''), NULLIF(TRIM(c.adset_id), ''), NULLIF(TRIM(c.ad_id), '')) IS NOT NULL))
    ), buyers AS (
      SELECT c.*, d.* FROM cohort c LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(value) FILTER (WHERE event_name = 'mentorship_purchase'),0)::numeric AS mentorship_revenue,
          COUNT(*) FILTER (WHERE event_name = 'mentorship_purchase')::int AS mentorship_transactions,
          COALESCE(SUM(value) FILTER (WHERE event_name = 'order_bump_purchase'),0)::numeric AS bump_revenue,
          COUNT(*) FILTER (WHERE event_name = 'order_bump_purchase')::int AS bump_transactions,
          COALESCE(SUM(ABS(value)) FILTER (WHERE event_name = 'refund'),0)::numeric AS refunds,
          COUNT(*) FILTER (WHERE COALESCE(UPPER(TRIM(currency)), '') <> 'BRL')::int AS downstream_non_brl
        FROM dr_events e WHERE e.click_id = c.click_id
          AND e.event_name IN ('mentorship_purchase','order_bump_purchase','refund')
          AND e.created_at >= c.created_at
          AND (e.event_name = 'refund' OR e.created_at < c.created_at + make_interval(days => $3))
          AND e.created_at <= NOW() AT TIME ZONE 'UTC'
      ) d ON TRUE
    ) SELECT object_id, GROUPING(object_id)::int AS is_total,
      COUNT(*)::int AS total_buyers, COALESCE(SUM(value),0)::numeric AS total_front_revenue,
      COALESCE(SUM(downstream_non_brl),0)::int + COUNT(*) FILTER (WHERE COALESCE(UPPER(TRIM(currency)), '') <> 'BRL')::int AS non_brl_events,
      COUNT(*) FILTER (WHERE mature)::int AS mature_buyers,
      COALESCE(SUM(value) FILTER (WHERE mature),0)::numeric AS front_revenue,
      COUNT(*) FILTER (WHERE mature AND mentorship_transactions > 0)::int AS mentorship_buyers,
      COALESCE(SUM(mentorship_revenue) FILTER (WHERE mature),0)::numeric AS mentorship_revenue,
      COALESCE(SUM(mentorship_transactions) FILTER (WHERE mature),0)::int AS mentorship_transactions,
      COALESCE(MAX(mentorship_revenue) FILTER (WHERE mature),0)::numeric AS max_buyer_mentorship_revenue,
      COALESCE(SUM(bump_revenue) FILTER (WHERE mature),0)::numeric AS bump_revenue,
      COALESCE(SUM(bump_transactions) FILTER (WHERE mature),0)::int AS bump_transactions,
      COALESCE(SUM(refunds) FILTER (WHERE mature),0)::numeric AS refunds
    FROM buyers GROUP BY GROUPING SETS ((object_id), ())
  `, [range.from, range.to, config.maturity_days]);
  return result.rows;
}
async function getCpaReport(pool, input = {}) {
  const range = validateRange(input);
  const config = await getSettings(pool);
  const [healthResult, samples] = await Promise.all([
    getTrackingHealth(pool, range), getMatureSamples(pool, range, config.settings)
  ]);
  const health = healthResult.report;
  const connection = (await pool.query("SELECT currency FROM dr_utmify_connection WHERE id = 1")).rows[0];
  health.media_currency_valid = String(connection?.currency || "").trim().toUpperCase() === "BRL";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Sao_Paulo", year:"numeric",month:"2-digit",day:"2-digit" }).format(new Date());
  health.snapshot_fresh = range.to < today || (health.utmify.finished_at != null &&
    Date.now() - new Date(health.utmify.finished_at).getTime() <= 86400000);
  const objects = health.utmify.sync_id ? (await pool.query(`SELECT * FROM dr_utmify_ad_objects
    WHERE sync_id = $1 ORDER BY id`, [health.utmify.sync_id])).rows : [];
  const nameMaps = {
    campaign: new Map(objects.filter(r => r.level === "campaign").map(r => [r.campaign_id, r.name])),
    adset: new Map(objects.filter(r => r.level === "adset").map(r => [r.adset_id, r.name]))
  };
  const byId = new Map(samples.filter(r => !r.is_total && r.object_id).map(r => [r.object_id, r]));
  const rows = objects.filter(r => r.level === range.level).map(object => {
    const media = performanceRow(object, nameMaps), sample = byId.get(object.object_id) || {};
    byId.delete(object.object_id);
    return { object_id: object.object_id, campaign: media.campaign, adset: media.adset, ad: media.ad,
      ...evaluateScope(sample, { ...media, matched: true }, health, config.settings) };
  });
  for (const [object_id, sample] of byId) {
    rows.push({ object_id, campaign: object_id, adset: object_id, ad: object_id,
      ...evaluateScope(sample, {}, health, config.settings) });
  }
  rows.sort((a,b) => b.spend - a.spend);
  return { range, ...config, tracking_status: health.status, sync: health.utmify,
    summary: evaluateScope(samples.find(r => r.is_total) || {}, {
      spend: health.utmify.spend, purchases: health.utmify.purchases,
      revenue: health.utmify.revenue, matched: health.utmify.available
    }, health, config.settings),
    scenario: scenarioEconomics(config.settings), rows,
    unassigned_buyers: num(samples.find(r => !r.is_total && !r.object_id)?.total_buyers),
    methodology: "Primeira compra por click_id no periodo; apenas coorte Meta. Monetizacao observada dentro da janela desde a compra. A reserva incide sobre contribuicao antes da midia. Cenarios sao hipoteses e nunca liberam escala."
  };
}
function registerCpaRoutes(app, pool) {
  app.get("/assets/cpa-dashboard.js", (req,res) => res.sendFile(__dirname + "/cpaDashboard.js"));
  const handle = task => async (req,res) => {
    if (!requireAdmin(req,res)) return;
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...await task(req) }); }
    catch (error) { res.status(error.statusCode || 500).json({ ok:false, error:error.statusCode ? error.message : "erro interno" }); }
  };
  app.get("/api/cpa-max/settings", handle(() => getSettings(pool)));
  app.put("/api/cpa-max/settings", handle(req => saveSettings(pool, req.body)));
  app.get("/api/cpa-max", handle(req => getCpaReport(pool, req.query)));
}
module.exports = { DEFAULT_SETTINGS, normalizeSettings, validateRange, calculateUnitEconomics,
  scenarioEconomics, evaluateScope, initCpaDb, getSettings, saveSettings, getMatureSamples, getCpaReport, registerCpaRoutes };

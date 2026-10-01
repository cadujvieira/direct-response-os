const crypto = require("crypto");

const MAX_HEALTH_DAYS = 90;

function normalizeText(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function secretMatches(expected, received) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(received || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
  const expected = String(process.env.DR_ADMIN_SECRET || "").trim();

  if (!expected) {
    res.status(503).json({
      ok: false,
      error: "DR_ADMIN_SECRET nao configurado"
    });
    return false;
  }

  const received = String(req.get("x-admin-secret") || "").trim();

  if (!secretMatches(expected, received)) {
    res.status(401).json({ ok: false, error: "nao autorizado" });
    return false;
  }

  return true;
}

function parseIsoDate(value, fieldName) {
  const text = normalizeText(value, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error(fieldName + " invalido");
    error.statusCode = 400;
    throw error;
  }

  const date = new Date(text + "T12:00:00Z");
  if (Number.isNaN(date.getTime())) {
    const error = new Error(fieldName + " invalido");
    error.statusCode = 400;
    throw error;
  }

  return text;
}

function validateHealthRange(fromValue, toValue) {
  const from = parseIsoDate(fromValue, "from");
  const to = parseIsoDate(toValue, "to");

  if (from > to) {
    const error = new Error("from nao pode ser maior que to");
    error.statusCode = 400;
    throw error;
  }

  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const days = Math.floor((end - start) / 86400000) + 1;

  if (days > MAX_HEALTH_DAYS) {
    const error = new Error("periodo maximo do Tracking Health: 90 dias");
    error.statusCode = 400;
    throw error;
  }

  return { from, to, days };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safePercent(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return (n / d) * 100;
}

function coverageState(value, good = 95, warn = 80) {
  if (value == null) return "neutral";
  const n = Number(value);
  if (!Number.isFinite(n)) return "neutral";
  if (n >= good) return "good";
  if (n >= warn) return "warn";
  return "critical";
}

function divergenceState(value, good = 5, warn = 15) {
  if (value == null) return "neutral";
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return "neutral";
  if (n <= good) return "good";
  if (n <= warn) return "warn";
  return "critical";
}

function differencePercent(internal, external) {
  const a = Number(internal);
  const b = Number(external);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return ((a - b) / b) * 100;
}

function metric(id, label, numerator, denominator, options = {}) {
  const pct = safePercent(numerator, denominator);
  return {
    id,
    label,
    numerator: numberOrZero(numerator),
    denominator: numberOrZero(denominator),
    pct,
    state: coverageState(
      pct,
      options.good == null ? 95 : options.good,
      options.warn == null ? 80 : options.warn
    ),
    detail: options.detail || ""
  };
}

function buildHealthReport(raw = {}) {
  const clicks = {
    total: numberOrZero(raw.clicks_total),
    meta_eligible: numberOrZero(
      raw.clicks_meta_eligible == null
        ? raw.clicks_total
        : raw.clicks_meta_eligible
    ),
    campaign_id: numberOrZero(raw.clicks_with_campaign_id),
    adset_id: numberOrZero(raw.clicks_with_adset_id),
    ad_id: numberOrZero(raw.clicks_with_ad_id)
  };

  const leads = {
    total: numberOrZero(raw.leads_total),
    click_id: numberOrZero(raw.leads_with_click_id),
    source: numberOrZero(raw.leads_with_source),
    orphan_click_id: numberOrZero(raw.leads_orphan_click_id)
  };

  const buyers = {
    total: numberOrZero(raw.buyers_total),
    meta_eligible: numberOrZero(
      raw.buyers_meta_eligible == null
        ? raw.buyers_total
        : raw.buyers_meta_eligible
    ),
    click_id: numberOrZero(raw.buyers_with_click_id),
    resolved_click: numberOrZero(raw.buyers_with_resolved_click),
    campaign_id: numberOrZero(raw.buyers_with_campaign_id),
    adset_id: numberOrZero(raw.buyers_with_adset_id),
    ad_id: numberOrZero(raw.buyers_with_ad_id),
    campaign_match: numberOrZero(raw.buyers_campaign_match),
    adset_match: numberOrZero(raw.buyers_adset_match),
    ad_match: numberOrZero(raw.buyers_ad_match)
  };

  const events = {
    total: numberOrZero(raw.events_total),
    orphan_click_id: numberOrZero(raw.events_orphan_click_id),
    repeated_purchase_clicks: numberOrZero(raw.repeated_purchase_clicks)
  };

  const utmify = {
    available: Boolean(raw.utmify_sync_id),
    sync_id: raw.utmify_sync_id ? Number(raw.utmify_sync_id) : null,
    finished_at: raw.utmify_finished_at || null,
    spend: numberOrZero(raw.utmify_spend),
    purchases: numberOrZero(raw.utmify_purchases),
    revenue: numberOrZero(raw.utmify_revenue)
  };

  const internal = {
    purchases_total: buyers.total,
    purchases: buyers.meta_eligible,
    revenue_total: numberOrZero(raw.internal_front_revenue),
    revenue: numberOrZero(
      raw.internal_meta_front_revenue == null
        ? raw.internal_front_revenue
        : raw.internal_meta_front_revenue
    )
  };

  const metrics = [
    metric("click_campaign_id", "Cliques Meta com campaign_id", clicks.campaign_id, clicks.meta_eligible, {
      detail: "Qualidade da captura no nível campanha entre cliques elegíveis para Meta/UTMify."
    }),
    metric("click_adset_id", "Cliques Meta com adset_id", clicks.adset_id, clicks.meta_eligible, {
      detail: "Qualidade da captura no nível conjunto entre cliques elegíveis para Meta/UTMify."
    }),
    metric("click_ad_id", "Cliques Meta com ad_id", clicks.ad_id, clicks.meta_eligible, {
      detail: "Qualidade da captura no nível anúncio entre cliques elegíveis para Meta/UTMify."
    }),
    metric("lead_click_id", "Leads com click_id", leads.click_id, leads.total, {
      detail: "Permite ligar o lead ao clique de aquisição."
    }),
    metric("lead_source", "Leads com origem", leads.source, leads.total, {
      detail: "Lead possui utm_source ou clique com origem conhecida."
    }),
    metric("buyer_click_id", "Compradores com click_id", buyers.click_id, buyers.total, {
      detail: "Base para qualquer atribuição downstream."
    }),
    metric("buyer_campaign_id", "Compradores Meta com campaign_id", buyers.campaign_id, buyers.meta_eligible, {
      detail: "Cobertura interna de compradores elegíveis para atribuição Meta por campanha."
    }),
    metric("buyer_adset_id", "Compradores Meta com adset_id", buyers.adset_id, buyers.meta_eligible, {
      detail: "Cobertura interna de compradores elegíveis para atribuição Meta por conjunto."
    }),
    metric("buyer_ad_id", "Compradores Meta com ad_id", buyers.ad_id, buyers.meta_eligible, {
      detail: "Cobertura interna de compradores elegíveis para atribuição Meta por anúncio."
    })
  ];

  if (utmify.available) {
    metrics.push(
      metric("utmify_campaign_match", "Match UTMify — campanha", buyers.campaign_match, buyers.campaign_id, {
        detail: "Entre os campaign_id capturados, quantos existem no snapshot UTMify."
      }),
      metric("utmify_adset_match", "Match UTMify — conjunto", buyers.adset_match, buyers.adset_id, {
        detail: "Entre os adset_id capturados, quantos existem no snapshot UTMify."
      }),
      metric("utmify_ad_match", "Match UTMify — anúncio", buyers.ad_match, buyers.ad_id, {
        detail: "Entre os ad_id capturados, quantos existem no snapshot UTMify."
      })
    );
  }

  const purchaseDifferencePct = utmify.available
    ? differencePercent(internal.purchases, utmify.purchases)
    : null;
  const revenueDifferencePct = utmify.available
    ? differencePercent(internal.revenue, utmify.revenue)
    : null;

  const issues = [];

  function pushIssue(severity, code, title, detail, count = null) {
    issues.push({ severity, code, title, detail, count });
  }

  const buyersWithoutClick = Math.max(buyers.total - buyers.click_id, 0);
  if (buyersWithoutClick > 0) {
    pushIssue(
      "critical",
      "buyer_missing_click_id",
      "Compras sem click_id",
      "Essas compras não podem ser devolvidas à campanha/conjunto/anúncio.",
      buyersWithoutClick
    );
  }

  if (buyers.click_id > buyers.resolved_click) {
    pushIssue(
      "critical",
      "buyer_orphan_click",
      "click_id de compra sem clique correspondente",
      "O evento trouxe click_id, mas o clique não existe em dr_clicks.",
      buyers.click_id - buyers.resolved_click
    );
  }

  if (
    buyers.meta_eligible > 0 &&
    buyers.ad_id < buyers.meta_eligible
  ) {
    const pct = safePercent(buyers.ad_id, buyers.meta_eligible);
    pushIssue(
      coverageState(pct) === "critical" ? "critical" : "warn",
      "buyer_missing_ad_id",
      "Cobertura de ad_id incompleta na coorte Meta",
      "Sem ad_id, o LTV de compradores Meta não pode ser devolvido ao anúncio exato.",
      buyers.meta_eligible - buyers.ad_id
    );
  }

  if (leads.orphan_click_id > 0) {
    pushIssue(
      "warn",
      "lead_orphan_click",
      "Leads com click_id órfão",
      "O lead referencia um click_id que não existe na tabela de cliques.",
      leads.orphan_click_id
    );
  }

  if (events.orphan_click_id > 0) {
    pushIssue(
      "warn",
      "event_orphan_click",
      "Eventos com click_id órfão",
      "Há eventos que não conseguem resolver seu clique de origem.",
      events.orphan_click_id
    );
  }

  if (events.repeated_purchase_clicks > 0) {
    pushIssue(
      "warn",
      "repeated_purchase_click",
      "Mais de um purchase no mesmo click_id",
      "Pode ser recompra legítima, retry mal deduplicado ou uso reaproveitado do click_id. Revise.",
      events.repeated_purchase_clicks
    );
  }

  if (!utmify.available) {
    pushIssue(
      "info",
      "utmify_snapshot_missing",
      "Período sem snapshot UTMify",
      "Sincronize o mesmo período em Integrações para medir match e divergência."
    );
  } else {
    if (internal.purchases > 0 && utmify.purchases === 0) {
      pushIssue(
        "critical",
        "utmify_zero_purchases",
        "UTMify sem vendas enquanto o Oferta DR possui compras",
        "O snapshot existe, mas não atribuiu nenhuma compra front para um período em que o tracking interno possui compradores."
      );
    }

    if (internal.revenue > 0 && utmify.revenue === 0) {
      pushIssue(
        "critical",
        "utmify_zero_revenue",
        "UTMify sem receita front enquanto o Oferta DR possui receita",
        "O snapshot existe, mas a receita front atribuída pela UTMify está zerada enquanto o tracking interno possui receita."
      );
    }

    const adMatchPct = safePercent(buyers.ad_match, buyers.ad_id);

    if (buyers.ad_id > 0 && adMatchPct != null && adMatchPct < 95) {
      pushIssue(
        adMatchPct < 80 ? "critical" : "warn",
        "utmify_ad_match_low",
        "Match de anúncio abaixo do ideal",
        "Parte dos ad_id capturados internamente não foi encontrada no snapshot UTMify do período.",
        buyers.ad_id - buyers.ad_match
      );
    }

    if (
      purchaseDifferencePct != null &&
      divergenceState(purchaseDifferencePct) !== "good"
    ) {
      pushIssue(
        divergenceState(purchaseDifferencePct),
        "purchase_divergence",
        "Vendas Oferta DR × UTMify divergentes",
        "Diferença de " +
          Math.abs(purchaseDifferencePct).toFixed(1) +
          "% entre compradores internos e compras atribuídas pela UTMify."
      );
    }

    if (
      revenueDifferencePct != null &&
      divergenceState(revenueDifferencePct) !== "good"
    ) {
      pushIssue(
        divergenceState(revenueDifferencePct),
        "revenue_divergence",
        "Receita front Oferta DR × UTMify divergente",
        "Diferença de " +
          Math.abs(revenueDifferencePct).toFixed(1) +
          "% entre a receita front interna e a atribuída pela UTMify."
      );
    }
  }

  const severityOrder = { critical: 0, warn: 1, info: 2 };
  issues.sort(
    (a, b) =>
      (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
  );

  const criticalCount = issues.filter((item) => item.severity === "critical").length;
  const warnCount = issues.filter((item) => item.severity === "warn").length;
  const criticalMetricCount = metrics.filter((item) => item.state === "critical").length;
  const warnMetricCount = metrics.filter((item) => item.state === "warn").length;
  const status = criticalCount > 0 || criticalMetricCount > 0
    ? "critical"
    : warnCount > 0 || warnMetricCount > 0
      ? "warn"
      : "good";

  return {
    status,
    clicks,
    leads,
    buyers,
    events,
    internal,
    utmify,
    metrics,
    discrepancies: {
      purchase_difference_pct: purchaseDifferencePct,
      revenue_difference_pct: revenueDifferencePct,
      purchase_state: divergenceState(purchaseDifferencePct),
      revenue_state: divergenceState(revenueDifferencePct)
    },
    issues
  };
}

async function latestUtmifySync(pool, from, to) {
  const result = await pool.query(`
    SELECT id, date_from, date_to, counts, finished_at
    FROM dr_utmify_syncs
    WHERE date_from = $1::date
      AND date_to = $2::date
      AND status = 'completed'
    ORDER BY finished_at DESC, id DESC
    LIMIT 1
  `, [from, to]);

  return result.rows[0] || null;
}

async function getTrackingHealth(pool, input = {}) {
  const range = validateHealthRange(input.from, input.to);
  const sync = await latestUtmifySync(pool, range.from, range.to);
  const syncId = sync ? Number(sync.id) : null;

  const result = await pool.query(`
    WITH
    clicks AS (
      SELECT *
      FROM dr_clicks
      WHERE (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
    ),
    meta_clicks AS (
      SELECT *
      FROM clicks
      WHERE LOWER(TRIM(COALESCE(utm_source, ''))) IN (
        'meta', 'meta_ads', 'facebook_ads', 'facebook', 'fb', 'instagram', 'ig'
      )
      OR (
        NULLIF(TRIM(COALESCE(utm_source, '')), '') IS NULL
        AND (
          NULLIF(TRIM(campaign_id), '') IS NOT NULL
          OR NULLIF(TRIM(adset_id), '') IS NOT NULL
          OR NULLIF(TRIM(ad_id), '') IS NOT NULL
        )
      )
    ),
    leads AS (
      SELECT l.*, c.id AS resolved_click_row, c.utm_source AS click_utm_source
      FROM dr_leads l
      LEFT JOIN dr_clicks c ON c.click_id = l.click_id
      WHERE (((l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND (((l.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
    ),
    purchase_events AS (
      SELECT event_id, click_id, value
      FROM dr_events
      WHERE event_name = 'purchase'
        AND (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
    ),
    purchase_buyers AS (
      SELECT
        COALESCE(click_id, 'event:' || event_id) AS buyer_key,
        MAX(click_id) AS click_id,
        SUM(COALESCE(value,0))::numeric AS front_revenue
      FROM purchase_events
      GROUP BY COALESCE(click_id, 'event:' || event_id)
    ),
    buyer_details AS (
      SELECT
        p.*,
        c.id AS resolved_click_row,
        c.utm_source,
        c.utm_medium,
        NULLIF(TRIM(c.campaign_id), '') AS campaign_id,
        NULLIF(TRIM(c.adset_id), '') AS adset_id,
        NULLIF(TRIM(c.ad_id), '') AS ad_id
      FROM purchase_buyers p
      LEFT JOIN dr_clicks c ON c.click_id = p.click_id
    ),
    meta_buyers AS (
      SELECT *
      FROM buyer_details
      WHERE LOWER(TRIM(COALESCE(utm_source, ''))) IN (
        'meta', 'meta_ads', 'facebook_ads', 'facebook', 'fb', 'instagram', 'ig'
      )
      OR (
        NULLIF(TRIM(COALESCE(utm_source, '')), '') IS NULL
        AND (
          campaign_id IS NOT NULL
          OR adset_id IS NOT NULL
          OR ad_id IS NOT NULL
        )
      )
    ),
    range_events AS (
      SELECT e.*, c.id AS resolved_click_row
      FROM dr_events e
      LEFT JOIN dr_clicks c ON c.click_id = e.click_id
      WHERE (((e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND (((e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
    ),
    repeated_purchase AS (
      SELECT click_id
      FROM purchase_events
      WHERE click_id IS NOT NULL
      GROUP BY click_id
      HAVING COUNT(*) > 1
    ),
    utmify_campaign AS (
      SELECT object_id
      FROM dr_utmify_ad_objects
      WHERE $3::bigint IS NOT NULL
        AND sync_id = $3
        AND level = 'campaign'
    ),
    utmify_adset AS (
      SELECT object_id
      FROM dr_utmify_ad_objects
      WHERE $3::bigint IS NOT NULL
        AND sync_id = $3
        AND level = 'adset'
    ),
    utmify_ad AS (
      SELECT object_id
      FROM dr_utmify_ad_objects
      WHERE $3::bigint IS NOT NULL
        AND sync_id = $3
        AND level = 'ad'
    ),
    utmify_totals AS (
      SELECT
        COALESCE(SUM((metrics->>'spend')::numeric),0)::numeric AS spend,
        COALESCE(SUM((metrics->>'purchases')::numeric),0)::numeric AS purchases,
        COALESCE(SUM((metrics->>'revenue')::numeric),0)::numeric AS revenue
      FROM dr_utmify_ad_objects
      WHERE $3::bigint IS NOT NULL
        AND sync_id = $3
        AND level = 'campaign'
    )
    SELECT
      (SELECT COUNT(*) FROM clicks)::int AS clicks_total,
      (SELECT COUNT(*) FROM meta_clicks)::int AS clicks_meta_eligible,
      (SELECT COUNT(*) FROM meta_clicks WHERE NULLIF(TRIM(campaign_id), '') IS NOT NULL)::int AS clicks_with_campaign_id,
      (SELECT COUNT(*) FROM meta_clicks WHERE NULLIF(TRIM(adset_id), '') IS NOT NULL)::int AS clicks_with_adset_id,
      (SELECT COUNT(*) FROM meta_clicks WHERE NULLIF(TRIM(ad_id), '') IS NOT NULL)::int AS clicks_with_ad_id,

      (SELECT COUNT(*) FROM leads)::int AS leads_total,
      (SELECT COUNT(*) FROM leads WHERE NULLIF(TRIM(click_id), '') IS NOT NULL)::int AS leads_with_click_id,
      (SELECT COUNT(*) FROM leads WHERE COALESCE(NULLIF(TRIM(utm_source), ''), NULLIF(TRIM(click_utm_source), '')) IS NOT NULL)::int AS leads_with_source,
      (SELECT COUNT(*) FROM leads WHERE NULLIF(TRIM(click_id), '') IS NOT NULL AND resolved_click_row IS NULL)::int AS leads_orphan_click_id,

      (SELECT COUNT(*) FROM buyer_details)::int AS buyers_total,
      (SELECT COUNT(*) FROM meta_buyers)::int AS buyers_meta_eligible,
      (SELECT COUNT(*) FROM buyer_details WHERE NULLIF(TRIM(click_id), '') IS NOT NULL)::int AS buyers_with_click_id,
      (SELECT COUNT(*) FROM buyer_details WHERE resolved_click_row IS NOT NULL)::int AS buyers_with_resolved_click,
      (SELECT COUNT(*) FROM meta_buyers WHERE campaign_id IS NOT NULL)::int AS buyers_with_campaign_id,
      (SELECT COUNT(*) FROM meta_buyers WHERE adset_id IS NOT NULL)::int AS buyers_with_adset_id,
      (SELECT COUNT(*) FROM meta_buyers WHERE ad_id IS NOT NULL)::int AS buyers_with_ad_id,
      (SELECT COUNT(*) FROM meta_buyers b WHERE b.campaign_id IS NOT NULL AND EXISTS (SELECT 1 FROM utmify_campaign u WHERE u.object_id = b.campaign_id))::int AS buyers_campaign_match,
      (SELECT COUNT(*) FROM meta_buyers b WHERE b.adset_id IS NOT NULL AND EXISTS (SELECT 1 FROM utmify_adset u WHERE u.object_id = b.adset_id))::int AS buyers_adset_match,
      (SELECT COUNT(*) FROM meta_buyers b WHERE b.ad_id IS NOT NULL AND EXISTS (SELECT 1 FROM utmify_ad u WHERE u.object_id = b.ad_id))::int AS buyers_ad_match,
      (SELECT COALESCE(SUM(front_revenue),0)::numeric FROM buyer_details) AS internal_front_revenue,
      (SELECT COALESCE(SUM(front_revenue),0)::numeric FROM meta_buyers) AS internal_meta_front_revenue,

      (SELECT COUNT(*) FROM range_events)::int AS events_total,
      (SELECT COUNT(*) FROM range_events WHERE click_id IS NOT NULL AND resolved_click_row IS NULL)::int AS events_orphan_click_id,
      (SELECT COUNT(*) FROM repeated_purchase)::int AS repeated_purchase_clicks,

      $3::bigint AS utmify_sync_id,
      $4::timestamptz AS utmify_finished_at,
      (SELECT spend FROM utmify_totals) AS utmify_spend,
      (SELECT purchases FROM utmify_totals) AS utmify_purchases,
      (SELECT revenue FROM utmify_totals) AS utmify_revenue
  `, [
    range.from,
    range.to,
    syncId,
    sync?.finished_at || null
  ]);

  return {
    range,
    report: buildHealthReport(result.rows[0] || {})
  };
}

function registerTrackingHealthRoutes(app, pool) {
  app.get("/api/tracking-health", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await getTrackingHealth(pool, {
        from: req.query.from,
        to: req.query.to
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        ok: false,
        error: error.statusCode ? error.message : "erro interno"
      });
    }
  });
}

module.exports = {
  MAX_HEALTH_DAYS,
  buildHealthReport,
  coverageState,
  differencePercent,
  divergenceState,
  getTrackingHealth,
  registerTrackingHealthRoutes,
  safePercent,
  validateHealthRange
};

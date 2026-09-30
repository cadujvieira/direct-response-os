function createBreakdownService(pool) {
  function buildQuery(level) {
    const isAd = level === "ad";

    const trackingDimensionKey = isAd
      ? `CASE
           WHEN r.ad_id IS NOT NULL THEN 'id:' || r.ad_id
           ELSE 'none:' || COALESCE(r.adset_id, 'none')
         END`
      : `CASE
           WHEN r.adset_id IS NOT NULL THEN 'id:' || r.adset_id
           ELSE 'none'
         END`;

    const spendDimensionKey = isAd
      ? `CASE
           WHEN s.ad_id_clean IS NOT NULL THEN 'id:' || s.ad_id_clean
           WHEN s.ad_name_norm <> '' THEN
             'name:' || s.ad_name_norm || ':adset:' || COALESCE(s.adset_id_clean, s.adset_name_norm, 'none')
           ELSE 'none:' || COALESCE(s.adset_id_clean, s.adset_name_norm, 'none')
         END`
      : `CASE
           WHEN s.adset_id_clean IS NOT NULL THEN 'id:' || s.adset_id_clean
           WHEN s.adset_name_norm <> '' THEN 'name:' || s.adset_name_norm
           ELSE 'none'
         END`;

    const trackingExtraSelect = isAd
      ? `,
          MAX(r.adset_id) AS adset_id,
          r.ad_id`
      : `,
          r.adset_id`;

    const trackingExtraGroup = isAd
      ? `,
          r.ad_id`
      : `,
          r.adset_id`;

    const spendExtraSelect = isAd
      ? `,
          MAX(s.adset_id_clean) AS adset_id,
          MAX(NULLIF(TRIM(s.adset_name), '')) AS adset_name,
          s.ad_id_clean AS ad_id,
          MAX(NULLIF(TRIM(s.ad_name), '')) AS ad_name`
      : `,
          s.adset_id_clean AS adset_id,
          MAX(NULLIF(TRIM(s.adset_name), '')) AS adset_name`;

    const spendExtraGroup = isAd
      ? `,
          s.ad_id_clean`
      : `,
          s.adset_id_clean`;

    const combinedExtra = isAd
      ? `,
          COALESCE(t.ad_id, s.ad_id) AS ad_id,
          COALESCE(
            s.ad_name,
            COALESCE(t.ad_id, s.ad_id),
            'Sem anúncio'
          ) AS ad,
          COALESCE(t.adset_id, s.adset_id) AS adset_id,
          COALESCE(
            s.adset_name,
            COALESCE(t.adset_id, s.adset_id),
            'Sem conjunto'
          ) AS adset`
      : `,
          COALESCE(t.adset_id, s.adset_id) AS adset_id,
          COALESCE(
            s.adset_name,
            COALESCE(t.adset_id, s.adset_id),
            'Sem conjunto'
          ) AS adset`;

    const finalIdentity = isAd
      ? `ad_id, ad, adset_id, adset, campaign_id, campaign`
      : `adset_id, adset, campaign_id, campaign`;

    const finalSort = isAd ? "ad ASC" : "adset ASC";

    return `
      WITH
      lead_by_click AS (
        SELECT click_id, COUNT(*)::int AS leads
        FROM dr_leads
        WHERE click_id IS NOT NULL
          AND (
            $1::date IS NULL OR
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
          )
          AND (
            $2::date IS NULL OR
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
          )
        GROUP BY click_id
      ),

      event_by_click AS (
        SELECT
          click_id,
          COUNT(*) FILTER (WHERE event_name = 'checkout_started')::int AS checkouts,
          COUNT(*) FILTER (WHERE event_name = 'purchase')::int AS purchases,
          COALESCE(
            SUM(value) FILTER (WHERE event_name = 'purchase'),
            0
          )::numeric AS revenue
        FROM dr_events
        WHERE click_id IS NOT NULL
          AND (
            $1::date IS NULL OR
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
          )
          AND (
            $2::date IS NULL OR
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
          )
        GROUP BY click_id
      ),

      id_name_pairs AS (
        SELECT DISTINCT
          NULLIF(TRIM(campaign_id), '') AS campaign_id,
          LOWER(TRIM(utm_campaign)) AS campaign_name_norm
        FROM dr_clicks
        WHERE NULLIF(TRIM(campaign_id), '') IS NOT NULL
          AND NULLIF(TRIM(utm_campaign), '') IS NOT NULL

        UNION

        SELECT DISTINCT
          NULLIF(TRIM(campaign_id), '') AS campaign_id,
          LOWER(TRIM(campaign_name)) AS campaign_name_norm
        FROM dr_ad_spend
        WHERE NULLIF(TRIM(campaign_id), '') IS NOT NULL
          AND NULLIF(TRIM(campaign_name), '') IS NOT NULL
      ),

      unique_name_id AS (
        SELECT campaign_name_norm, MIN(campaign_id) AS campaign_id
        FROM id_name_pairs
        GROUP BY campaign_name_norm
        HAVING COUNT(DISTINCT campaign_id) = 1
      ),

      tracking_resolved AS (
        SELECT
          c.click_id,
          COALESCE(NULLIF(TRIM(c.campaign_id), ''), u.campaign_id) AS canonical_campaign_id,
          LOWER(TRIM(COALESCE(c.utm_campaign, ''))) AS campaign_name_norm,
          NULLIF(TRIM(c.utm_campaign), '') AS campaign_name,
          NULLIF(TRIM(c.adset_id), '') AS adset_id,
          NULLIF(TRIM(c.ad_id), '') AS ad_id,
          (
            ($1::date IS NULL OR
              ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
            AND
            ($2::date IS NULL OR
              ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
          ) AS click_in_range
        FROM dr_clicks c
        LEFT JOIN unique_name_id u
          ON NULLIF(TRIM(c.campaign_id), '') IS NULL
         AND NULLIF(TRIM(c.utm_campaign), '') IS NOT NULL
         AND u.campaign_name_norm = LOWER(TRIM(c.utm_campaign))
      ),

      tracking_agg AS (
        SELECT
          CASE
            WHEN r.canonical_campaign_id IS NOT NULL THEN 'id:' || r.canonical_campaign_id
            ELSE 'name:' || r.campaign_name_norm
          END AS campaign_key,
          r.canonical_campaign_id AS campaign_id,
          MAX(r.campaign_name) AS campaign_name,
          ${trackingDimensionKey} AS dimension_key
          ${trackingExtraSelect},
          (COUNT(DISTINCT r.click_id) FILTER (WHERE r.click_in_range))::int AS clicks,
          COALESCE(SUM(l.leads), 0)::int AS leads,
          COALESCE(SUM(e.checkouts), 0)::int AS checkouts,
          COALESCE(SUM(e.purchases), 0)::int AS purchases,
          COALESCE(SUM(e.revenue), 0)::numeric AS revenue
        FROM tracking_resolved r
        LEFT JOIN lead_by_click l ON l.click_id = r.click_id
        LEFT JOIN event_by_click e ON e.click_id = r.click_id
        GROUP BY
          CASE
            WHEN r.canonical_campaign_id IS NOT NULL THEN 'id:' || r.canonical_campaign_id
            ELSE 'name:' || r.campaign_name_norm
          END,
          r.canonical_campaign_id,
          ${trackingDimensionKey}
          ${trackingExtraGroup}
        HAVING
          COUNT(DISTINCT r.click_id) FILTER (WHERE r.click_in_range) > 0
          OR COALESCE(SUM(l.leads), 0) > 0
          OR COALESCE(SUM(e.checkouts), 0) > 0
          OR COALESCE(SUM(e.purchases), 0) > 0
          OR COALESCE(SUM(e.revenue), 0) > 0
      ),

      spend_resolved AS (
        SELECT
          s.*,
          COALESCE(NULLIF(TRIM(s.campaign_id), ''), u.campaign_id) AS canonical_campaign_id,
          LOWER(TRIM(COALESCE(s.campaign_name, ''))) AS campaign_name_norm,
          NULLIF(TRIM(s.adset_id), '') AS adset_id_clean,
          LOWER(TRIM(COALESCE(s.adset_name, ''))) AS adset_name_norm,
          NULLIF(TRIM(s.ad_id), '') AS ad_id_clean,
          LOWER(TRIM(COALESCE(s.ad_name, ''))) AS ad_name_norm
        FROM dr_ad_spend s
        LEFT JOIN unique_name_id u
          ON NULLIF(TRIM(s.campaign_id), '') IS NULL
         AND NULLIF(TRIM(s.campaign_name), '') IS NOT NULL
         AND u.campaign_name_norm = LOWER(TRIM(s.campaign_name))
        WHERE ($1::date IS NULL OR s.spend_date >= $1::date)
          AND ($2::date IS NULL OR s.spend_date <= $2::date)
      ),

      spend_agg AS (
        SELECT
          CASE
            WHEN s.canonical_campaign_id IS NOT NULL THEN 'id:' || s.canonical_campaign_id
            ELSE 'name:' || s.campaign_name_norm
          END AS campaign_key,
          s.canonical_campaign_id AS campaign_id,
          MAX(NULLIF(TRIM(s.campaign_name), '')) AS campaign_name,
          ${spendDimensionKey} AS dimension_key
          ${spendExtraSelect},
          COALESCE(SUM(s.spend), 0)::numeric AS spend,
          COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
          COALESCE(SUM(s.clicks), 0)::bigint AS media_clicks
        FROM spend_resolved s
        GROUP BY
          CASE
            WHEN s.canonical_campaign_id IS NOT NULL THEN 'id:' || s.canonical_campaign_id
            ELSE 'name:' || s.campaign_name_norm
          END,
          s.canonical_campaign_id,
          ${spendDimensionKey}
          ${spendExtraGroup}
      ),

      combined AS (
        SELECT
          COALESCE(t.campaign_key, s.campaign_key) AS campaign_key,
          COALESCE(t.campaign_id, s.campaign_id) AS campaign_id,
          COALESCE(
            t.campaign_name,
            s.campaign_name,
            COALESCE(t.campaign_id, s.campaign_id),
            'Sem campanha'
          ) AS campaign
          ${combinedExtra},
          COALESCE(t.clicks, 0)::int AS clicks,
          COALESCE(s.media_clicks, 0)::bigint AS media_clicks,
          COALESCE(s.impressions, 0)::bigint AS impressions,
          COALESCE(t.leads, 0)::int AS leads,
          COALESCE(t.checkouts, 0)::int AS checkouts,
          COALESCE(t.purchases, 0)::int AS purchases,
          COALESCE(t.revenue, 0)::numeric AS revenue,
          COALESCE(s.spend, 0)::numeric AS spend
        FROM tracking_agg t
        FULL OUTER JOIN spend_agg s
          ON s.campaign_key = t.campaign_key
         AND s.dimension_key = t.dimension_key
      )

      SELECT
        ${finalIdentity},
        clicks,
        media_clicks,
        impressions,
        leads,
        checkouts,
        purchases,
        revenue,
        spend,
        CASE WHEN leads > 0 AND spend > 0
          THEN ROUND(spend / leads, 2) ELSE NULL END AS cpl,
        CASE WHEN purchases > 0 AND spend > 0
          THEN ROUND(spend / purchases, 2) ELSE NULL END AS cpa,
        CASE WHEN spend > 0
          THEN ROUND(revenue / spend, 4) ELSE NULL END AS roas
      FROM combined
      ORDER BY revenue DESC, spend DESC, ${finalSort}
    `;
  }

  async function getAdsetRows(from, to) {
    const result = await pool.query(buildQuery("adset"), [from, to]);
    return result.rows;
  }

  async function getAdRows(from, to) {
    const result = await pool.query(buildQuery("ad"), [from, to]);
    return result.rows;
  }

  return {
    getAdsetRows,
    getAdRows
  };
}

module.exports = {
  createBreakdownService
};

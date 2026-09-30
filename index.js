require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createBreakdownService } = require("./breakdowns");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

const breakdowns = createBreakdownService(pool);

function hashIp(ip) {
  return crypto
    .createHash("sha256")
    .update(String(ip || ""))
    .digest("hex");
}

function parseReportRange(query = {}) {
  const parseDate = (value, field) => {
    if (value == null || value === "") return null;
    if (typeof value !== "string") {
      const error = new Error(field + " deve usar o formato YYYY-MM-DD");
      error.statusCode = 400;
      throw error;
    }

    const normalized = value.trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const error = new Error(field + " deve usar o formato YYYY-MM-DD");
      error.statusCode = 400;
      throw error;
    }

    const parsed = new Date(normalized + "T00:00:00Z");

    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== normalized
    ) {
      const error = new Error(field + " deve ser uma data valida");
      error.statusCode = 400;
      throw error;
    }

    return normalized;
  };

  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");

  if (from && to && from > to) {
    const error = new Error("from nao pode ser maior que to");
    error.statusCode = 400;
    throw error;
  }

  return { from, to };
}

async function initDb() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_clicks (
      id SERIAL PRIMARY KEY,
      click_id TEXT UNIQUE NOT NULL,

      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,

      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT,

      page_url TEXT,
      referrer TEXT,
      user_agent TEXT,
      ip_hash TEXT,

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_leads (
      id SERIAL PRIMARY KEY,

      click_id TEXT,

      nome TEXT,
      email TEXT,
      telefone TEXT,

      status TEXT DEFAULT 'lead',

      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS dr_leads_email_unique
  ON dr_leads (LOWER(email))
  WHERE email IS NOT NULL
    AND TRIM(email) <> '';
`);

await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS dr_leads_telefone_unique
  ON dr_leads (regexp_replace(telefone, '[^0-9]', '', 'g'))
  WHERE telefone IS NOT NULL
    AND regexp_replace(telefone, '[^0-9]', '', 'g') <> '';
`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_events (
      id SERIAL PRIMARY KEY,

      event_id TEXT UNIQUE NOT NULL,
      click_id TEXT,

      email TEXT,
      telefone TEXT,

      event_name TEXT NOT NULL,

      value NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'BRL',

      raw_payload JSONB,

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_orders (
      id SERIAL PRIMARY KEY,

      order_id TEXT UNIQUE NOT NULL,

      click_id TEXT,
      email TEXT,
      telefone TEXT,

      produto TEXT,

      valor NUMERIC DEFAULT 0,

      status TEXT DEFAULT 'paid',

      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_ad_spend (
      id SERIAL PRIMARY KEY,

      spend_date DATE NOT NULL,
      source TEXT DEFAULT 'meta',

      campaign_id TEXT,
      campaign_name TEXT,

      adset_id TEXT,
      adset_name TEXT,

      ad_id TEXT,
      ad_name TEXT,

      spend NUMERIC DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    DROP INDEX IF EXISTS dr_ad_spend_unique_scope;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dr_ad_spend_unique_scope_v2
    ON dr_ad_spend (
      spend_date,
      (LOWER(TRIM(COALESCE(source, '')))),
      (COALESCE(
        NULLIF(TRIM(campaign_id), ''),
        'name:' || LOWER(TRIM(COALESCE(campaign_name, '')))
      )),
      (COALESCE(
        NULLIF(TRIM(adset_id), ''),
        'name:' || LOWER(TRIM(COALESCE(adset_name, '')))
      )),
      (COALESCE(
        NULLIF(TRIM(ad_id), ''),
        'name:' || LOWER(TRIM(COALESCE(ad_name, '')))
      ))
    );
  `);

}

app.get("/", async (req, res) => {

  try {

    const database = await pool.query(`
      SELECT NOW() AS agora
    `);

    res.json({
      status: "online",
      service: "direct-response-os",
      database: "connected",
      time: database.rows[0].agora
    });

  } catch (error) {

    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: error.message
    });

  }

});

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    service: "direct-response-os"
  });

});

app.get("/api/summary", async (req, res) => {
  try {
    const { from, to } = parseReportRange(req.query);

    const result = await pool.query(`
      WITH base AS (
        SELECT
          (
            SELECT COUNT(*)
            FROM dr_clicks
            WHERE (
              $1::date IS NULL OR
              ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
            )
            AND (
              $2::date IS NULL OR
              ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
            )
          )::int AS clicks,
          (
            SELECT COUNT(*)
            FROM dr_leads
            WHERE (
              $1::date IS NULL OR
              ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
            )
            AND (
              $2::date IS NULL OR
              ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
            )
          )::int AS leads,
          (
            SELECT COUNT(*)
            FROM dr_events
            WHERE event_name = 'checkout_started'
              AND (
                $1::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
              )
              AND (
                $2::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
              )
          )::int AS checkouts,
          (
            SELECT COUNT(*)
            FROM dr_events
            WHERE event_name = 'purchase'
              AND (
                $1::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
              )
              AND (
                $2::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
              )
          )::int AS purchases,
          (
            SELECT COALESCE(SUM(value), 0)
            FROM dr_events
            WHERE event_name = 'purchase'
              AND (
                $1::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
              )
              AND (
                $2::date IS NULL OR
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
              )
          )::numeric AS revenue,
          (
            SELECT COALESCE(SUM(spend), 0)
            FROM dr_ad_spend
            WHERE ($1::date IS NULL OR spend_date >= $1::date)
              AND ($2::date IS NULL OR spend_date <= $2::date)
          )::numeric AS spend
      )
      SELECT
        clicks, leads, checkouts, purchases, revenue, spend,
        CASE WHEN leads > 0 AND spend > 0
          THEN ROUND(spend / leads, 2) ELSE NULL END AS cpl,
        CASE WHEN purchases > 0 AND spend > 0
          THEN ROUND(spend / purchases, 2) ELSE NULL END AS cpa,
        CASE WHEN spend > 0
          THEN ROUND(revenue / spend, 4) ELSE NULL END AS roas
      FROM base
    `, [from, to]);

    res.json({
      ok: true,
      range: { from, to },
      summary: result.rows[0]
    });

  } catch (error) {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

app.post("/track/click", async (req, res) => {
  try {
    const {
      click_id,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      campaign_id,
      adset_id,
      ad_id,
      page_url,
      referrer
    } = req.body;

    if (!click_id) {
      return res.status(400).json({
        ok: false,
        error: "click_id obrigatorio"
      });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "";

    const userAgent = req.headers["user-agent"] || "";

    await pool.query(`
      INSERT INTO dr_clicks (
        click_id,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        campaign_id,
        adset_id,
        ad_id,
        page_url,
        referrer,
        user_agent,
        ip_hash
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )
      ON CONFLICT (click_id)
      DO UPDATE SET
        utm_source = EXCLUDED.utm_source,
        utm_medium = EXCLUDED.utm_medium,
        utm_campaign = EXCLUDED.utm_campaign,
        utm_content = EXCLUDED.utm_content,
        utm_term = EXCLUDED.utm_term,
        campaign_id = EXCLUDED.campaign_id,
        adset_id = EXCLUDED.adset_id,
        ad_id = EXCLUDED.ad_id,
        page_url = EXCLUDED.page_url,
        referrer = EXCLUDED.referrer,
        user_agent = EXCLUDED.user_agent,
        ip_hash = EXCLUDED.ip_hash
    `, [
      click_id,
      utm_source || null,
      utm_medium || null,
      utm_campaign || null,
      utm_content || null,
      utm_term || null,
      campaign_id || null,
      adset_id || null,
      ad_id || null,
      page_url || null,
      referrer || null,
      userAgent,
      hashIp(ip)
    ]);

    res.json({
      ok: true,
      click_id
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/track/lead", async (req, res) => {
  try {
    const {
      click_id,
      nome,
      email,
      telefone,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content
    } = req.body;

    if (!email && !telefone) {
      return res.status(400).json({
        ok: false,
        error: "email ou telefone obrigatorio"
      });
    }

    let click = {};

    if (click_id) {
      const clickResult = await pool.query(`
        SELECT
          utm_source,
          utm_medium,
          utm_campaign,
          utm_content
        FROM dr_clicks
        WHERE click_id = $1
        LIMIT 1
      `, [click_id]);

      click = clickResult.rows[0] || {};
    }

    const result = await pool.query(`
      INSERT INTO dr_leads (
        click_id,
        nome,
        email,
        telefone,
        status,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content
      )
      VALUES ($1,$2,$3,$4,'lead',$5,$6,$7,$8)
      RETURNING id, click_id, nome, email, telefone, status
    `, [
      click_id || null,
      nome || null,
      email ? email.trim().toLowerCase() : null,
      telefone || null,
      utm_source || click.utm_source || null,
      utm_medium || click.utm_medium || null,
      utm_campaign || click.utm_campaign || null,
      utm_content || click.utm_content || null
    ]);

    res.json({
      ok: true,
      lead: result.rows[0]
    });

} catch (error) {
  if (error.code === "23505") {
    return res.json({
      ok: true,
      duplicate: true
    });
  }

  res.status(500).json({
    ok: false,
    error: error.message
  });
}

});

app.post("/track/event", async (req, res) => {
  try {
    const {
      event_id,
      click_id,
      email,
      telefone,
      event_name,
      value,
      currency
    } = req.body;

    if (!event_name) {
      return res.status(400).json({
        ok: false,
        error: "event_name obrigatorio"
      });
    }

    const finalEventId = event_id || crypto.randomUUID();

    const result = await pool.query(`
      INSERT INTO dr_events (
        event_id,
        click_id,
        email,
        telefone,
        event_name,
        value,
        currency,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id, event_id, click_id, event_name, value, currency
    `, [
      finalEventId,
      click_id || null,
      email ? email.trim().toLowerCase() : null,
      telefone || null,
      event_name,
      Number(value || 0),
      currency || "BRL",
      req.body
    ]);

    res.json({
      ok: true,
      duplicate: result.rows.length === 0,
      event_id: finalEventId,
      event: result.rows[0] || null
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/track/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      order_id,
      click_id,
      email,
      telefone,
      produto,
      valor,
      currency
    } = req.body;

    if (!order_id) {
      return res.status(400).json({
        ok: false,
        error: "order_id obrigatorio"
      });
    }

    const finalValue = Number(valor || 0);
    const eventId = `purchase_${order_id}`;

    await client.query("BEGIN");

    const orderResult = await client.query(`
      INSERT INTO dr_orders (
        order_id,
        click_id,
        email,
        telefone,
        produto,
        valor,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,'paid')
      ON CONFLICT (order_id) DO NOTHING
      RETURNING id, order_id, click_id, produto, valor, status
    `, [
      order_id,
      click_id || null,
      email ? email.trim().toLowerCase() : null,
      telefone || null,
      produto || null,
      finalValue
    ]);

    const eventResult = await client.query(`
      INSERT INTO dr_events (
        event_id,
        click_id,
        email,
        telefone,
        event_name,
        value,
        currency,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id, event_id, event_name, value, currency
    `, [
      eventId,
      click_id || null,
      email ? email.trim().toLowerCase() : null,
      telefone || null,
      finalValue,
      currency || "BRL",
      req.body
    ]);

    await client.query("COMMIT");

    res.json({
      ok: true,
      duplicate: eventResult.rows.length === 0,
      order_id,
      order: orderResult.rows[0] || null,
      event: eventResult.rows[0] || null
    });

  } catch (error) {
    await client.query("ROLLBACK");

    res.status(500).json({
      ok: false,
      error: error.message
    });

  } finally {
    client.release();
  }
});

app.get("/api/campaigns", async (req, res) => {
  try {
    const { from, to } = parseReportRange(req.query);

    const result = await pool.query(`
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
        SELECT
          campaign_name_norm,
          MIN(campaign_id) AS campaign_id
        FROM id_name_pairs
        GROUP BY campaign_name_norm
        HAVING COUNT(DISTINCT campaign_id) = 1
      ),

      tracking_resolved AS (
        SELECT
          c.click_id,
          COALESCE(
            NULLIF(TRIM(c.campaign_id), ''),
            u.campaign_id
          ) AS canonical_campaign_id,
          LOWER(TRIM(COALESCE(c.utm_campaign, ''))) AS campaign_name_norm,
          NULLIF(TRIM(c.utm_campaign), '') AS campaign_name,
          (
            (
              $1::date IS NULL OR
              ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date
            )
            AND (
              $2::date IS NULL OR
              ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
            )
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
            WHEN r.canonical_campaign_id IS NOT NULL
              THEN 'id:' || r.canonical_campaign_id
            ELSE 'name:' || r.campaign_name_norm
          END AS campaign_key,
          r.canonical_campaign_id AS campaign_id,
          MAX(r.campaign_name) AS campaign_name,
          (
            COUNT(DISTINCT r.click_id)
            FILTER (WHERE r.click_in_range)
          )::int AS clicks,
          COALESCE(SUM(l.leads), 0)::int AS leads,
          COALESCE(SUM(e.checkouts), 0)::int AS checkouts,
          COALESCE(SUM(e.purchases), 0)::int AS purchases,
          COALESCE(SUM(e.revenue), 0)::numeric AS revenue
        FROM tracking_resolved r
        LEFT JOIN lead_by_click l ON l.click_id = r.click_id
        LEFT JOIN event_by_click e ON e.click_id = r.click_id
        GROUP BY
          CASE
            WHEN r.canonical_campaign_id IS NOT NULL
              THEN 'id:' || r.canonical_campaign_id
            ELSE 'name:' || r.campaign_name_norm
          END,
          r.canonical_campaign_id
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
          COALESCE(
            NULLIF(TRIM(s.campaign_id), ''),
            u.campaign_id
          ) AS canonical_campaign_id,
          LOWER(TRIM(COALESCE(s.campaign_name, ''))) AS campaign_name_norm
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
            WHEN s.canonical_campaign_id IS NOT NULL
              THEN 'id:' || s.canonical_campaign_id
            ELSE 'name:' || s.campaign_name_norm
          END AS campaign_key,
          s.canonical_campaign_id AS campaign_id,
          MAX(NULLIF(TRIM(s.campaign_name), '')) AS campaign_name,
          COALESCE(SUM(s.spend), 0)::numeric AS spend,
          COALESCE(SUM(s.impressions), 0)::bigint AS impressions,
          COALESCE(SUM(s.clicks), 0)::bigint AS media_clicks
        FROM spend_resolved s
        GROUP BY
          CASE
            WHEN s.canonical_campaign_id IS NOT NULL
              THEN 'id:' || s.canonical_campaign_id
            ELSE 'name:' || s.campaign_name_norm
          END,
          s.canonical_campaign_id
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
          ) AS campaign,
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
      )

      SELECT
        campaign_id,
        campaign,
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
      ORDER BY revenue DESC, spend DESC, campaign ASC
    `, [from, to]);

    res.json({
      ok: true,
      range: { from, to },
      campaigns: result.rows
    });

  } catch (error) {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

app.get("/api/adsets", async (req, res) => {
  try {
    const { from, to } = parseReportRange(req.query);
    const rows = await breakdowns.getAdsetRows(from, to);

    res.json({
      ok: true,
      range: { from, to },
      adsets: rows
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

app.get("/api/ads", async (req, res) => {
  try {
    const { from, to } = parseReportRange(req.query);
    const rows = await breakdowns.getAdRows(from, to);

    res.json({
      ok: true,
      range: { from, to },
      ads: rows
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

app.post("/track/spend", async (req, res) => {
  try {
    const {
      spend_date,
      source,
      campaign_id,
      campaign_name,
      adset_id,
      adset_name,
      ad_id,
      ad_name,
      spend,
      impressions,
      clicks
    } = req.body;

    if (!spend_date) {
      return res.status(400).json({
        ok: false,
        error: "spend_date obrigatorio"
      });
    }

    const finalSpendDate = String(spend_date).trim();
    const parsedSpendDate = new Date(finalSpendDate + "T00:00:00Z");

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(finalSpendDate) ||
      Number.isNaN(parsedSpendDate.getTime()) ||
      parsedSpendDate.toISOString().slice(0, 10) !== finalSpendDate
    ) {
      return res.status(400).json({
        ok: false,
        error: "spend_date deve ser uma data valida no formato YYYY-MM-DD"
      });
    }

    const finalCampaignId = String(campaign_id || "").trim();
    const finalCampaignName = String(campaign_name || "").trim();
    const finalAdsetId = String(adset_id || "").trim();
    const finalAdsetName = String(adset_name || "").trim();
    const finalAdId = String(ad_id || "").trim();
    const finalAdName = String(ad_name || "").trim();

    if (!finalCampaignId && !finalCampaignName) {
      return res.status(400).json({
        ok: false,
        error: "campaign_id ou campaign_name obrigatorio"
      });
    }

    const finalSource =
      String(source || "meta").trim().toLowerCase() || "meta";
    const finalSpend = Number(spend || 0);
    const finalImpressions = Number(impressions || 0);
    const finalClicks = Number(clicks || 0);

    if (
      !Number.isFinite(finalSpend) ||
      !Number.isFinite(finalImpressions) ||
      !Number.isFinite(finalClicks)
    ) {
      return res.status(400).json({
        ok: false,
        error: "valores de midia invalidos"
      });
    }

    if (
      !Number.isInteger(finalImpressions) ||
      !Number.isInteger(finalClicks)
    ) {
      return res.status(400).json({
        ok: false,
        error: "impressions e clicks devem ser numeros inteiros"
      });
    }

    if (finalSpend < 0 || finalImpressions < 0 || finalClicks < 0) {
      return res.status(400).json({
        ok: false,
        error: "valores de midia nao podem ser negativos"
      });
    }

    const result = await pool.query(`
      INSERT INTO dr_ad_spend (
        spend_date,
        source,
        campaign_id,
        campaign_name,
        adset_id,
        adset_name,
        ad_id,
        ad_name,
        spend,
        impressions,
        clicks
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      )

      ON CONFLICT (
        spend_date,
        (LOWER(TRIM(COALESCE(source, '')))),
        (COALESCE(
          NULLIF(TRIM(campaign_id), ''),
          'name:' || LOWER(TRIM(COALESCE(campaign_name, '')))
        )),
        (COALESCE(
          NULLIF(TRIM(adset_id), ''),
          'name:' || LOWER(TRIM(COALESCE(adset_name, '')))
        )),
        (COALESCE(
          NULLIF(TRIM(ad_id), ''),
          'name:' || LOWER(TRIM(COALESCE(ad_name, '')))
        ))
      )

      DO UPDATE SET
        campaign_name = EXCLUDED.campaign_name,
        adset_name = EXCLUDED.adset_name,
        ad_name = EXCLUDED.ad_name,
        spend = EXCLUDED.spend,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        updated_at = NOW()

      RETURNING
        id,
        spend_date,
        source,
        campaign_id,
        campaign_name,
        adset_id,
        adset_name,
        ad_id,
        ad_name,
        spend,
        impressions,
        clicks
    `, [
      finalSpendDate,
      finalSource,
      finalCampaignId || null,
      finalCampaignName || null,
      finalAdsetId || null,
      finalAdsetName || null,
      finalAdId || null,
      finalAdName || null,
      finalSpend,
      finalImpressions,
      finalClicks
    ]);

    res.json({
      ok: true,
      spend: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/dashboard.html");
});

async function start() {

  try {

    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL nao configurada");
    }

    await initDb();

    app.listen(PORT, () => {
      console.log("Direct Response OS online na porta " + PORT);
    });

  } catch (error) {

    console.error("Erro ao iniciar Direct Response OS:");
    console.error(error);

    process.exit(1);

  }

}

start();

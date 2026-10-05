require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createBreakdownService } = require("./breakdowns");
const { normalizeSpendInput, upsertSpend } = require("./spendStore");
const {
  getMetaStatus,
  secretMatches,
  runMetaSync
} = require("./metaAds");
const {
  initOfferDb,
  registerOfferRoutes,
  syncLeadCrmFromEvent
} = require("./offerFoundation");
const {
  enqueueAutomationEvent,
  initAutomationDb,
  registerAutomationRoutes,
  startAutomationWorker
} = require("./automationHub");
const {
  initActivationDb,
  registerActivationRoutes
} = require("./activationHub");
const {
  initUtmifyDb,
  registerUtmifyRoutes
} = require("./utmifyMcp");
const {
  registerTrackingHealthRoutes
} = require("./trackingHealth");
const { initCpaDb, registerCpaRoutes } = require("./cpaEngine");
const { registerDecisionRoutes } = require("./decisionEngine");
const { normalizeTracking, ingestTracking } = require("./trackingIngestion");
const { initFunnelDb, registerFunnelRoutes } = require("./funnelIntegration");
const { initHublaDb, registerHublaRoutes, startHublaWorker } = require("./hublaWebhook");
const { initClickCaptureDb, registerClickRoutes, hasAdminSecret, publicEventAllowed, requireAdmin } = require("./clickCapture");
const { initMonitorDb, createMonitor, startHealthWatch, registerHealthRoutes } = require("./operationHealth");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Sem este limite, uma queda do banco deixa as requisicoes penduradas indefinidamente.
  connectionTimeoutMillis: 8000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// Monitor de saude: registra erros 5xx e mede o router. Fica antes das rotas para enxergar todas.
const monitor = createMonitor(pool);
app.use(monitor.middleware);

const breakdowns = createBreakdownService(pool);
const ingestionHooks = { syncLeadCrmFromEvent, enqueueAutomationEvent };

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

const { router } = registerOfferRoutes({ app, pool, hashIp, parseReportRange });
const healthWatch = startHealthWatch({ pool, router, monitor });
registerHealthRoutes(app, healthWatch);
registerAutomationRoutes(app, pool);
registerActivationRoutes(app, pool);
registerUtmifyRoutes(app, pool);
registerTrackingHealthRoutes(app, pool);
registerCpaRoutes(app, pool);
registerDecisionRoutes(app, pool);
registerFunnelRoutes(app, pool, ingestionHooks);
const hublaRuntime = { kick: null };
registerHublaRoutes(app, pool, ingestionHooks, hublaRuntime);

app.get("/", async (req, res) => {

  try {

    const database = await pool.query(`
      SELECT NOW() AS agora
    `);

    res.json({
      status: "online",
      service: "oferta-dr",
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
    service: "oferta-dr"
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

app.get("/api/overview/timeseries", async (req, res) => {
  try {
    const { from, to } = parseReportRange(req.query);

    const result = await pool.query(`
      WITH bounds AS (
        SELECT
          COALESCE(
            $1::date,
            ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '29 days')::date
          ) AS from_date,
          COALESCE(
            $2::date,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date
          ) AS to_date
      ),
      days AS (
        SELECT generate_series(
          (SELECT from_date FROM bounds),
          (SELECT to_date FROM bounds),
          INTERVAL '1 day'
        )::date AS day
      ),
      media AS (
        SELECT
          spend_date AS day,
          COALESCE(SUM(spend), 0)::numeric AS spend
        FROM dr_ad_spend, bounds
        WHERE spend_date BETWEEN bounds.from_date AND bounds.to_date
        GROUP BY spend_date
      ),
      sales AS (
        SELECT
          (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date) AS day,
          COUNT(*) FILTER (WHERE event_name = 'purchase')::int AS purchases,
          COALESCE(SUM(value) FILTER (WHERE event_name = 'purchase'), 0)::numeric AS revenue
        FROM dr_events, bounds
        WHERE (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)
          BETWEEN bounds.from_date AND bounds.to_date
        GROUP BY 1
      )
      SELECT
        d.day,
        COALESCE(m.spend, 0)::numeric AS spend,
        COALESCE(s.purchases, 0)::int AS purchases,
        COALESCE(s.revenue, 0)::numeric AS revenue,
        CASE
          WHEN COALESCE(m.spend, 0) > 0
            THEN ROUND(COALESCE(s.revenue, 0) / m.spend, 4)
          ELSE NULL
        END AS roas
      FROM days d
      LEFT JOIN media m ON m.day = d.day
      LEFT JOIN sales s ON s.day = d.day
      ORDER BY d.day ASC
    `, [from, to]);

    res.json({
      ok: true,
      requested_range: { from, to },
      range: {
        from: result.rows[0]?.day || null,
        to: result.rows[result.rows.length - 1]?.day || null
      },
      points: result.rows
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

registerClickRoutes(app, pool, hashIp);

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

function trackingHandler(purchase) {
  return async (req, res) => {
    // Receita e eventos pos-compra so entram por servidor confiavel; eventos de navegacao seguem publicos.
    if (purchase) { if (!requireAdmin(req, res)) return; }
    else if (!publicEventAllowed(req.body) && !hasAdminSecret(req)) {
      return res.status(401).json({ ok: false, error: "evento exige autenticacao de servidor" });
    }
    try {
      const input = normalizeTracking(req.body, purchase);
      const result = await ingestTracking(pool, input, ingestionHooks);
      res.json({ ok: true, duplicate: result.duplicate, event_id: input.event_id,
        ...(purchase ? { order_id: input.order_id, order: result.order } : {}),
        event: result.duplicate ? null : result.event });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false,
        error: error.statusCode ? error.message : "erro interno" });
    }
  };
}
app.post("/track/event", trackingHandler(false));
app.post("/track/purchase", trackingHandler(true));

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

app.get("/integrations/meta/status", (req, res) => {
  res.json({
    ok: true,
    ...getMetaStatus(process.env)
  });
});

app.post("/integrations/meta/sync", async (req, res) => {
  const status = getMetaStatus(process.env);

  if (!status.has_sync_secret) {
    return res.status(503).json({
      ok: false,
      error: "sincronizacao Meta Ads nao configurada"
    });
  }

  const receivedSecret =
    String(req.get("x-sync-secret") || "").trim();
  const expectedSecret =
    String(process.env.META_SYNC_SECRET || "").trim();

  if (!secretMatches(expectedSecret, receivedSecret)) {
    return res.status(401).json({
      ok: false,
      error: "nao autorizado"
    });
  }

  try {
    const sync = await runMetaSync({
      pool,
      body: req.body || {},
      env: process.env
    });

    res.json({
      ok: true,
      sync
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (statusCode === 503) {
      return res.status(503).json({
        ok: false,
        error: "integracao Meta Ads nao configurada",
        missing: Array.isArray(error.missing) ? error.missing : []
      });
    }

    if (statusCode === 400 || statusCode === 409) {
      return res.status(statusCode).json({
        ok: false,
        error: error.message
      });
    }

    if (statusCode === 502) {
      return res.status(502).json({
        ok: false,
        error: "falha ao sincronizar Meta Ads"
      });
    }

    res.status(500).json({
      ok: false,
      error: "erro interno"
    });
  }
});

app.post("/track/spend", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const normalized = normalizeSpendInput(
      req.body || {},
      { defaultSource: "meta" }
    );

    const spend = await upsertSpend(pool, normalized);

    res.json({
      ok: true,
      spend
    });
  } catch (error) {
    const statusCode = error.statusCode === 400 ? 400 : 500;

    res.status(statusCode).json({
      ok: false,
      error: statusCode === 400 ? error.message : "erro interno"
    });
  }
});

app.get("/dashboard", (req, res) => {
  res.sendFile(__dirname + "/dashboard.html");
});

app.get("/assets/router-dashboard.js", (req, res) => {
  res.sendFile(__dirname + "/routerDashboard.js");
});

app.get("/assets/health-dashboard.js", (req, res) => {
  res.sendFile(__dirname + "/healthDashboard.js");
});

app.get("/assets/hubla-dashboard.js", (req, res) => {
  res.sendFile(__dirname + "/hublaDashboard.js");
});

app.get("/assets/dr-checkout.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(__dirname + "/checkoutLinks.js");
});

app.get("/admin", (req, res) => {
  res.sendFile(__dirname + "/admin.html");
});

async function start() {

  try {

    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL nao configurada");
    }

    await initDb();
    await initOfferDb(pool);
    await initAutomationDb(pool);
    await initActivationDb(pool);
    await initUtmifyDb(pool);
    await initCpaDb(pool);
    await initFunnelDb(pool);
    await initHublaDb(pool);
    await initClickCaptureDb(pool);
    await initMonitorDb(pool);
    healthWatch.begin();
    startAutomationWorker(pool);
    hublaRuntime.kick = startHublaWorker(pool, ingestionHooks).kick;

    app.listen(PORT, () => {
      console.log("Oferta DR online na porta " + PORT);
    });

  } catch (error) {

    console.error("Erro ao iniciar Oferta DR:");
    console.error(error);

    process.exit(1);

  }

}

start();

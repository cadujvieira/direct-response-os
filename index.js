require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

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

function hashIp(ip) {
  return crypto
    .createHash("sha256")
    .update(String(ip || ""))
    .digest("hex");
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
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM dr_clicks)::int AS clicks,
        (SELECT COUNT(*) FROM dr_leads)::int AS leads,
        (
          SELECT COUNT(*)
          FROM dr_events
          WHERE event_name = 'checkout_started'
        )::int AS checkouts,
        (
          SELECT COUNT(*)
          FROM dr_events
          WHERE event_name = 'purchase'
        )::int AS purchases,
        (
          SELECT COALESCE(SUM(value), 0)
          FROM dr_events
          WHERE event_name = 'purchase'
        )::numeric AS revenue
    `);

    res.json({
      ok: true,
      summary: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
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
    const result = await pool.query(`
      WITH lead_by_click AS (
        SELECT
          click_id,
          COUNT(*)::int AS leads
        FROM dr_leads
        WHERE click_id IS NOT NULL
        GROUP BY click_id
      ),

      event_by_click AS (
        SELECT
          click_id,

          COUNT(*) FILTER (
            WHERE event_name = 'checkout_started'
          )::int AS checkouts,

          COUNT(*) FILTER (
            WHERE event_name = 'purchase'
          )::int AS purchases,

          COALESCE(
            SUM(value) FILTER (
              WHERE event_name = 'purchase'
            ),
            0
          )::numeric AS revenue

        FROM dr_events
        WHERE click_id IS NOT NULL
        GROUP BY click_id
      )

      SELECT
        COALESCE(
          NULLIF(c.utm_campaign, ''),
          'Sem campanha'
        ) AS campaign,

        COUNT(*)::int AS clicks,

        COALESCE(
          SUM(l.leads),
          0
        )::int AS leads,

        COALESCE(
          SUM(e.checkouts),
          0
        )::int AS checkouts,

        COALESCE(
          SUM(e.purchases),
          0
        )::int AS purchases,

        COALESCE(
          SUM(e.revenue),
          0
        )::numeric AS revenue

      FROM dr_clicks c

      LEFT JOIN lead_by_click l
        ON l.click_id = c.click_id

      LEFT JOIN event_by_click e
        ON e.click_id = c.click_id

      GROUP BY
        COALESCE(
          NULLIF(c.utm_campaign, ''),
          'Sem campanha'
        )

      ORDER BY
        revenue DESC,
        purchases DESC,
        clicks DESC
    `);

    res.json({
      ok: true,
      campaigns: result.rows
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

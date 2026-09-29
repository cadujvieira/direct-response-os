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

const crypto = require("crypto");
const {
  parseCookies,
  selectWeightedVariant,
  buildRedirectUrl,
  resolveRouterIdentity,
  routingTrackingParams
} = require("./routing");
const { createRouter } = require("./resilientRouter");

const LIFECYCLE_STAGES = [
  "lead",
  "checkout",
  "customer",
  "call_booked",
  "mentorship_opportunity",
  "mentorship_customer",
  "refunded"
];

const TEMPERATURES = ["cold", "warm", "hot"];

const STAGE_RANK = new Map(LIFECYCLE_STAGES.map((value, index) => [value, index]));
const TEMP_RANK = new Map(TEMPERATURES.map((value, index) => [value, index]));

const EVENT_CRM_MAP = {
  checkout_started: { lifecycle_stage: "checkout", temperature: "warm" },
  purchase: { lifecycle_stage: "customer", temperature: "hot" },
  order_bump_purchase: { lifecycle_stage: "customer", temperature: "hot" },
  call_booked: { lifecycle_stage: "call_booked", temperature: "hot" },
  call_attended: { lifecycle_stage: "mentorship_opportunity", temperature: "hot" },
  call_no_show: { lifecycle_stage: "call_booked", temperature: "hot" },
  mentorship_offer: { lifecycle_stage: "mentorship_opportunity", temperature: "hot" },
  mentorship_purchase: { lifecycle_stage: "mentorship_customer", temperature: "hot" },
  refund: { lifecycle_stage: "refunded", temperature: "hot" }
};

function deriveCrmState(currentStage, currentTemp, eventName) {
  const mapping = EVENT_CRM_MAP[eventName];
  if (!mapping) return null;

  const safeStage = STAGE_RANK.has(currentStage) ? currentStage : "lead";
  const safeTemp = TEMP_RANK.has(currentTemp) ? currentTemp : "cold";
  const mappedStage = mapping.lifecycle_stage;
  const mappedTemp = mapping.temperature;

  const nextStage = mappedStage === "refunded"
    ? mappedStage
    : (STAGE_RANK.get(mappedStage) > STAGE_RANK.get(safeStage)
      ? mappedStage
      : safeStage);

  const nextTemp = TEMP_RANK.get(mappedTemp) > TEMP_RANK.get(safeTemp)
    ? mappedTemp
    : safeTemp;

  return { lifecycle_stage: nextStage, temperature: nextTemp };
}

function normalizeExperimentConfig(body = {}) {
  const name = String(body.name || "").trim();
  const active = body.active !== false;
  const variants = Array.isArray(body.variants) ? body.variants : [];

  if (!name) {
    const error = new Error("name obrigatorio");
    error.statusCode = 400;
    throw error;
  }

  if (variants.length === 0) {
    const error = new Error("informe pelo menos uma variante");
    error.statusCode = 400;
    throw error;
  }

  const seen = new Set();
  const normalizedVariants = variants.map((variant) => {
    const variantName = String(variant?.name || "").trim();
    const destinationUrl = String(variant?.destination_url || "").trim();
    const weight = Number(variant?.weight);
    const variantActive = variant?.active !== false;

    if (!variantName || seen.has(variantName)) {
      const error = new Error("nomes de variantes devem ser unicos e nao vazios");
      error.statusCode = 400;
      throw error;
    }
    seen.add(variantName);

    let parsed;
    try {
      parsed = new URL(destinationUrl);
    } catch {
      const error = new Error("destination_url invalida para " + variantName);
      error.statusCode = 400;
      throw error;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      const error = new Error("destination_url deve usar http ou https");
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isFinite(weight) || weight < 0) {
      const error = new Error("peso deve ser um numero maior ou igual a zero");
      error.statusCode = 400;
      throw error;
    }

    return {
      name: variantName,
      destination_url: parsed.toString(),
      weight,
      active: variantActive
    };
  });

  const totalActiveWeight = normalizedVariants.reduce(
    (sum, variant) => sum + (variant.active ? variant.weight : 0),
    0
  );

  if (!(totalActiveWeight > 0)) {
    const error = new Error("ao menos uma variante ativa precisa ter peso maior que zero");
    error.statusCode = 400;
    throw error;
  }

  return { name, active, variants: normalizedVariants };
}

function normalizeWeightUpdates(weights) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    const error = new Error("weights deve ser um objeto por nome de variante");
    error.statusCode = 400;
    throw error;
  }

  const entries = Object.entries(weights);
  if (entries.length === 0) {
    const error = new Error("informe pelo menos uma variante");
    error.statusCode = 400;
    throw error;
  }

  return entries.map(([name, value]) => {
    const normalizedName = String(name || "").trim();
    const weight = Number(value);

    if (!normalizedName) {
      const error = new Error("nome de variante invalido");
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isFinite(weight) || weight < 0) {
      const error = new Error("peso deve ser um numero maior ou igual a zero");
      error.statusCode = 400;
      throw error;
    }

    return { name: normalizedName, weight };
  });
}

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function normalizePhone(value) {
  const normalized = String(value || "").replace(/[^0-9]/g, "");
  return normalized || null;
}

function secretMatches(expected, received) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const receivedBuffer = Buffer.from(String(received || ""));
  if (expectedBuffer.length === 0 || expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function requireAdmin(req, res) {
  const expected = String(process.env.DR_ADMIN_SECRET || "").trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: "DR_ADMIN_SECRET nao configurado" });
    return false;
  }
  const received = String(req.get("x-admin-secret") || "").trim();
  if (!secretMatches(expected, received)) {
    res.status(401).json({ ok: false, error: "nao autorizado" });
    return false;
  }
  return true;
}

function cookieHeader(name, value, secure) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Max-Age=7776000",
    "SameSite=Lax",
    "HttpOnly"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

async function initOfferDb(pool) {
  await pool.query(`
    ALTER TABLE dr_clicks
      ADD COLUMN IF NOT EXISTS fbclid TEXT,
      ADD COLUMN IF NOT EXISTS gclid TEXT;
  `);

  await pool.query(`
    ALTER TABLE dr_leads
      ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT DEFAULT 'lead',
      ADD COLUMN IF NOT EXISTS temperature TEXT DEFAULT 'cold',
      ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS crm_updated_at TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_experiments (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_experiment_variants (
      id SERIAL PRIMARY KEY,
      experiment_id INTEGER NOT NULL REFERENCES dr_experiments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      weight NUMERIC NOT NULL DEFAULT 1 CHECK (weight >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (experiment_id, name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_experiment_assignments (
      id BIGSERIAL PRIMARY KEY,
      experiment_id INTEGER NOT NULL REFERENCES dr_experiments(id) ON DELETE CASCADE,
      variant_id INTEGER NOT NULL REFERENCES dr_experiment_variants(id),
      click_id TEXT NOT NULL,
      session_key TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (experiment_id, click_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_experiment_assignments_click_idx
    ON dr_experiment_assignments (click_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_experiment_assignments_visitor_idx
    ON dr_experiment_assignments (experiment_id, session_key);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_lead_crm_history (
      id BIGSERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES dr_leads(id) ON DELETE CASCADE,
      old_lifecycle_stage TEXT,
      new_lifecycle_stage TEXT,
      old_temperature TEXT,
      new_temperature TEXT,
      old_lead_score INTEGER,
      new_lead_score INTEGER,
      note TEXT,
      actor TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_events_click_idx
    ON dr_events (click_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_events_email_idx
    ON dr_events (LOWER(email))
    WHERE email IS NOT NULL AND TRIM(email) <> '';
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_events_phone_idx
    ON dr_events (regexp_replace(telefone, '[^0-9]', '', 'g'))
    WHERE telefone IS NOT NULL
      AND regexp_replace(telefone, '[^0-9]', '', 'g') <> '';
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_leads_crm_stage_idx
    ON dr_leads (lifecycle_stage, temperature, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_crm_followups (
      id BIGSERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES dr_leads(id) ON DELETE CASCADE,
      due_at TIMESTAMPTZ NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_by TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_crm_followups_queue_idx
    ON dr_crm_followups (status, due_at ASC, priority);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_crm_followups_lead_idx
    ON dr_crm_followups (lead_id, status, due_at ASC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_crm_saved_segments (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dr_crm_saved_segments_name_idx
    ON dr_crm_saved_segments (LOWER(name));
  `);
}

async function findLeadForEvent(client, payload = {}) {
  if (payload.lead_id != null) {
    if (!Number.isInteger(payload.lead_id) || payload.lead_id < 1) {
      const error = new Error("lead_id interno invalido"); error.statusCode = 409; throw error;
    }
    return (await client.query(`SELECT id, lifecycle_stage, temperature, lead_score
      FROM dr_leads WHERE id = $1 FOR UPDATE`, [payload.lead_id])).rows[0] || null;
  }
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.telefone);
  const clickId = String(payload.click_id || "").trim() || null;

  const result = await client.query(`
    SELECT id, lifecycle_stage, temperature, lead_score
    FROM dr_leads
    WHERE ($1::text IS NOT NULL AND click_id = $1)
       OR ($2::text IS NOT NULL AND LOWER(email) = $2)
       OR ($3::text IS NOT NULL AND regexp_replace(telefone, '[^0-9]', '', 'g') = $3)
    ORDER BY
      CASE WHEN $1::text IS NOT NULL AND click_id = $1 THEN 0 ELSE 1 END,
      updated_at DESC,
      id DESC
    LIMIT 1
    FOR UPDATE
  `, [clickId, email, phone]);

  return result.rows[0] || null;
}

async function syncLeadCrmFromEvent(pool, payload = {}, options = {}) {
  const mapping = EVENT_CRM_MAP[payload.event_name];
  if (!mapping) return null;

  const ownsTransaction = !options.client;
  const client = options.client || await pool.connect();
  try {
    if (ownsTransaction) await client.query("BEGIN");
    const lead = await findLeadForEvent(client, payload);
    if (!lead) {
      if (ownsTransaction) await client.query("COMMIT");
      return null;
    }

    const currentStage = lead.lifecycle_stage || "lead";
    const currentTemp = lead.temperature || "cold";
    const nextState = deriveCrmState(currentStage, currentTemp, payload.event_name);
    const nextStage = nextState.lifecycle_stage;
    const nextTemp = nextState.temperature;

    if (nextStage === currentStage && nextTemp === currentTemp) {
      if (ownsTransaction) await client.query("COMMIT");
      return lead;
    }

    const updated = await client.query(`
      UPDATE dr_leads
      SET lifecycle_stage = $1,
          temperature = $2,
          crm_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $3
      RETURNING id, lifecycle_stage, temperature, lead_score
    `, [nextStage, nextTemp, lead.id]);

    await client.query(`
      INSERT INTO dr_lead_crm_history (
        lead_id,
        old_lifecycle_stage,
        new_lifecycle_stage,
        old_temperature,
        new_temperature,
        old_lead_score,
        new_lead_score,
        note,
        actor
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      lead.id,
      currentStage,
      nextStage,
      currentTemp,
      nextTemp,
      lead.lead_score || 0,
      lead.lead_score || 0,
      `evento: ${payload.event_name}`,
      "system:event"
    ]);

    if (ownsTransaction) await client.query("COMMIT");
    return updated.rows[0] || null;
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
function registerOfferRoutes({ app, pool, hashIp, parseReportRange }) {
  // Router que redireciona mesmo com o banco lento ou fora do ar (resilientRouter.js).
  const router = createRouter({ pool, hashIp, cookieHeader });
  app.get("/go/:slug", router.handler);
  app.get("/api/router/health", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...router.health() });
  });

  app.get("/api/crm/summary", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE temperature = 'cold')::int AS cold,
          COUNT(*) FILTER (WHERE temperature = 'warm')::int AS warm,
          COUNT(*) FILTER (WHERE temperature = 'hot')::int AS hot,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'lead')::int AS leads,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'checkout')::int AS checkout,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'customer')::int AS customers,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'call_booked')::int AS call_booked,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'mentorship_opportunity')::int AS mentorship_opportunities,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'mentorship_customer')::int AS mentorship_customers,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'refunded')::int AS refunded
        FROM dr_leads
      `);

      res.json({ ok: true, crm: result.rows[0] });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/crm/facets", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const countsResult = await pool.query(`
        WITH crm_rows AS (
          SELECT
            l.id,
            l.temperature,
            l.lifecycle_stage,
            CASE
              WHEN COALESCE(ev.has_refund, FALSE) THEN 'refunded'
              WHEN COALESCE(ev.has_mentorship_purchase, FALSE) THEN 'mentorship_customer'
              WHEN COALESCE(ev.has_no_show, FALSE)
                AND NOT COALESCE(ev.has_call_attended, FALSE) THEN 'no_show'
              WHEN (
                COALESCE(ev.has_call_attended, FALSE)
                OR COALESCE(ev.has_mentorship_offer, FALSE)
              )
                AND NOT COALESCE(ev.has_mentorship_purchase, FALSE)
                THEN 'mentorship_opportunity'
              WHEN COALESCE(ev.has_call_booked, FALSE)
                AND NOT COALESCE(ev.has_call_attended, FALSE)
                AND NOT COALESCE(ev.has_no_show, FALSE)
                THEN 'call_booked'
              WHEN COALESCE(ev.has_purchase, FALSE)
                AND NOT COALESCE(ev.has_call_booked, FALSE)
                THEN 'frontend_no_call'
              WHEN COALESCE(ev.has_checkout, FALSE)
                AND NOT COALESCE(ev.has_purchase, FALSE)
                THEN 'checkout_abandoned'
              ELSE 'lead'
            END AS crm_segment
          FROM dr_leads l
          LEFT JOIN LATERAL (
            WITH matched_events AS (
              SELECT DISTINCT e.id, e.event_name, e.created_at
              FROM dr_events e
              WHERE
                (l.click_id IS NOT NULL AND e.click_id = l.click_id)
                OR (
                  l.email IS NOT NULL
                  AND e.email IS NOT NULL
                  AND LOWER(e.email) = LOWER(l.email)
                )
                OR (
                  l.telefone IS NOT NULL
                  AND e.telefone IS NOT NULL
                  AND regexp_replace(e.telefone, '[^0-9]', '', 'g') =
                      regexp_replace(l.telefone, '[^0-9]', '', 'g')
                )
            )
            SELECT
              BOOL_OR(event_name = 'checkout_started') AS has_checkout,
              BOOL_OR(event_name = 'purchase') AS has_purchase,
              BOOL_OR(event_name = 'call_booked') AS has_call_booked,
              BOOL_OR(event_name = 'call_attended') AS has_call_attended,
              BOOL_OR(event_name = 'call_no_show') AS has_no_show,
              BOOL_OR(event_name = 'mentorship_offer') AS has_mentorship_offer,
              BOOL_OR(event_name = 'mentorship_purchase') AS has_mentorship_purchase,
              BOOL_OR(event_name = 'refund') AS has_refund
            FROM matched_events
          ) ev ON TRUE
        )
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE temperature = 'cold')::int AS cold,
          COUNT(*) FILTER (WHERE temperature = 'warm')::int AS warm,
          COUNT(*) FILTER (WHERE temperature = 'hot')::int AS hot,
          COUNT(*) FILTER (WHERE lifecycle_stage = 'customer')::int AS customers,
          COUNT(*) FILTER (WHERE crm_segment = 'checkout_abandoned')::int AS checkout_abandoned,
          COUNT(*) FILTER (WHERE crm_segment = 'frontend_no_call')::int AS frontend_no_call,
          COUNT(*) FILTER (WHERE crm_segment = 'call_booked')::int AS call_booked,
          COUNT(*) FILTER (WHERE crm_segment = 'no_show')::int AS no_show,
          COUNT(*) FILTER (WHERE crm_segment = 'mentorship_opportunity')::int AS mentorship_opportunity,
          COUNT(*) FILTER (WHERE crm_segment = 'mentorship_customer')::int AS mentorship_customer,
          COUNT(*) FILTER (WHERE crm_segment = 'refunded')::int AS refunded
        FROM crm_rows
      `);

      const sourcesResult = await pool.query(`
        SELECT DISTINCT utm_source AS value
        FROM dr_leads
        WHERE utm_source IS NOT NULL AND TRIM(utm_source) <> ''
        ORDER BY utm_source
        LIMIT 100
      `);

      const campaignsResult = await pool.query(`
        SELECT DISTINCT utm_campaign AS value
        FROM dr_leads
        WHERE utm_campaign IS NOT NULL AND TRIM(utm_campaign) <> ''
        ORDER BY utm_campaign
        LIMIT 200
      `);

      res.json({
        ok: true,
        counts: countsResult.rows[0],
        sources: sourcesResult.rows.map((row) => row.value),
        campaigns: campaignsResult.rows.map((row) => row.value)
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/crm/leads", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const conditions = [];
      const values = [];

      const add = (sql, value) => {
        values.push(value);
        conditions.push(sql.replace("?", "$" + values.length));
      };

      if (req.query.lead_id) {
        const leadId = Number(req.query.lead_id);
        if (!Number.isInteger(leadId) || leadId <= 0) {
          return res.status(400).json({ ok: false, error: "lead_id invalido" });
        }
        add("id = ?", leadId);
      }

      if (req.query.lifecycle_stage) {
        add("lifecycle_stage = ?", String(req.query.lifecycle_stage));
      }

      if (req.query.temperature) {
        add("temperature = ?", String(req.query.temperature));
      }

      if (req.query.utm_source) {
        add("LOWER(COALESCE(utm_source,'')) = LOWER(?)", String(req.query.utm_source));
      }

      if (req.query.utm_campaign) {
        add("LOWER(COALESCE(utm_campaign,'')) = LOWER(?)", String(req.query.utm_campaign));
      }

      const allowedSegments = new Set([
        "lead",
        "checkout_abandoned",
        "frontend_no_call",
        "call_booked",
        "no_show",
        "mentorship_opportunity",
        "mentorship_customer",
        "refunded"
      ]);

      if (req.query.segment && allowedSegments.has(String(req.query.segment))) {
        add("crm_segment = ?", String(req.query.segment));
      }

      if (req.query.search) {
        const search = "%" + String(req.query.search).trim().toLowerCase() + "%";
        values.push(search);
        conditions.push(
          "(LOWER(COALESCE(nome,'')) LIKE $" + values.length +
          " OR LOWER(COALESCE(email,'')) LIKE $" + values.length +
          " OR regexp_replace(COALESCE(telefone,''), '[^0-9]', '', 'g') LIKE regexp_replace($" +
          values.length + ", '[^0-9]', '', 'g'))"
        );
      }

      const sortMap = {
        recent: "last_activity_at DESC NULLS LAST, id DESC",
        oldest: "last_activity_at ASC NULLS LAST, id ASC",
        revenue_desc: "total_revenue DESC, last_activity_at DESC NULLS LAST",
        score_desc: "lead_score DESC, last_activity_at DESC NULLS LAST"
      };

      const sort = sortMap[String(req.query.sort || "recent")] || sortMap.recent;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

      values.push(limit, offset);
      const limitParam = "$" + (values.length - 1);
      const offsetParam = "$" + values.length;

      const result = await pool.query(`
        WITH crm_rows AS (
          SELECT
            l.id,
            l.click_id,
            l.nome,
            l.email,
            l.telefone,
            l.status,
            l.lifecycle_stage,
            l.temperature,
            l.lead_score,
            l.utm_source,
            l.utm_medium,
            l.utm_campaign,
            l.utm_content,
            l.created_at,
            l.updated_at,
            l.crm_updated_at,
            ev.last_event,
            ev.last_event_at,
            fu.due_at AS next_followup_at,
            fu.priority AS next_followup_priority,
            fu.note AS next_followup_note,
            COALESCE(ev.front_revenue, 0)::numeric AS front_revenue,
            COALESCE(ev.mentorship_revenue, 0)::numeric AS mentorship_revenue,
            COALESCE(ev.bump_revenue, 0)::numeric AS bump_revenue,
            COALESCE(ev.refunds, 0)::numeric AS refunds,
            (
              COALESCE(ev.front_revenue, 0)
              + COALESCE(ev.mentorship_revenue, 0)
              + COALESCE(ev.bump_revenue, 0)
              - COALESCE(ev.refunds, 0)
            )::numeric AS total_revenue,
            GREATEST(
              l.updated_at,
              COALESCE(ev.last_event_at, l.updated_at)
            ) AS last_activity_at,
            CASE
              WHEN COALESCE(ev.has_refund, FALSE) THEN 'refunded'
              WHEN COALESCE(ev.has_mentorship_purchase, FALSE) THEN 'mentorship_customer'
              WHEN COALESCE(ev.has_no_show, FALSE)
                AND NOT COALESCE(ev.has_call_attended, FALSE) THEN 'no_show'
              WHEN (
                COALESCE(ev.has_call_attended, FALSE)
                OR COALESCE(ev.has_mentorship_offer, FALSE)
              )
                AND NOT COALESCE(ev.has_mentorship_purchase, FALSE)
                THEN 'mentorship_opportunity'
              WHEN COALESCE(ev.has_call_booked, FALSE)
                AND NOT COALESCE(ev.has_call_attended, FALSE)
                AND NOT COALESCE(ev.has_no_show, FALSE)
                THEN 'call_booked'
              WHEN COALESCE(ev.has_purchase, FALSE)
                AND NOT COALESCE(ev.has_call_booked, FALSE)
                THEN 'frontend_no_call'
              WHEN COALESCE(ev.has_checkout, FALSE)
                AND NOT COALESCE(ev.has_purchase, FALSE)
                THEN 'checkout_abandoned'
              ELSE 'lead'
            END AS crm_segment
          FROM dr_leads l
          LEFT JOIN LATERAL (
            WITH matched_events AS (
              SELECT DISTINCT
                e.id,
                e.event_name,
                e.value,
                e.created_at
              FROM dr_events e
              WHERE
                (l.click_id IS NOT NULL AND e.click_id = l.click_id)
                OR (
                  l.email IS NOT NULL
                  AND e.email IS NOT NULL
                  AND LOWER(e.email) = LOWER(l.email)
                )
                OR (
                  l.telefone IS NOT NULL
                  AND e.telefone IS NOT NULL
                  AND regexp_replace(e.telefone, '[^0-9]', '', 'g') =
                      regexp_replace(l.telefone, '[^0-9]', '', 'g')
                )
            )
            SELECT
              (ARRAY_AGG(event_name ORDER BY created_at DESC, id DESC))[1] AS last_event,
              MAX(created_at) AS last_event_at,
              COALESCE(SUM(value) FILTER (WHERE event_name = 'purchase'), 0)::numeric AS front_revenue,
              COALESCE(SUM(value) FILTER (WHERE event_name = 'mentorship_purchase'), 0)::numeric AS mentorship_revenue,
              COALESCE(SUM(value) FILTER (WHERE event_name = 'order_bump_purchase'), 0)::numeric AS bump_revenue,
              COALESCE(SUM(ABS(value)) FILTER (WHERE event_name = 'refund'), 0)::numeric AS refunds,
              BOOL_OR(event_name = 'checkout_started') AS has_checkout,
              BOOL_OR(event_name = 'purchase') AS has_purchase,
              BOOL_OR(event_name = 'call_booked') AS has_call_booked,
              BOOL_OR(event_name = 'call_attended') AS has_call_attended,
              BOOL_OR(event_name = 'call_no_show') AS has_no_show,
              BOOL_OR(event_name = 'mentorship_offer') AS has_mentorship_offer,
              BOOL_OR(event_name = 'mentorship_purchase') AS has_mentorship_purchase,
              BOOL_OR(event_name = 'refund') AS has_refund
            FROM matched_events
          ) ev ON TRUE
          LEFT JOIN LATERAL (
            SELECT due_at, priority, note
            FROM dr_crm_followups
            WHERE lead_id = l.id
              AND status = 'pending'
            ORDER BY due_at ASC, id ASC
            LIMIT 1
          ) fu ON TRUE
        ),
        filtered AS (
          SELECT *
          FROM crm_rows
          ${where}
        )
        SELECT
          *,
          COUNT(*) OVER()::int AS total_count
        FROM filtered
        ORDER BY ${sort}
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
      `, values);

      res.json({
        ok: true,
        leads: result.rows.map(({ total_count, ...row }) => row),
        total: result.rows[0]?.total_count || 0,
        limit,
        offset
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/crm/leads/:id/timeline", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const leadId = Number(req.params.id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return res.status(400).json({ ok: false, error: "lead id invalido" });
    }

    try {
      const leadResult = await pool.query(`
        SELECT id, click_id, nome, email, telefone,
               lifecycle_stage, temperature, lead_score,
               utm_source, utm_medium, utm_campaign, utm_content,
               created_at, updated_at, crm_updated_at
        FROM dr_leads
        WHERE id = $1
        LIMIT 1
      `, [leadId]);

      const lead = leadResult.rows[0];

      if (!lead) {
        return res.status(404).json({ ok: false, error: "lead nao encontrado" });
      }

      const eventResult = await pool.query(`
        SELECT DISTINCT
          id,
          event_name,
          value,
          currency,
          created_at
        FROM dr_events
        WHERE
          ($1::text IS NOT NULL AND click_id = $1)
          OR (
            $2::text IS NOT NULL
            AND email IS NOT NULL
            AND LOWER(email) = LOWER($2)
          )
          OR (
            $3::text IS NOT NULL
            AND telefone IS NOT NULL
            AND regexp_replace(telefone, '[^0-9]', '', 'g') =
                regexp_replace($3, '[^0-9]', '', 'g')
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 200
      `, [lead.click_id, lead.email, lead.telefone]);

      const historyResult = await pool.query(`
        SELECT
          id,
          old_lifecycle_stage,
          new_lifecycle_stage,
          old_temperature,
          new_temperature,
          old_lead_score,
          new_lead_score,
          note,
          actor,
          created_at
        FROM dr_lead_crm_history
        WHERE lead_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 200
      `, [leadId]);

      const followupResult = await pool.query(`
        SELECT
          id,
          due_at,
          priority,
          status,
          note,
          completed_at,
          created_at,
          updated_at
        FROM dr_crm_followups
        WHERE lead_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 200
      `, [leadId]);

      const followupTimeline = followupResult.rows.flatMap((followup) => {
        const entries = [{
          type: "followup",
          action: "scheduled",
          created_at: followup.created_at,
          due_at: followup.due_at,
          priority: followup.priority,
          status: followup.status,
          note: followup.note
        }];

        if (followup.status !== "pending") {
          entries.push({
            type: "followup",
            action: followup.status,
            created_at: followup.completed_at || followup.updated_at,
            due_at: followup.due_at,
            priority: followup.priority,
            status: followup.status,
            note: followup.note
          });
        }

        return entries;
      });

      const timeline = [
        ...eventResult.rows.map((event) => ({
          type: "event",
          created_at: event.created_at,
          event_name: event.event_name,
          value: event.value,
          currency: event.currency
        })),
        ...historyResult.rows.map((history) => ({
          type: "crm",
          created_at: history.created_at,
          old_lifecycle_stage: history.old_lifecycle_stage,
          new_lifecycle_stage: history.new_lifecycle_stage,
          old_temperature: history.old_temperature,
          new_temperature: history.new_temperature,
          old_lead_score: history.old_lead_score,
          new_lead_score: history.new_lead_score,
          note: history.note,
          actor: history.actor
        })),
        ...followupTimeline
      ].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      res.json({ ok: true, lead, timeline });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.patch("/api/crm/leads/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const leadId = Number(req.params.id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return res.status(400).json({ ok: false, error: "lead id invalido" });
    }

    const requestedStage = req.body.lifecycle_stage;
    const requestedTemp = req.body.temperature;
    const requestedScore = req.body.lead_score;

    if (requestedStage != null && !LIFECYCLE_STAGES.includes(requestedStage)) {
      return res.status(400).json({ ok: false, error: "lifecycle_stage invalido" });
    }
    if (requestedTemp != null && !TEMPERATURES.includes(requestedTemp)) {
      return res.status(400).json({ ok: false, error: "temperature invalida" });
    }
    if (requestedScore != null && (!Number.isInteger(Number(requestedScore)) || Number(requestedScore) < 0 || Number(requestedScore) > 100)) {
      return res.status(400).json({ ok: false, error: "lead_score deve estar entre 0 e 100" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(`
        SELECT id, lifecycle_stage, temperature, lead_score
        FROM dr_leads WHERE id = $1 FOR UPDATE
      `, [leadId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "lead nao encontrado" });
      }

      const nextStage = requestedStage ?? current.lifecycle_stage ?? "lead";
      const nextTemp = requestedTemp ?? current.temperature ?? "cold";
      const nextScore = requestedScore == null ? (current.lead_score || 0) : Number(requestedScore);

      const updatedResult = await client.query(`
        UPDATE dr_leads
        SET lifecycle_stage = $1,
            temperature = $2,
            lead_score = $3,
            crm_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, click_id, nome, email, telefone,
                  lifecycle_stage, temperature, lead_score, crm_updated_at
      `, [nextStage, nextTemp, nextScore, leadId]);

      await client.query(`
        INSERT INTO dr_lead_crm_history (
          lead_id, old_lifecycle_stage, new_lifecycle_stage,
          old_temperature, new_temperature,
          old_lead_score, new_lead_score, note, actor
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        leadId,
        current.lifecycle_stage,
        nextStage,
        current.temperature,
        nextTemp,
        current.lead_score || 0,
        nextScore,
        req.body.note || null,
        "admin:api"
      ]);

      await client.query("COMMIT");
      res.json({ ok: true, lead: updatedResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      res.status(500).json({ ok: false, error: "erro interno" });
    } finally {
      client.release();
    }
  });

  app.post("/api/crm/bulk-update", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const leadIds = Array.from(new Set(
      (Array.isArray(req.body.lead_ids) ? req.body.lead_ids : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    ));

    if (leadIds.length > 500) {
      return res.status(400).json({ ok: false, error: "limite de 500 leads por acao" });
    }

    if (leadIds.length === 0) {
      return res.status(400).json({ ok: false, error: "selecione pelo menos um lead" });
    }

    const requestedStage = req.body.lifecycle_stage;
    const requestedTemp = req.body.temperature;
    const requestedScore = req.body.lead_score;
    const note = String(req.body.note || "").trim() || null;

    if (requestedStage != null && !LIFECYCLE_STAGES.includes(requestedStage)) {
      return res.status(400).json({ ok: false, error: "lifecycle_stage invalido" });
    }
    if (requestedTemp != null && !TEMPERATURES.includes(requestedTemp)) {
      return res.status(400).json({ ok: false, error: "temperature invalida" });
    }
    if (
      requestedScore != null &&
      (!Number.isInteger(Number(requestedScore)) ||
        Number(requestedScore) < 0 ||
        Number(requestedScore) > 100)
    ) {
      return res.status(400).json({ ok: false, error: "lead_score deve estar entre 0 e 100" });
    }

    if (
      requestedStage == null &&
      requestedTemp == null &&
      requestedScore == null &&
      !note
    ) {
      return res.status(400).json({ ok: false, error: "nenhuma alteracao informada" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const currentResult = await client.query(`
        SELECT id, lifecycle_stage, temperature, lead_score
        FROM dr_leads
        WHERE id = ANY($1::int[])
        ORDER BY id
        FOR UPDATE
      `, [leadIds]);

      for (const current of currentResult.rows) {
        const nextStage =
          requestedStage ?? current.lifecycle_stage ?? "lead";
        const nextTemp =
          requestedTemp ?? current.temperature ?? "cold";
        const nextScore =
          requestedScore == null
            ? Number(current.lead_score || 0)
            : Number(requestedScore);

        await client.query(`
          UPDATE dr_leads
          SET lifecycle_stage = $1,
              temperature = $2,
              lead_score = $3,
              crm_updated_at = NOW(),
              updated_at = NOW()
          WHERE id = $4
        `, [nextStage, nextTemp, nextScore, current.id]);

        await client.query(`
          INSERT INTO dr_lead_crm_history (
            lead_id, old_lifecycle_stage, new_lifecycle_stage,
            old_temperature, new_temperature,
            old_lead_score, new_lead_score, note, actor
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
          current.id,
          current.lifecycle_stage,
          nextStage,
          current.temperature,
          nextTemp,
          Number(current.lead_score || 0),
          nextScore,
          note,
          "admin:bulk"
        ]);
      }

      await client.query("COMMIT");

      res.json({
        ok: true,
        updated: currentResult.rows.length
      });
    } catch (error) {
      await client.query("ROLLBACK");
      res.status(500).json({ ok: false, error: "erro interno" });
    } finally {
      client.release();
    }
  });

  app.get("/api/crm/followups", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const scope = String(req.query.scope || "all");
    const status = String(req.query.status || "pending");
    const allowedScopes = new Set(["all", "overdue", "today", "upcoming"]);
    const allowedStatuses = new Set(["pending", "done", "cancelled"]);

    if (!allowedScopes.has(scope) || !allowedStatuses.has(status)) {
      return res.status(400).json({ ok: false, error: "filtro de follow-up invalido" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const conditions = ["f.status = $1"];
    const values = [status];

    if (scope === "overdue") {
      conditions.push("f.due_at < NOW()");
    } else if (scope === "today") {
      conditions.push(`
        (f.due_at AT TIME ZONE 'America/Sao_Paulo')::date =
        (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      `);
    } else if (scope === "upcoming") {
      conditions.push(`
        (f.due_at AT TIME ZONE 'America/Sao_Paulo')::date >
        (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      `);
    }

    values.push(limit);

    try {
      const result = await pool.query(`
        SELECT
          f.id,
          f.lead_id,
          f.due_at,
          f.priority,
          f.status,
          f.note,
          f.created_by,
          f.completed_at,
          f.created_at,
          l.nome,
          l.email,
          l.telefone,
          l.temperature,
          l.lifecycle_stage,
          l.utm_source,
          l.utm_campaign
        FROM dr_crm_followups f
        JOIN dr_leads l ON l.id = f.lead_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY
          CASE f.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            ELSE 3
          END,
          f.due_at ASC,
          f.id ASC
        LIMIT $${values.length}
      `, values);

      const countsResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending' AND due_at < NOW())::int AS overdue,
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND (due_at AT TIME ZONE 'America/Sao_Paulo')::date =
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          )::int AS today,
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND (due_at AT TIME ZONE 'America/Sao_Paulo')::date >
                  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          )::int AS upcoming,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM dr_crm_followups
      `);

      res.json({
        ok: true,
        followups: result.rows,
        counts: countsResult.rows[0]
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.post("/api/crm/followups", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const leadIds = Array.from(new Set(
      (Array.isArray(req.body.lead_ids) ? req.body.lead_ids : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    ));

    if (leadIds.length > 500) {
      return res.status(400).json({ ok: false, error: "limite de 500 leads por acao" });
    }

    const dueAt = new Date(req.body.due_at);
    const priority = String(req.body.priority || "normal");
    const note = String(req.body.note || "").trim() || null;
    const allowedPriorities = new Set(["low", "normal", "high", "urgent"]);

    if (leadIds.length === 0) {
      return res.status(400).json({ ok: false, error: "selecione pelo menos um lead" });
    }
    if (Number.isNaN(dueAt.getTime())) {
      return res.status(400).json({ ok: false, error: "data de follow-up invalida" });
    }
    if (!allowedPriorities.has(priority)) {
      return res.status(400).json({ ok: false, error: "prioridade invalida" });
    }

    try {
      const result = await pool.query(`
        INSERT INTO dr_crm_followups (
          lead_id, due_at, priority, note, created_by
        )
        SELECT
          id, $2::timestamptz, $3, $4, 'admin:crm'
        FROM dr_leads
        WHERE id = ANY($1::int[])
        RETURNING id, lead_id, due_at, priority, status, note
      `, [leadIds, dueAt.toISOString(), priority, note]);

      res.status(201).json({
        ok: true,
        created: result.rows.length,
        followups: result.rows
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.patch("/api/crm/followups/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const followupId = Number(req.params.id);
    const status = req.body.status == null ? null : String(req.body.status);
    const priority = req.body.priority == null ? null : String(req.body.priority);
    const note = req.body.note == null ? null : String(req.body.note).trim();
    const dueAt =
      req.body.due_at == null ? null : new Date(req.body.due_at);
    const allowedStatuses = new Set(["pending", "done", "cancelled"]);
    const allowedPriorities = new Set(["low", "normal", "high", "urgent"]);

    if (!Number.isInteger(followupId) || followupId <= 0) {
      return res.status(400).json({ ok: false, error: "follow-up invalido" });
    }
    if (status != null && !allowedStatuses.has(status)) {
      return res.status(400).json({ ok: false, error: "status invalido" });
    }
    if (priority != null && !allowedPriorities.has(priority)) {
      return res.status(400).json({ ok: false, error: "prioridade invalida" });
    }
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      return res.status(400).json({ ok: false, error: "data invalida" });
    }

    try {
      const result = await pool.query(`
        UPDATE dr_crm_followups
        SET status = COALESCE($1, status),
            priority = COALESCE($2, priority),
            note = CASE WHEN $3::text IS NULL THEN note ELSE $3 END,
            due_at = COALESCE($4::timestamptz, due_at),
            completed_at = CASE
              WHEN COALESCE($1, status) = 'done' THEN COALESCE(completed_at, NOW())
              WHEN COALESCE($1, status) = 'pending' THEN NULL
              ELSE completed_at
            END,
            updated_at = NOW()
        WHERE id = $5
        RETURNING id, lead_id, due_at, priority, status, note, completed_at
      `, [
        status,
        priority,
        req.body.note == null ? null : note,
        dueAt ? dueAt.toISOString() : null,
        followupId
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "follow-up nao encontrado" });
      }

      res.json({ ok: true, followup: result.rows[0] });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/crm/saved-segments", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await pool.query(`
        SELECT id, name, filters, created_by, created_at, updated_at
        FROM dr_crm_saved_segments
        ORDER BY LOWER(name), id
      `);

      res.json({ ok: true, segments: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.post("/api/crm/saved-segments", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const name = String(req.body.name || "").trim().slice(0, 80);
    const filters =
      req.body.filters &&
      typeof req.body.filters === "object" &&
      !Array.isArray(req.body.filters)
        ? req.body.filters
        : null;

    if (!name || !filters) {
      return res.status(400).json({ ok: false, error: "nome e filtros sao obrigatorios" });
    }

    const allowedKeys = new Set([
      "search",
      "temperature",
      "lifecycle_stage",
      "utm_source",
      "utm_campaign",
      "segment",
      "sort"
    ]);

    const sanitized = {};
    for (const [key, value] of Object.entries(filters)) {
      if (allowedKeys.has(key) && value != null && String(value).trim() !== "") {
        sanitized[key] = String(value).trim().slice(0, 250);
      }
    }

    try {
      const result = await pool.query(`
        INSERT INTO dr_crm_saved_segments (name, filters, created_by)
        VALUES ($1, $2::jsonb, 'admin:crm')
        ON CONFLICT (LOWER(name))
        DO UPDATE SET
          filters = EXCLUDED.filters,
          updated_at = NOW()
        RETURNING id, name, filters, created_at, updated_at
      `, [name, JSON.stringify(sanitized)]);

      res.status(201).json({ ok: true, segment: result.rows[0] });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.delete("/api/crm/saved-segments/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const segmentId = Number(req.params.id);
    if (!Number.isInteger(segmentId) || segmentId <= 0) {
      return res.status(400).json({ ok: false, error: "segmento invalido" });
    }

    try {
      const result = await pool.query(`
        DELETE FROM dr_crm_saved_segments
        WHERE id = $1
        RETURNING id
      `, [segmentId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "segmento nao encontrado" });
      }

      res.json({ ok: true, deleted: segmentId });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/admin/experiments", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await pool.query(`
        SELECT
          x.id,
          x.slug,
          x.name,
          x.active,
          x.created_at,
          x.updated_at,
          COALESCE(
            json_agg(
              json_build_object(
                'id', v.id,
                'name', v.name,
                'destination_url', v.destination_url,
                'weight', v.weight,
                'active', v.active
              )
              ORDER BY v.id
            ) FILTER (WHERE v.id IS NOT NULL),
            '[]'::json
          ) AS variants
        FROM dr_experiments x
        LEFT JOIN dr_experiment_variants v
          ON v.experiment_id = x.id
        GROUP BY x.id
        ORDER BY x.created_at DESC, x.id DESC
      `);

      return res.json({ ok: true, experiments: result.rows });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.put("/api/experiments/:slug", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const slug = String(req.params.slug || "").trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
      return res.status(400).json({ ok: false, error: "slug invalido" });
    }

    let config;

    try {
      config = normalizeExperimentConfig(req.body || {});
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        ok: false,
        error: error.message
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const experimentResult = await client.query(`
        INSERT INTO dr_experiments (slug, name, active, updated_at)
        VALUES ($1,$2,$3,NOW())
        ON CONFLICT (slug)
        DO UPDATE SET
          name = EXCLUDED.name,
          active = EXCLUDED.active,
          updated_at = NOW()
        RETURNING id, slug, name, active
      `, [slug, config.name, config.active]);

      const experiment = experimentResult.rows[0];

      for (const variant of config.variants) {
        await client.query(`
          INSERT INTO dr_experiment_variants (
            experiment_id,
            name,
            destination_url,
            weight,
            active,
            updated_at
          )
          VALUES ($1,$2,$3,$4,$5,NOW())
          ON CONFLICT (experiment_id, name)
          DO UPDATE SET
            destination_url = EXCLUDED.destination_url,
            weight = EXCLUDED.weight,
            active = EXCLUDED.active,
            updated_at = NOW()
        `, [
          experiment.id,
          variant.name,
          variant.destination_url,
          variant.weight,
          variant.active
        ]);
      }

      const keepNames = config.variants.map((variant) => variant.name);

      await client.query(`
        UPDATE dr_experiment_variants
        SET active = FALSE,
            weight = 0,
            updated_at = NOW()
        WHERE experiment_id = $1
          AND NOT (name = ANY($2::text[]))
      `, [experiment.id, keepNames]);

      const variantsResult = await client.query(`
        SELECT id, name, destination_url, weight, active
        FROM dr_experiment_variants
        WHERE experiment_id = $1
        ORDER BY id
      `, [experiment.id]);

      await client.query("COMMIT");

      return res.json({
        ok: true,
        experiment: {
          ...experiment,
          variants: variantsResult.rows
        }
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, error: "erro interno" });
    } finally {
      client.release();
    }
  });

  app.get("/api/experiments", async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          x.id,
          x.slug,
          x.name,
          x.active,
          x.created_at,
          x.updated_at,
          COALESCE(
            json_agg(
              json_build_object(
                'id', v.id,
                'name', v.name,
                'weight', v.weight,
                'active', v.active
              )
              ORDER BY v.id
            ) FILTER (WHERE v.id IS NOT NULL),
            '[]'::json
          ) AS variants
        FROM dr_experiments x
        LEFT JOIN dr_experiment_variants v
          ON v.experiment_id = x.id
        GROUP BY x.id
        ORDER BY x.created_at DESC, x.id DESC
      `);

      res.json({ ok: true, experiments: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.patch("/api/experiments/:slug/weights", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const slug = String(req.params.slug || "").trim().toLowerCase();
    let updates;

    try {
      updates = normalizeWeightUpdates(req.body?.weights);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        ok: false,
        error: error.message
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const experimentResult = await client.query(`
        SELECT id, slug, name
        FROM dr_experiments
        WHERE slug = $1
        FOR UPDATE
      `, [slug]);

      const experiment = experimentResult.rows[0];

      if (!experiment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "router nao encontrado" });
      }

      for (const update of updates) {
        const result = await client.query(`
          UPDATE dr_experiment_variants
          SET weight = $1,
              updated_at = NOW()
          WHERE experiment_id = $2
            AND name = $3
          RETURNING id
        `, [update.weight, experiment.id, update.name]);

        if (result.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            error: "variante nao encontrada: " + update.name
          });
        }
      }

      const activeResult = await client.query(`
        SELECT id, name, weight, active
        FROM dr_experiment_variants
        WHERE experiment_id = $1
        ORDER BY id
      `, [experiment.id]);

      const totalActiveWeight = activeResult.rows.reduce(
        (sum, variant) =>
          sum + (variant.active ? Number(variant.weight || 0) : 0),
        0
      );

      if (!(totalActiveWeight > 0)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "o router precisa manter pelo menos uma variante com peso maior que zero"
        });
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        experiment: experiment.slug,
        variants: activeResult.rows
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, error: "erro interno" });
    } finally {
      client.release();
    }
  });

  app.get("/api/experiments/:slug/performance", async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      // Periodo = data em que o clique foi distribuido (dia de Sao Paulo). Compras, mentoria e reembolsos desses
      // cliques contam mesmo quando acontecem depois do periodo.
      const { from, to } = parseReportRange(req.query);
      const result = await pool.query(`
        WITH lead_by_click AS (
          SELECT click_id, COUNT(*)::int AS leads
          FROM dr_leads
          WHERE click_id IS NOT NULL
          GROUP BY click_id
        ),
        event_by_click AS (
          SELECT click_id,
            COUNT(*) FILTER (WHERE event_name = 'purchase')::int AS front_purchases,
            COALESCE(SUM(value) FILTER (WHERE event_name = 'purchase'),0)::numeric AS front_revenue,
            COUNT(*) FILTER (WHERE event_name = 'call_booked')::int AS calls_booked,
            COUNT(*) FILTER (WHERE event_name = 'call_attended')::int AS calls_attended,
            COUNT(*) FILTER (WHERE event_name = 'mentorship_purchase')::int AS mentorship_purchases,
            COALESCE(SUM(value) FILTER (WHERE event_name = 'mentorship_purchase'),0)::numeric AS mentorship_revenue,
            COALESCE(SUM(value) FILTER (WHERE event_name = 'order_bump_purchase'),0)::numeric AS bump_revenue,
            COALESCE(SUM(ABS(value)) FILTER (WHERE event_name = 'refund'),0)::numeric AS refunds
          FROM dr_events
          WHERE click_id IS NOT NULL
          GROUP BY click_id
        )
        SELECT v.id AS variant_id, v.name AS variant, v.weight, v.active,
          COUNT(a.id)::int AS assigned_clicks,
          COUNT(a.id) FILTER (WHERE e.front_purchases > 0)::int AS buyers,
          COALESCE(SUM(l.leads),0)::int AS leads,
          COALESCE(SUM(e.front_purchases),0)::int AS front_purchases,
          COALESCE(SUM(e.calls_booked),0)::int AS calls_booked,
          COALESCE(SUM(e.calls_attended),0)::int AS calls_attended,
          COALESCE(SUM(e.mentorship_purchases),0)::int AS mentorship_purchases,
          COALESCE(SUM(e.front_revenue),0)::numeric AS front_revenue,
          COALESCE(SUM(e.mentorship_revenue),0)::numeric AS mentorship_revenue,
          COALESCE(SUM(e.bump_revenue),0)::numeric AS bump_revenue,
          COALESCE(SUM(e.refunds),0)::numeric AS refunds,
          (COALESCE(SUM(e.front_revenue),0)+COALESCE(SUM(e.mentorship_revenue),0)+COALESCE(SUM(e.bump_revenue),0)-COALESCE(SUM(e.refunds),0))::numeric AS net_revenue
        FROM dr_experiments x
        JOIN dr_experiment_variants v ON v.experiment_id = x.id
        LEFT JOIN dr_experiment_assignments a ON a.variant_id = v.id
          AND ($2::date IS NULL OR ((a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date)
          AND ($3::date IS NULL OR ((a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date)
        LEFT JOIN lead_by_click l ON l.click_id = a.click_id
        LEFT JOIN event_by_click e ON e.click_id = a.click_id
        WHERE x.slug = $1
        GROUP BY v.id, v.name, v.weight, v.active
        ORDER BY v.id
      `, [slug, from, to]);

      res.json({ ok: true, experiment: slug, range: { from, to }, variants: result.rows });
    } catch (error) {
      const statusCode = error.statusCode === 400 ? 400 : 500;
      res.status(statusCode).json({ ok: false, error: statusCode === 400 ? error.message : "erro interno" });
    }
  });

  app.get("/api/revenue/ltv", async (req, res) => {
    try {
      const { from, to } = parseReportRange(req.query);
      const result = await pool.query(`
        WITH cohort_purchases AS (
          SELECT event_id, click_id, value
          FROM dr_events
          WHERE event_name = 'purchase'
            AND ($1::date IS NULL OR (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date))
            AND ($2::date IS NULL OR (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date))
        ),
        cohort_clicks AS (
          SELECT DISTINCT click_id
          FROM cohort_purchases
          WHERE click_id IS NOT NULL
        ),
        front AS (
          SELECT
            COUNT(DISTINCT COALESCE(click_id, 'event:' || event_id))::int AS front_purchases,
            COALESCE(SUM(value),0)::numeric AS front_revenue
          FROM cohort_purchases
        ),
        downstream AS (
          SELECT
            COUNT(DISTINCT e.click_id) FILTER (WHERE e.event_name = 'mentorship_purchase')::int AS mentorship_purchases,
            COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'mentorship_purchase'),0)::numeric AS mentorship_revenue,
            COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'order_bump_purchase'),0)::numeric AS bump_revenue,
            COALESCE(SUM(ABS(e.value)) FILTER (WHERE e.event_name = 'refund'),0)::numeric AS refunds,
            COUNT(*) FILTER (WHERE e.event_name = 'call_booked')::int AS calls_booked,
            COUNT(*) FILTER (WHERE e.event_name = 'call_attended')::int AS calls_attended
          FROM dr_events e
          JOIN cohort_clicks c ON c.click_id = e.click_id
        ),
        agg AS (
          SELECT
            f.front_purchases,
            f.front_revenue,
            d.mentorship_purchases,
            d.mentorship_revenue,
            d.bump_revenue,
            d.refunds,
            d.calls_booked,
            d.calls_attended
          FROM front f
          CROSS JOIN downstream d
        )
        SELECT *,
          (front_revenue + mentorship_revenue + bump_revenue - refunds)::numeric AS net_revenue,
          CASE WHEN front_purchases > 0
            THEN ROUND((front_revenue + mentorship_revenue + bump_revenue - refunds) / front_purchases, 2)
            ELSE NULL END AS ltv_per_front_buyer,
          CASE WHEN front_purchases > 0
            THEN ROUND((mentorship_purchases::numeric / front_purchases) * 100, 2)
            ELSE NULL END AS mentorship_attach_rate_pct,
          CASE WHEN calls_booked > 0
            THEN ROUND((calls_attended::numeric / calls_booked) * 100, 2)
            ELSE NULL END AS call_show_rate_pct
        FROM agg
      `, [from, to]);

      res.json({ ok: true, range: { from, to }, ltv: result.rows[0] });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        ok: false,
        error: statusCode === 400 ? error.message : "erro interno"
      });
    }
  });
  return { router };
}

module.exports = {
  initOfferDb,
  registerOfferRoutes,
  syncLeadCrmFromEvent,
  deriveCrmState,
  normalizeExperimentConfig,
  normalizeWeightUpdates,
  LIFECYCLE_STAGES,
  TEMPERATURES
};

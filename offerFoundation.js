const crypto = require("crypto");
const {
  parseCookies,
  selectWeightedVariant,
  buildRedirectUrl,
  resolveRouterIdentity,
  routingTrackingParams
} = require("./routing");

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
}

async function findLeadForEvent(client, payload = {}) {
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
  `, [clickId, email, phone]);

  return result.rows[0] || null;
}

async function syncLeadCrmFromEvent(pool, payload = {}) {
  const mapping = EVENT_CRM_MAP[payload.event_name];
  if (!mapping) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lead = await findLeadForEvent(client, payload);
    if (!lead) {
      await client.query("COMMIT");
      return null;
    }

    const currentStage = lead.lifecycle_stage || "lead";
    const currentTemp = lead.temperature || "cold";
    const nextState = deriveCrmState(currentStage, currentTemp, payload.event_name);
    const nextStage = nextState.lifecycle_stage;
    const nextTemp = nextState.temperature;

    if (nextStage === currentStage && nextTemp === currentTemp) {
      await client.query("COMMIT");
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

    await client.query("COMMIT");
    return updated.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function registerOfferRoutes({ app, pool, hashIp, parseReportRange }) {
  app.get("/go/:slug", async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      if (!slug) {
        return res.status(400).json({ ok: false, error: "slug obrigatorio" });
      }

      const cookies = parseCookies(req.headers.cookie || "");
      const { clickId, visitorKey } = resolveRouterIdentity(req.query, cookies);
      const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
      const secure = req.secure || forwardedProto === "https";

      res.append("Set-Cookie", cookieHeader("dr_click_id", clickId, secure));
      res.append("Set-Cookie", cookieHeader("dr_visitor_id", visitorKey, secure));

      const experimentResult = await pool.query(`
        SELECT id, slug, name
        FROM dr_experiments
        WHERE slug = $1 AND active = TRUE
        LIMIT 1
      `, [slug]);

      const experiment = experimentResult.rows[0];
      if (!experiment) {
        return res.status(404).json({ ok: false, error: "experimento nao encontrado" });
      }
      const variantsResult = await pool.query(`
        SELECT id, name, destination_url, weight, active
        FROM dr_experiment_variants
        WHERE experiment_id = $1
          AND active = TRUE
          AND weight > 0
        ORDER BY id ASC
      `, [experiment.id]);

      if (variantsResult.rows.length === 0) {
        return res.status(503).json({
          ok: false,
          error: "experimento sem variantes ativas"
        });
      }

      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "";
      const pageUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

      await pool.query(`
        INSERT INTO dr_clicks (
          click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          campaign_id, adset_id, ad_id, page_url, referrer, user_agent, ip_hash
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (click_id) DO NOTHING
      `, [
        clickId,
        req.query.utm_source || null,
        req.query.utm_medium || null,
        req.query.utm_campaign || null,
        req.query.utm_content || null,
        req.query.utm_term || null,
        req.query.campaign_id || null,
        req.query.adset_id || null,
        req.query.ad_id || null,
        pageUrl,
        req.get("referer") || null,
        req.get("user-agent") || null,
        hashIp(ip)
      ]);

      await pool.query(`
        UPDATE dr_clicks
        SET utm_source = COALESCE($2, utm_source),
            utm_medium = COALESCE($3, utm_medium),
            utm_campaign = COALESCE($4, utm_campaign),
            utm_content = COALESCE($5, utm_content),
            utm_term = COALESCE($6, utm_term),
            campaign_id = COALESCE($7, campaign_id),
            adset_id = COALESCE($8, adset_id),
            ad_id = COALESCE($9, ad_id),
            page_url = COALESCE($10, page_url),
            referrer = COALESCE($11, referrer),
            user_agent = COALESCE($12, user_agent),
            ip_hash = COALESCE($13, ip_hash)
        WHERE click_id = $1
      `, [
        clickId,
        req.query.utm_source || null,
        req.query.utm_medium || null,
        req.query.utm_campaign || null,
        req.query.utm_content || null,
        req.query.utm_term || null,
        req.query.campaign_id || null,
        req.query.adset_id || null,
        req.query.ad_id || null,
        pageUrl,
        req.get("referer") || null,
        req.get("user-agent") || null,
        hashIp(ip)
      ]);

      await pool.query(`
        UPDATE dr_clicks
        SET fbclid = COALESCE($2, fbclid),
            gclid = COALESCE($3, gclid)
        WHERE click_id = $1
      `, [
        clickId,
        req.query.fbclid || null,
        req.query.gclid || null
      ]);

      const assignmentResult = await pool.query(`
        SELECT a.variant_id, v.id, v.name, v.destination_url, v.weight, v.active
        FROM dr_experiment_assignments a
        JOIN dr_experiment_variants v ON v.id = a.variant_id
        WHERE a.experiment_id = $1
          AND (a.click_id = $2 OR a.session_key = $3)
        ORDER BY
          CASE WHEN a.click_id = $2 THEN 0 ELSE 1 END,
          a.updated_at DESC,
          a.id DESC
        LIMIT 1
      `, [experiment.id, clickId, visitorKey]);

      let variant = assignmentResult.rows[0] || null;

      if (
        !variant ||
        variant.active !== true ||
        !(Number(variant.weight) > 0)
      ) {
        variant = selectWeightedVariant(variantsResult.rows, visitorKey);
        if (!variant) {
          return res.status(503).json({ ok: false, error: "nenhuma variante elegivel" });
        }
      }

      await pool.query(`
        INSERT INTO dr_experiment_assignments (
          experiment_id, variant_id, click_id, session_key
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (experiment_id, click_id)
        DO UPDATE SET
          variant_id = EXCLUDED.variant_id,
          session_key = EXCLUDED.session_key,
          updated_at = NOW()
      `, [experiment.id, variant.id, clickId, visitorKey]);

      const redirectUrl = buildRedirectUrl(
        variant.destination_url,
        routingTrackingParams(
          req.query,
          clickId,
          experiment.slug,
          variant.name
        )
      );

      return res.redirect(302, redirectUrl);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({
        ok: false,
        error: statusCode < 500 ? error.message : "erro interno"
      });
    }
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

  app.get("/api/crm/leads", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const conditions = [];
      const values = [];
      const add = (sql, value) => {
        values.push(value);
        conditions.push(sql.replace("?", "$" + values.length));
      };

      if (req.query.lifecycle_stage) add("lifecycle_stage = ?", String(req.query.lifecycle_stage));
      if (req.query.temperature) add("temperature = ?", String(req.query.temperature));
      if (req.query.search) {
        const search = "%" + String(req.query.search).trim().toLowerCase() + "%";
        values.push(search);
        conditions.push(
          "(LOWER(COALESCE(nome,'')) LIKE $" + values.length +
          " OR LOWER(COALESCE(email,'')) LIKE $" + values.length +
          " OR regexp_replace(COALESCE(telefone,''), '[^0-9]', '', 'g') LIKE regexp_replace($" + values.length + ", '[^0-9]', '', 'g'))"
        );
      }

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      values.push(limit, offset);
      const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

      const result = await pool.query(`
        SELECT id, click_id, nome, email, telefone, status,
               lifecycle_stage, temperature, lead_score,
               utm_source, utm_medium, utm_campaign, utm_content,
               created_at, updated_at, crm_updated_at
        FROM dr_leads
        ${where}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}
      `, values);

      res.json({ ok: true, leads: result.rows, limit, offset });
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
        return res.status(404).json({ ok: false, error: "experimento nao encontrado" });
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
          error: "o experimento precisa manter pelo menos uma variante com peso maior que zero"
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
        SELECT v.id AS variant_id, v.name AS variant,
          COUNT(a.id)::int AS assigned_clicks,
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
        LEFT JOIN lead_by_click l ON l.click_id = a.click_id
        LEFT JOIN event_by_click e ON e.click_id = a.click_id
        WHERE x.slug = $1
        GROUP BY v.id, v.name
        ORDER BY v.id
      `, [slug]);

      res.json({ ok: true, experiment: slug, variants: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
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
}

module.exports = {
  initOfferDb,
  registerOfferRoutes,
  syncLeadCrmFromEvent,
  deriveCrmState,
  normalizeWeightUpdates,
  LIFECYCLE_STAGES,
  TEMPERATURES
};

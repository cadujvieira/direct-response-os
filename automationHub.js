const crypto = require("crypto");

const LIFECYCLE_STAGES = [
  "lead",
  "checkout",
  "customer",
  "call_booked",
  "mentorship_opportunity",
  "mentorship_customer",
  "refunded"
];

const AUTOMATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "cancelled"
];

const FOLLOWUP_PRIORITIES = ["low", "normal", "high", "urgent"];
const ACTION_TYPES = ["create_followup"];
const MAX_DELAY_MINUTES = 43200;
const MAX_TEXT = 500;
const DEFAULT_WORKER_INTERVAL_MS = 15000;

const DEFAULT_RULES = [
  {
    key: "checkout_abandoned",
    name: "Recuperar checkout abandonado",
    description: "Cria follow-up quando o checkout foi iniciado e a compra não aconteceu dentro da janela configurada.",
    trigger_event: "checkout_started",
    delay_minutes: 60,
    conditions: {
      missing_events: ["purchase"],
      skip_lifecycle_stages: ["refunded", "mentorship_customer"]
    },
    action_type: "create_followup",
    action_config: {
      priority: "high",
      note: "Checkout iniciado sem compra. Fazer recuperação."
    },
    active: true,
    system_rule: true
  },
  {
    key: "frontend_without_call",
    name: "Comprador sem call",
    description: "Cria tarefa para comprador do front-end que ainda não agendou a call de análise.",
    trigger_event: "purchase",
    delay_minutes: 1440,
    conditions: {
      missing_events: ["call_booked"],
      skip_lifecycle_stages: ["refunded", "mentorship_customer"]
    },
    action_type: "create_followup",
    action_config: {
      priority: "high",
      note: "Comprou o produto de R$297 e ainda não agendou a call de análise."
    },
    active: true,
    system_rule: true
  },
  {
    key: "no_show_recovery",
    name: "Recuperar no-show",
    description: "Cria follow-up urgente depois de um no-show, desde que uma nova call ainda não tenha sido agendada.",
    trigger_event: "call_no_show",
    delay_minutes: 0,
    conditions: {
      missing_events: ["call_booked"],
      skip_lifecycle_stages: ["refunded", "mentorship_customer"]
    },
    action_type: "create_followup",
    action_config: {
      priority: "urgent",
      note: "No-show na call. Reagendar contato."
    },
    active: true,
    system_rule: true
  },
  {
    key: "post_call_without_mentorship",
    name: "Follow-up pos-call",
    description: "Cria tarefa comercial quando a call aconteceu e a mentoria ainda não foi comprada.",
    trigger_event: "call_attended",
    delay_minutes: 1440,
    conditions: {
      missing_events: ["mentorship_purchase"],
      skip_lifecycle_stages: ["refunded", "mentorship_customer"]
    },
    action_type: "create_followup",
    action_config: {
      priority: "high",
      note: "Call realizada sem compra de mentoria. Fazer follow-up comercial."
    },
    active: true,
    system_rule: true
  }
];

function normalizeText(value, max = MAX_TEXT) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function normalizeEventName(value, field = "trigger_event") {
  const normalized = normalizeText(value, 100);
  if (!normalized || !/^[a-zA-Z0-9_.:-]+$/.test(normalized)) {
    const error = new Error(field + " invalido");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeStringArray(value, field, validator = null) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    const error = new Error(field + " deve ser uma lista");
    error.statusCode = 400;
    throw error;
  }

  const output = [];
  const seen = new Set();

  for (const raw of value) {
    const normalized = normalizeText(raw, 100);
    if (!normalized) continue;

    if (validator && !validator(normalized)) {
      const error = new Error(field + " contem valor invalido");
      error.statusCode = 400;
      throw error;
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }

  if (output.length > 25) {
    const error = new Error(field + " excede o limite");
    error.statusCode = 400;
    throw error;
  }

  return output;
}

function normalizeAutomationRule(input = {}, options = {}) {
  const creating = options.creating === true;
  const key = normalizeText(input.key, 80);

  if (creating && (!key || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(key))) {
    const error = new Error("key invalida");
    error.statusCode = 400;
    throw error;
  }

  const name = normalizeText(input.name, 120);
  if (!name) {
    const error = new Error("name obrigatorio");
    error.statusCode = 400;
    throw error;
  }

  const description = normalizeText(input.description, 500) || null;
  const triggerEvent = normalizeEventName(input.trigger_event);
  const delayMinutes = Number(input.delay_minutes == null ? 0 : input.delay_minutes);

  if (
    !Number.isInteger(delayMinutes) ||
    delayMinutes < 0 ||
    delayMinutes > MAX_DELAY_MINUTES
  ) {
    const error = new Error("delay_minutes deve estar entre 0 e 43200");
    error.statusCode = 400;
    throw error;
  }

  const rawConditions =
    input.conditions && typeof input.conditions === "object" && !Array.isArray(input.conditions)
      ? input.conditions
      : {};

  const missingEvents = normalizeStringArray(
    rawConditions.missing_events,
    "missing_events",
    (value) => /^[a-zA-Z0-9_.:-]+$/.test(value)
  );

  const skipStages = normalizeStringArray(
    rawConditions.skip_lifecycle_stages,
    "skip_lifecycle_stages",
    (value) => LIFECYCLE_STAGES.includes(value)
  );

  const actionType = normalizeText(input.action_type || "create_followup", 60);
  if (!ACTION_TYPES.includes(actionType)) {
    const error = new Error("action_type nao suportado");
    error.statusCode = 400;
    throw error;
  }

  const rawAction =
    input.action_config && typeof input.action_config === "object" && !Array.isArray(input.action_config)
      ? input.action_config
      : {};

  const priority = normalizeText(rawAction.priority || "normal", 20);
  if (!FOLLOWUP_PRIORITIES.includes(priority)) {
    const error = new Error("prioridade invalida");
    error.statusCode = 400;
    throw error;
  }

  const note = normalizeText(rawAction.note, 1000);
  if (!note) {
    const error = new Error("nota da acao obrigatoria");
    error.statusCode = 400;
    throw error;
  }

  return {
    ...(creating ? { key } : {}),
    name,
    description,
    trigger_event: triggerEvent,
    delay_minutes: delayMinutes,
    conditions: {
      missing_events: missingEvents,
      skip_lifecycle_stages: skipStages
    },
    action_type: actionType,
    action_config: {
      priority,
      note
    },
    active: input.active !== false
  };
}

function describeConditions(conditions = {}) {
  const parts = [];
  const missing = Array.isArray(conditions.missing_events)
    ? conditions.missing_events.filter(Boolean)
    : [];
  const skipped = Array.isArray(conditions.skip_lifecycle_stages)
    ? conditions.skip_lifecycle_stages.filter(Boolean)
    : [];

  if (missing.length) {
    parts.push("se nao houver: " + missing.join(", "));
  }
  if (skipped.length) {
    parts.push("ignora etapas: " + skipped.join(", "));
  }

  return parts.length ? parts.join(" | ") : "sem condicoes adicionais";
}

function secretMatches(expected, received) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const receivedBuffer = Buffer.from(String(received || ""));
  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length !== receivedBuffer.length
  ) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
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

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

function normalizePhone(value) {
  const normalized = String(value || "").replace(/[^0-9]/g, "");
  return normalized || null;
}

async function initAutomationDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_automation_rules (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_event TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0 AND delay_minutes <= 43200),
      conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
      action_type TEXT NOT NULL,
      action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      system_rule BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_automation_rules_trigger_idx
    ON dr_automation_rules (trigger_event, active)
    WHERE deleted_at IS NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_automation_runs (
      id BIGSERIAL PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES dr_automation_rules(id) ON DELETE RESTRICT,
      lead_id INTEGER NOT NULL REFERENCES dr_leads(id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL,
      source_event_name TEXT NOT NULL,
      source_event_at TIMESTAMPTZ NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result JSONB,
      error TEXT,
      started_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (rule_id, lead_id, source_event_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_automation_runs_queue_idx
    ON dr_automation_runs (status, scheduled_for ASC, id ASC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_automation_runs_lead_idx
    ON dr_automation_runs (lead_id, created_at DESC);
  `);

  await pool.query(`
    ALTER TABLE dr_crm_followups
      ADD COLUMN IF NOT EXISTS automation_run_id BIGINT;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dr_crm_followups_automation_run_idx
    ON dr_crm_followups (automation_run_id)
    WHERE automation_run_id IS NOT NULL;
  `);

  for (const rule of DEFAULT_RULES) {
    const normalized = normalizeAutomationRule(rule, { creating: true });
    await pool.query(`
      INSERT INTO dr_automation_rules (
        key, name, description, trigger_event, delay_minutes,
        conditions, action_type, action_config, active, system_rule
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,TRUE)
      ON CONFLICT (key) DO NOTHING
    `, [
      normalized.key,
      normalized.name,
      normalized.description,
      normalized.trigger_event,
      normalized.delay_minutes,
      JSON.stringify(normalized.conditions),
      normalized.action_type,
      JSON.stringify(normalized.action_config),
      normalized.active
    ]);
  }
}

async function resolveLeadForAutomation(pool, payload = {}) {
  if (payload.lead_id != null) {
    if (!Number.isInteger(payload.lead_id) || payload.lead_id < 1) {
      const error = new Error("lead_id interno invalido"); error.statusCode = 409; throw error;
    }
    return (await pool.query("SELECT * FROM dr_leads WHERE id = $1", [payload.lead_id])).rows[0] || null;
  }
  const clickId = normalizeText(payload.click_id, 200) || null;
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.telefone);

  const result = await pool.query(`
    SELECT
      id,
      click_id,
      nome,
      email,
      telefone,
      lifecycle_stage,
      temperature,
      lead_score
    FROM dr_leads
    WHERE
      ($1::text IS NOT NULL AND click_id = $1)
      OR ($2::text IS NOT NULL AND email IS NOT NULL AND LOWER(email) = $2)
      OR (
        $3::text IS NOT NULL
        AND telefone IS NOT NULL
        AND regexp_replace(telefone, '[^0-9]', '', 'g') = $3
      )
    ORDER BY
      CASE WHEN $1::text IS NOT NULL AND click_id = $1 THEN 0 ELSE 1 END,
      updated_at DESC,
      id DESC
    LIMIT 1
  `, [clickId, email, phone]);

  return result.rows[0] || null;
}

async function enqueueAutomationEvent(pool, payload = {}) {
  const eventId = normalizeText(payload.event_id, 200);
  const eventName = normalizeEventName(payload.event_name);
  const sourceAt = payload.created_at ? new Date(payload.created_at) : new Date();

  if (!eventId) {
    const error = new Error("event_id obrigatorio para automacao");
    error.statusCode = 400;
    throw error;
  }

  if (Number.isNaN(sourceAt.getTime())) {
    const error = new Error("created_at invalido");
    error.statusCode = 400;
    throw error;
  }

  const lead = await resolveLeadForAutomation(pool, payload);
  if (!lead) {
    return { ok: true, lead_found: false, queued: 0 };
  }

  const rulesResult = await pool.query(`
    SELECT
      id, key, delay_minutes
    FROM dr_automation_rules
    WHERE trigger_event = $1
      AND active = TRUE
      AND deleted_at IS NULL
    ORDER BY id
  `, [eventName]);

  let queued = 0;

  for (const rule of rulesResult.rows) {
    const scheduledFor = new Date(
      sourceAt.getTime() + Number(rule.delay_minutes || 0) * 60000
    );

    const inserted = await pool.query(`
      INSERT INTO dr_automation_runs (
        rule_id,
        lead_id,
        source_event_id,
        source_event_name,
        source_event_at,
        scheduled_for,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,'pending')
      ON CONFLICT (rule_id, lead_id, source_event_id) DO NOTHING
      RETURNING id
    `, [
      rule.id,
      lead.id,
      eventId,
      eventName,
      sourceAt.toISOString(),
      scheduledFor.toISOString()
    ]);

    queued += inserted.rows.length;
  }

  return {
    ok: true,
    lead_found: true,
    lead_id: lead.id,
    queued
  };
}

async function leadHasEventAfter(pool, lead, sourceEventAt, sourceEventId, eventNames) {
  if (!Array.isArray(eventNames) || eventNames.length === 0) {
    return false;
  }

  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM dr_events e
      WHERE e.event_name = ANY($1::text[])
        AND e.created_at >= $2::timestamptz
        AND e.event_id <> $3
        AND (
          ($4::text IS NOT NULL AND e.click_id = $4)
          OR (
            $5::text IS NOT NULL
            AND e.email IS NOT NULL
            AND LOWER(e.email) = LOWER($5)
          )
          OR (
            $6::text IS NOT NULL
            AND e.telefone IS NOT NULL
            AND regexp_replace(e.telefone, '[^0-9]', '', 'g') =
                regexp_replace($6, '[^0-9]', '', 'g')
          )
        )
    ) AS found
  `, [
    eventNames,
    sourceEventAt,
    sourceEventId,
    lead.click_id || null,
    lead.email || null,
    lead.telefone || null
  ]);

  return Boolean(result.rows[0]?.found);
}

async function markRun(pool, runId, status, result = null, error = null) {
  await pool.query(`
    UPDATE dr_automation_runs
    SET status = $1,
        result = $2::jsonb,
        error = $3,
        executed_at = NOW(),
        updated_at = NOW()
    WHERE id = $4
  `, [
    status,
    result == null ? null : JSON.stringify(result),
    error ? normalizeText(error, 500) : null,
    runId
  ]);
}

async function executeRun(pool, runId) {
  const result = await pool.query(`
    SELECT
      ar.id,
      ar.rule_id,
      ar.lead_id,
      ar.source_event_id,
      ar.source_event_name,
      ar.source_event_at,
      ar.scheduled_for,
      ar.status,
      r.key AS rule_key,
      r.name AS rule_name,
      r.active AS rule_active,
      r.deleted_at AS rule_deleted_at,
      r.conditions,
      r.action_type,
      r.action_config,
      l.click_id,
      l.nome,
      l.email,
      l.telefone,
      l.lifecycle_stage,
      l.temperature,
      l.lead_score
    FROM dr_automation_runs ar
    JOIN dr_automation_rules r ON r.id = ar.rule_id
    JOIN dr_leads l ON l.id = ar.lead_id
    WHERE ar.id = $1
    LIMIT 1
  `, [runId]);

  const run = result.rows[0];
  if (!run) return { status: "missing" };

  if (!run.rule_active || run.rule_deleted_at) {
    await markRun(pool, run.id, "skipped", { reason: "rule_disabled" });
    return { status: "skipped", reason: "rule_disabled" };
  }

  const conditions =
    run.conditions && typeof run.conditions === "object"
      ? run.conditions
      : {};

  const skipStages = Array.isArray(conditions.skip_lifecycle_stages)
    ? conditions.skip_lifecycle_stages
    : [];

  if (skipStages.includes(run.lifecycle_stage)) {
    await markRun(pool, run.id, "skipped", {
      reason: "lifecycle_stage",
      lifecycle_stage: run.lifecycle_stage
    });
    return { status: "skipped", reason: "lifecycle_stage" };
  }

  const missingEvents = Array.isArray(conditions.missing_events)
    ? conditions.missing_events
    : [];

  if (missingEvents.length) {
    const blocked = await leadHasEventAfter(
      pool,
      run,
      run.source_event_at,
      run.source_event_id,
      missingEvents
    );

    if (blocked) {
      await markRun(pool, run.id, "skipped", {
        reason: "blocking_event_found",
        blocking_events: missingEvents
      });
      return { status: "skipped", reason: "blocking_event_found" };
    }
  }

  if (run.action_type !== "create_followup") {
    await markRun(pool, run.id, "failed", null, "action_type nao suportado");
    return { status: "failed" };
  }

  const config =
    run.action_config && typeof run.action_config === "object"
      ? run.action_config
      : {};

  const priority = FOLLOWUP_PRIORITIES.includes(config.priority)
    ? config.priority
    : "normal";
  const note = normalizeText(config.note, 1000);

  const inserted = await pool.query(`
    INSERT INTO dr_crm_followups (
      lead_id,
      due_at,
      priority,
      status,
      note,
      created_by,
      automation_run_id
    )
    VALUES ($1,NOW(),$2,'pending',$3,$4,$5)
    ON CONFLICT (automation_run_id) WHERE automation_run_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `, [
    run.lead_id,
    priority,
    note,
    "automation:" + run.rule_key,
    run.id
  ]);

  let followupId = inserted.rows[0]?.id || null;

  if (!followupId) {
    const existing = await pool.query(`
      SELECT id
      FROM dr_crm_followups
      WHERE automation_run_id = $1
      LIMIT 1
    `, [run.id]);
    followupId = existing.rows[0]?.id || null;
  }

  await markRun(pool, run.id, "completed", {
    action: "create_followup",
    followup_id: followupId,
    priority
  });

  return {
    status: "completed",
    followup_id: followupId
  };
}

async function processAutomationQueue(pool, options = {}) {
  const requested = Number(options.batchSize || 25);
  const batchSize = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), 100)
    : 25;

  await pool.query(`
    UPDATE dr_automation_runs
    SET status = 'pending',
        started_at = NULL,
        updated_at = NOW(),
        error = NULL
    WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '10 minutes'
  `);

  const client = await pool.connect();
  let claimed = [];

  try {
    await client.query("BEGIN");

    const claimResult = await client.query(`
      SELECT id
      FROM dr_automation_runs
      WHERE status = 'pending'
        AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    `, [batchSize]);

    const ids = claimResult.rows.map((row) => Number(row.id));

    if (ids.length) {
      const updated = await client.query(`
        UPDATE dr_automation_runs
        SET status = 'running',
            started_at = NOW(),
            updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING id
      `, [ids]);
      claimed = updated.rows.map((row) => Number(row.id));
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const summary = {
    claimed: claimed.length,
    completed: 0,
    skipped: 0,
    failed: 0
  };

  for (const runId of claimed) {
    try {
      const outcome = await executeRun(pool, runId);
      if (outcome.status === "completed") summary.completed += 1;
      else if (outcome.status === "skipped") summary.skipped += 1;
      else if (outcome.status === "failed") summary.failed += 1;
    } catch (error) {
      summary.failed += 1;
      try {
        await markRun(
          pool,
          runId,
          "failed",
          null,
          "falha interna ao executar automacao"
        );
      } catch {
        // Best effort only. A stale running row is recovered by the next worker tick.
      }
    }
  }

  return summary;
}

function startAutomationWorker(pool, options = {}) {
  const intervalMs = Number(options.intervalMs || DEFAULT_WORKER_INTERVAL_MS);
  const safeInterval =
    Number.isFinite(intervalMs) && intervalMs >= 1000
      ? Math.floor(intervalMs)
      : DEFAULT_WORKER_INTERVAL_MS;

  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;

    try {
      await processAutomationQueue(pool);
    } catch (error) {
      console.error("Automation worker tick failed");
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(tick, 1000);
  if (typeof initialTimer.unref === "function") initialTimer.unref();

  const timer = setInterval(tick, safeInterval);
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}

function registerAutomationRoutes(app, pool) {
  app.get("/api/automations/summary", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int
           FROM dr_automation_rules
           WHERE active = TRUE AND deleted_at IS NULL) AS active_rules,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (
            WHERE status = 'pending' AND scheduled_for <= NOW()
          )::int AS overdue,
          COUNT(*) FILTER (
            WHERE status = 'completed'
              AND executed_at >= NOW() - INTERVAL '24 hours'
          )::int AS completed_24h,
          COUNT(*) FILTER (
            WHERE status = 'skipped'
              AND executed_at >= NOW() - INTERVAL '24 hours'
          )::int AS skipped_24h,
          COUNT(*) FILTER (
            WHERE status = 'failed'
              AND executed_at >= NOW() - INTERVAL '24 hours'
          )::int AS failed_24h
        FROM dr_automation_runs
      `);

      res.json({ ok: true, summary: result.rows[0] });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/automations/rules", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await pool.query(`
        SELECT
          id, key, name, description, trigger_event, delay_minutes,
          conditions, action_type, action_config, active, system_rule,
          created_at, updated_at
        FROM dr_automation_rules
        WHERE deleted_at IS NULL
        ORDER BY system_rule DESC, id ASC
      `);

      res.json({ ok: true, rules: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.post("/api/automations/rules", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    let normalized;
    try {
      normalized = normalizeAutomationRule(req.body || {}, { creating: true });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        ok: false,
        error: error.message
      });
    }

    try {
      const result = await pool.query(`
        INSERT INTO dr_automation_rules (
          key, name, description, trigger_event, delay_minutes,
          conditions, action_type, action_config, active, system_rule
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,FALSE)
        RETURNING
          id, key, name, description, trigger_event, delay_minutes,
          conditions, action_type, action_config, active, system_rule,
          created_at, updated_at
      `, [
        normalized.key,
        normalized.name,
        normalized.description,
        normalized.trigger_event,
        normalized.delay_minutes,
        JSON.stringify(normalized.conditions),
        normalized.action_type,
        JSON.stringify(normalized.action_config),
        normalized.active
      ]);

      res.status(201).json({ ok: true, rule: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ ok: false, error: "key ja cadastrada" });
      }
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.patch("/api/automations/rules/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const ruleId = Number(req.params.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ ok: false, error: "regra invalida" });
    }

    try {
      const currentResult = await pool.query(`
        SELECT *
        FROM dr_automation_rules
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1
      `, [ruleId]);

      const current = currentResult.rows[0];
      if (!current) {
        return res.status(404).json({ ok: false, error: "regra nao encontrada" });
      }

      const merged = {
        name: req.body.name ?? current.name,
        description: req.body.description ?? current.description,
        trigger_event: req.body.trigger_event ?? current.trigger_event,
        delay_minutes: req.body.delay_minutes ?? current.delay_minutes,
        conditions: req.body.conditions ?? current.conditions,
        action_type: req.body.action_type ?? current.action_type,
        action_config: req.body.action_config ?? current.action_config,
        active: req.body.active ?? current.active
      };

      let normalized;
      try {
        normalized = normalizeAutomationRule(merged);
      } catch (error) {
        return res.status(error.statusCode || 400).json({
          ok: false,
          error: error.message
        });
      }

      const updated = await pool.query(`
        UPDATE dr_automation_rules
        SET name = $1,
            description = $2,
            trigger_event = $3,
            delay_minutes = $4,
            conditions = $5::jsonb,
            action_type = $6,
            action_config = $7::jsonb,
            active = $8,
            updated_at = NOW()
        WHERE id = $9
        RETURNING
          id, key, name, description, trigger_event, delay_minutes,
          conditions, action_type, action_config, active, system_rule,
          created_at, updated_at
      `, [
        normalized.name,
        normalized.description,
        normalized.trigger_event,
        normalized.delay_minutes,
        JSON.stringify(normalized.conditions),
        normalized.action_type,
        JSON.stringify(normalized.action_config),
        normalized.active,
        ruleId
      ]);

      res.json({ ok: true, rule: updated.rows[0] });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.delete("/api/automations/rules/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const ruleId = Number(req.params.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ ok: false, error: "regra invalida" });
    }

    try {
      const result = await pool.query(`
        UPDATE dr_automation_rules
        SET active = FALSE,
            deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND system_rule = FALSE
          AND deleted_at IS NULL
        RETURNING id
      `, [ruleId]);

      if (!result.rows.length) {
        const existing = await pool.query(`
          SELECT system_rule
          FROM dr_automation_rules
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1
        `, [ruleId]);

        if (existing.rows[0]?.system_rule) {
          return res.status(400).json({
            ok: false,
            error: "regra do sistema pode ser desativada, mas nao excluida"
          });
        }

        return res.status(404).json({
          ok: false,
          error: "regra nao encontrada"
        });
      }

      await pool.query(`
        UPDATE dr_automation_runs
        SET status = 'cancelled',
            executed_at = NOW(),
            updated_at = NOW(),
            result = '{"reason":"rule_deleted"}'::jsonb
        WHERE rule_id = $1
          AND status = 'pending'
      `, [ruleId]);

      res.json({ ok: true, deleted: ruleId });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/automations/runs", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const status = normalizeText(req.query.status, 30);
    if (status && !AUTOMATION_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, error: "status invalido" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const values = [];
    const conditions = [];

    if (status) {
      values.push(status);
      conditions.push("ar.status = $" + values.length);
    }

    values.push(limit);
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    try {
      const result = await pool.query(`
        SELECT
          ar.id,
          ar.lead_id,
          ar.source_event_id,
          ar.source_event_name,
          ar.source_event_at,
          ar.scheduled_for,
          ar.status,
          ar.result,
          CASE WHEN ar.error IS NULL THEN NULL ELSE 'falha interna' END AS error,
          ar.started_at,
          ar.executed_at,
          ar.created_at,
          r.id AS rule_id,
          r.key AS rule_key,
          r.name AS rule_name,
          l.nome,
          l.email,
          l.telefone,
          l.lifecycle_stage,
          l.temperature
        FROM dr_automation_runs ar
        JOIN dr_automation_rules r ON r.id = ar.rule_id
        JOIN dr_leads l ON l.id = ar.lead_id
        ${where}
        ORDER BY ar.created_at DESC, ar.id DESC
        LIMIT $${values.length}
      `, values);

      res.json({ ok: true, runs: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.post("/api/automations/process", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const summary = await processAutomationQueue(pool, { batchSize: 50 });
      res.json({ ok: true, summary });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });
}

module.exports = {
  ACTION_TYPES,
  AUTOMATION_STATUSES,
  DEFAULT_RULES,
  FOLLOWUP_PRIORITIES,
  LIFECYCLE_STAGES,
  MAX_DELAY_MINUTES,
  describeConditions,
  enqueueAutomationEvent,
  initAutomationDb,
  normalizeAutomationRule,
  processAutomationQueue,
  registerAutomationRoutes,
  startAutomationWorker
};

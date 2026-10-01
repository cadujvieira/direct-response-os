const crypto = require("crypto");

const EXPORT_FORMATS = [
  "contacts",
  "phone",
  "email",
  "audience",
  "crm"
];

const EXCLUSION_WINDOWS = [0, 7, 30, 90, -1];
const MAX_EXPORT_LEADS = 5000;

function normalizeText(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
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

function normalizeLeadIds(value) {
  const ids = Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  ));

  if (ids.length === 0) {
    const error = new Error("selecione pelo menos um contato");
    error.statusCode = 400;
    throw error;
  }

  if (ids.length > MAX_EXPORT_LEADS) {
    const error = new Error("limite de 5000 contatos por lote");
    error.statusCode = 400;
    throw error;
  }

  return ids;
}

function normalizeExclusionDays(value) {
  const days = Number(value == null ? 0 : value);

  if (!Number.isInteger(days) || !EXCLUSION_WINDOWS.includes(days)) {
    const error = new Error("janela de exclusao invalida");
    error.statusCode = 400;
    throw error;
  }

  return days;
}

function normalizeFormat(value) {
  const format = normalizeText(value, 30);

  if (!EXPORT_FORMATS.includes(format)) {
    const error = new Error("formato de exportacao invalido");
    error.statusCode = 400;
    throw error;
  }

  return format;
}

function normalizeFilters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const allowed = new Set([
    "search",
    "temperature",
    "lifecycle_stage",
    "utm_source",
    "utm_campaign",
    "segment",
    "sort",
    "_source_value",
    "_source_label",
    "_batch_size"
  ]);

  const output = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key) || raw == null) continue;

    if (key === "_batch_size") {
      const batchSize = Number(raw);
      if (Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 5000) {
        output[key] = batchSize;
      }
      continue;
    }

    const text = normalizeText(raw, key === "_source_label" ? 120 : 250);
    if (text) output[key] = text;
  }

  return output;
}

function normalizeExportInput(input = {}) {
  const name = normalizeText(input.name, 120);

  if (!name) {
    const error = new Error("nome do lote obrigatorio");
    error.statusCode = 400;
    throw error;
  }

  return {
    name,
    export_format: normalizeFormat(input.export_format),
    exclusion_days: normalizeExclusionDays(input.exclusion_days),
    lead_ids: normalizeLeadIds(input.lead_ids),
    filters: normalizeFilters(input.filters)
  };
}

function isEligibleContact(row, format) {
  const hasPhone = Boolean(
    String(row?.telefone || "").replace(/[^0-9]/g, "")
  );
  const hasEmail = Boolean(
    String(row?.email || "").trim()
  );

  if (format === "phone") return hasPhone;
  if (format === "email") return hasEmail;
  if (format === "crm") return true;

  return hasPhone || hasEmail;
}

function buildRecentExportCondition(exclusionDays, paramNumber) {
  if (exclusionDays === 0) return null;

  if (exclusionDays === -1) {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM dr_activation_export_leads previous
        WHERE previous.lead_id = candidate.id
      )`,
      value: null
    };
  }

  return {
    sql: `EXISTS (
      SELECT 1
      FROM dr_activation_export_leads previous
      WHERE previous.lead_id = candidate.id
        AND previous.created_at >= NOW() - ($${paramNumber}::int * INTERVAL '1 day')
    )`,
    value: exclusionDays
  };
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function formatPhoneE164Br(value) {
  const digits = normalizePhoneDigits(value);

  if (!digits) return "";
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return "+" + digits;
  }
  if (digits.length === 10 || digits.length === 11) {
    return "+55" + digits;
  }

  return digits;
}

async function initActivationDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_activation_exports (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      export_format TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      exclusion_days INTEGER NOT NULL DEFAULT 0,
      requested_count INTEGER NOT NULL DEFAULT 0,
      exported_count INTEGER NOT NULL DEFAULT 0,
      excluded_recent_count INTEGER NOT NULL DEFAULT 0,
      invalid_contact_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_activation_export_leads (
      export_id BIGINT NOT NULL REFERENCES dr_activation_exports(id) ON DELETE CASCADE,
      lead_id INTEGER NOT NULL REFERENCES dr_leads(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (export_id, lead_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_activation_export_leads_lead_idx
    ON dr_activation_export_leads (lead_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_activation_exports_created_idx
    ON dr_activation_exports (created_at DESC, id DESC);
  `);
}

async function activationEligibility(pool, leadIds, exclusionDays) {
  const ids = normalizeLeadIds(leadIds);
  const days = normalizeExclusionDays(exclusionDays);

  if (days === 0) {
    return {
      eligible_ids: ids,
      excluded_ids: [],
      last_exported_at: {}
    };
  }

  const values = [ids];
  let condition;

  if (days === -1) {
    condition = "TRUE";
  } else {
    values.push(days);
    condition = "ael.created_at >= NOW() - ($2::int * INTERVAL '1 day')";
  }

  const result = await pool.query(`
    SELECT
      ael.lead_id,
      MAX(ael.created_at) AS last_exported_at
    FROM dr_activation_export_leads ael
    WHERE ael.lead_id = ANY($1::int[])
      AND ${condition}
    GROUP BY ael.lead_id
  `, values);

  const excludedSet = new Set(
    result.rows.map((row) => Number(row.lead_id))
  );
  const lastExportedAt = {};

  for (const row of result.rows) {
    lastExportedAt[String(row.lead_id)] = row.last_exported_at;
  }

  return {
    eligible_ids: ids.filter((id) => !excludedSet.has(id)),
    excluded_ids: ids.filter((id) => excludedSet.has(id)),
    last_exported_at: lastExportedAt
  };
}

async function createActivationExport(pool, input) {
  const normalized = normalizeExportInput(input);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const candidateResult = await client.query(`
      SELECT
        id,
        nome,
        email,
        telefone
      FROM dr_leads
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR SHARE
    `, [normalized.lead_ids]);

    const existingById = new Map(
      candidateResult.rows.map((row) => [Number(row.id), row])
    );

    const existingIds = normalized.lead_ids.filter((id) => existingById.has(id));
    const invalidIds = [];
    const validIds = [];

    for (const id of existingIds) {
      const row = existingById.get(id);
      if (isEligibleContact(row, normalized.export_format)) validIds.push(id);
      else invalidIds.push(id);
    }

    let recentIds = [];

    if (normalized.exclusion_days !== 0 && validIds.length) {
      const values = [validIds];
      let timeCondition = "TRUE";

      if (normalized.exclusion_days !== -1) {
        values.push(normalized.exclusion_days);
        timeCondition =
          "ael.created_at >= NOW() - ($2::int * INTERVAL '1 day')";
      }

      const recentResult = await client.query(`
        SELECT DISTINCT ael.lead_id
        FROM dr_activation_export_leads ael
        WHERE ael.lead_id = ANY($1::int[])
          AND ${timeCondition}
      `, values);

      recentIds = recentResult.rows.map((row) => Number(row.lead_id));
    }

    const recentSet = new Set(recentIds);
    const finalIds = validIds.filter((id) => !recentSet.has(id));

    const exportResult = await client.query(`
      INSERT INTO dr_activation_exports (
        name,
        export_format,
        filters,
        exclusion_days,
        requested_count,
        exported_count,
        excluded_recent_count,
        invalid_contact_count,
        created_by
      )
      VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,'admin:lists')
      RETURNING *
    `, [
      normalized.name,
      normalized.export_format,
      JSON.stringify(normalized.filters),
      normalized.exclusion_days,
      normalized.lead_ids.length,
      finalIds.length,
      recentIds.length,
      invalidIds.length
    ]);

    const exportRow = exportResult.rows[0];

    if (finalIds.length) {
      await client.query(`
        INSERT INTO dr_activation_export_leads (export_id, lead_id)
        SELECT $1, unnest($2::int[])
        ON CONFLICT (export_id, lead_id) DO NOTHING
      `, [exportRow.id, finalIds]);
    }

    await client.query("COMMIT");

    return {
      export: exportRow,
      exported_lead_ids: finalIds,
      excluded_recent_ids: recentIds,
      invalid_contact_ids: invalidIds,
      missing_lead_ids: normalized.lead_ids.filter((id) => !existingById.has(id))
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function registerActivationRoutes(app, pool) {
  app.post("/api/activation/eligibility", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await activationEligibility(
        pool,
        req.body?.lead_ids,
        req.body?.exclusion_days
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        ok: false,
        error: statusCode === 500 ? "erro interno" : error.message
      });
    }
  });

  app.post("/api/activation/exports", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await createActivationExport(pool, req.body || {});
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({
        ok: false,
        error: statusCode === 500 ? "erro interno" : error.message
      });
    }
  });

  app.get("/api/activation/exports", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);

    try {
      const result = await pool.query(`
        SELECT
          id,
          name,
          export_format,
          filters,
          exclusion_days,
          requested_count,
          exported_count,
          excluded_recent_count,
          invalid_contact_count,
          created_by,
          created_at
        FROM dr_activation_exports
        ORDER BY created_at DESC, id DESC
        LIMIT $1
      `, [limit]);

      res.json({ ok: true, exports: result.rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.get("/api/activation/exports/:id/lead-ids", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const exportId = Number(req.params.id);

    if (!Number.isInteger(exportId) || exportId <= 0) {
      return res.status(400).json({ ok: false, error: "lote invalido" });
    }

    try {
      const exportResult = await pool.query(`
        SELECT
          id,
          name,
          export_format,
          filters,
          exclusion_days,
          requested_count,
          exported_count,
          excluded_recent_count,
          invalid_contact_count,
          created_at
        FROM dr_activation_exports
        WHERE id = $1
        LIMIT 1
      `, [exportId]);

      if (!exportResult.rows.length) {
        return res.status(404).json({ ok: false, error: "lote nao encontrado" });
      }

      const leadsResult = await pool.query(`
        SELECT lead_id
        FROM dr_activation_export_leads
        WHERE export_id = $1
        ORDER BY lead_id
      `, [exportId]);

      res.json({
        ok: true,
        export: exportResult.rows[0],
        lead_ids: leadsResult.rows.map((row) => Number(row.lead_id))
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });
}

module.exports = {
  EXPORT_FORMATS,
  EXCLUSION_WINDOWS,
  MAX_EXPORT_LEADS,
  activationEligibility,
  createActivationExport,
  formatPhoneE164Br,
  initActivationDb,
  isEligibleContact,
  normalizeExportInput,
  registerActivationRoutes
};

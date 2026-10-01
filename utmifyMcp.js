const crypto = require("crypto");

const MCP_PROTOCOL_VERSION = "2025-06-18";
const ALLOWED_LEVELS = ["campaign", "adset", "ad"];
const MAX_SYNC_DAYS = 31;
const DEFAULT_RESOURCES = "gs,gm,gu,gp,gtf";

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

function getMcpConfig() {
  const endpoint = String(
    process.env.UTMIFY_MCP_ENDPOINT || "https://mcp.utmify.com.br/mcp/"
  ).trim();
  const token = String(process.env.UTMIFY_MCP_TOKEN || "").trim();
  const resources = String(
    process.env.UTMIFY_MCP_RESOURCES || DEFAULT_RESOURCES
  ).trim();

  return { endpoint, token, resources };
}

function buildMcpUrl(config = getMcpConfig()) {
  if (!config.token) {
    const error = new Error("UTMIFY_MCP_TOKEN nao configurado");
    error.code = "UTMIFY_NOT_CONFIGURED";
    throw error;
  }

  const url = new URL(config.endpoint);
  url.searchParams.set("token", config.token);
  if (config.resources) url.searchParams.set("resources", config.resources);
  return url.toString();
}

function parseMcpText(result) {
  const content = result?.result?.content;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("");

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callMcpTool(name, args = {}, options = {}) {
  const allowed = new Set([
    "get_dashboards",
    "get_dashboard_summary",
    "get_meta_ad_objects"
  ]);

  if (!allowed.has(name)) {
    throw new Error("tool MCP nao permitida");
  }

  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs || 20000), 1000),
    30000
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    const response = await fetch(buildMcpUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name,
          arguments: args
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error("UTMify MCP indisponivel");
      error.statusCode = response.status;
      throw error;
    }

    const payload = await response.json();

    if (payload?.error || payload?.result?.isError) {
      throw new Error("UTMify MCP retornou erro");
    }

    return parseMcpText(payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("timeout ao consultar UTMify MCP");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function validateSyncRange(fromValue, toValue) {
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

  if (days > MAX_SYNC_DAYS) {
    const error = new Error("periodo maximo de sincronizacao: 31 dias");
    error.statusCode = 400;
    throw error;
  }

  return { from, to, days };
}

function offsetString(timeZone) {
  const value = Number(timeZone || 0);
  const sign = value >= 0 ? "+" : "-";
  const hours = String(Math.abs(value)).padStart(2, "0");
  return sign + hours + ":00";
}

function toMcpDateRange(from, to, timeZone) {
  const offset = offsetString(timeZone);
  return {
    from: from + "T00:00:00" + offset,
    to: to + "T23:59:59" + offset
  };
}

function normalizeDashboard(raw) {
  const metaAccounts = [];
  for (const profile of Array.isArray(raw?.metaProfiles) ? raw.metaProfiles : []) {
    for (const account of Array.isArray(profile?.adAccounts) ? profile.adAccounts : []) {
      if (!account?.enabled) continue;
      metaAccounts.push({
        id: normalizeText(account.id, 100),
        name: normalizeText(account.name, 160),
        profile_id: normalizeText(profile.id, 100),
        profile_name: normalizeText(profile.name, 160)
      });
    }
  }

  return {
    id: normalizeText(raw?.id, 100),
    name: normalizeText(raw?.name, 160),
    time_zone: Number(raw?.timeZone || 0),
    currency: normalizeText(raw?.currency || "BRL", 10),
    meta_accounts: metaAccounts
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function moneyFromCents(value) {
  const n = nullableNumber(value);
  return n == null ? null : n / 100;
}

function moneyOrZeroFromCents(value) {
  const n = moneyFromCents(value);
  return n == null ? 0 : n;
}

function normalizeMetaObject(raw, level) {
  return {
    level,
    object_id: normalizeText(raw?.id || raw?.adId || raw?.adsetId || raw?.campaignId, 120),
    profile_id: normalizeText(raw?.profileId, 120) || null,
    account_id: normalizeText(raw?.accountId, 120) || null,
    campaign_id: normalizeText(raw?.campaignId, 120) || null,
    adset_id: normalizeText(raw?.adsetId, 120) || null,
    ad_id: normalizeText(raw?.adId, 120) || null,
    name: normalizeText(raw?.name, 500) || "Sem nome",
    status: normalizeText(raw?.effectiveStatus || raw?.status, 80) || null,
    account_name: normalizeText(raw?.ca, 250) || null,
    metrics: {
      spend: moneyOrZeroFromCents(raw?.spend),
      impressions: numberOrZero(raw?.impressions),
      media_clicks: numberOrZero(raw?.inlineLinkClicks),
      landing_page_views: numberOrZero(raw?.landingPageViews),
      leads: numberOrZero(raw?.leads),
      checkouts: numberOrZero(raw?.initiateCheckout),
      purchases: numberOrZero(raw?.approvedOrdersCount),
      total_orders: numberOrZero(raw?.totalOrdersCount),
      pending_orders: numberOrZero(raw?.pendingOrdersCount),
      refunded_orders: numberOrZero(raw?.refundedOrdersCount),
      revenue: moneyOrZeroFromCents(raw?.revenue),
      gross_revenue: moneyOrZeroFromCents(raw?.grossRevenue),
      profit: moneyOrZeroFromCents(raw?.profit),
      cpa: moneyFromCents(raw?.cpa),
      cpl: moneyFromCents(raw?.costPerLead),
      cpc: moneyFromCents(raw?.costPerInlineLinkClick),
      cpm: moneyFromCents(raw?.cpm),
      ctr: nullableNumber(raw?.inlineLinkClickCtr),
      roas: nullableNumber(raw?.roas),
      roi: nullableNumber(raw?.roi),
      frequency: nullableNumber(raw?.frequency)
    }
  };
}

function performanceRow(object, nameMaps = {}) {
  const m = object.metrics || {};
  const campaignName =
    nameMaps.campaign?.get(object.campaign_id) ||
    (object.level === "campaign" ? object.name : null) ||
    object.campaign_id ||
    "Sem campanha";

  const adsetName =
    nameMaps.adset?.get(object.adset_id) ||
    (object.level === "adset" ? object.name : null) ||
    object.adset_id ||
    "Sem conjunto";

  const adName =
    object.level === "ad"
      ? object.name
      : object.ad_id || "Sem anúncio";

  const spend = numberOrZero(m.spend);
  const leads = numberOrZero(m.leads);
  const purchases = numberOrZero(m.purchases);
  const revenue = numberOrZero(m.revenue);

  return {
    campaign: campaignName,
    campaign_id: object.campaign_id,
    adset: adsetName,
    adset_id: object.adset_id,
    ad: adName,
    ad_id: object.ad_id,
    clicks: numberOrZero(m.landing_page_views),
    media_clicks: numberOrZero(m.media_clicks),
    impressions: numberOrZero(m.impressions),
    leads,
    checkouts: numberOrZero(m.checkouts),
    purchases,
    revenue,
    spend,
    cpl: m.cpl != null ? Number(m.cpl) : (leads > 0 ? spend / leads : null),
    cpa: m.cpa != null ? Number(m.cpa) : (purchases > 0 ? spend / purchases : null),
    roas: m.roas != null ? Number(m.roas) : (spend > 0 ? revenue / spend : null),
    profit: numberOrZero(m.profit),
    source: "utmify"
  };
}

async function initUtmifyDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_utmify_connection (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      dashboard_id TEXT,
      dashboard_name TEXT,
      time_zone INTEGER,
      currency TEXT,
      meta_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_discovery_at TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_utmify_syncs (
      id BIGSERIAL PRIMARY KEY,
      dashboard_id TEXT NOT NULL,
      date_from DATE NOT NULL,
      date_to DATE NOT NULL,
      levels JSONB NOT NULL DEFAULT '[]'::jsonb,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_utmify_syncs_range_idx
    ON dr_utmify_syncs (date_from, date_to, status, finished_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_utmify_ad_objects (
      id BIGSERIAL PRIMARY KEY,
      sync_id BIGINT NOT NULL REFERENCES dr_utmify_syncs(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      object_id TEXT NOT NULL,
      profile_id TEXT,
      account_id TEXT,
      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT,
      name TEXT NOT NULL,
      status TEXT,
      account_name TEXT,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (sync_id, level, object_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_utmify_objects_sync_level_idx
    ON dr_utmify_ad_objects (sync_id, level);
  `);
}

async function discoverUtmify(pool) {
  const dashboards = await callMcpTool("get_dashboards", {});
  const normalized = (Array.isArray(dashboards) ? dashboards : [])
    .map(normalizeDashboard)
    .filter((item) => item.id);

  if (!normalized.length) {
    throw new Error("nenhum dashboard UTMify disponivel");
  }

  const configuredId = normalizeText(process.env.UTMIFY_DASHBOARD_ID, 100);
  const selected =
    normalized.find((item) => item.id === configuredId) ||
    normalized[0];

  await pool.query(`
    INSERT INTO dr_utmify_connection (
      id, dashboard_id, dashboard_name, time_zone, currency,
      meta_accounts, last_discovery_at, last_error, updated_at
    )
    VALUES (1,$1,$2,$3,$4,$5::jsonb,NOW(),NULL,NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      dashboard_id = EXCLUDED.dashboard_id,
      dashboard_name = EXCLUDED.dashboard_name,
      time_zone = EXCLUDED.time_zone,
      currency = EXCLUDED.currency,
      meta_accounts = EXCLUDED.meta_accounts,
      last_discovery_at = NOW(),
      last_error = NULL,
      updated_at = NOW()
  `, [
    selected.id,
    selected.name,
    selected.time_zone,
    selected.currency,
    JSON.stringify(selected.meta_accounts)
  ]);

  return {
    selected,
    dashboards: normalized
  };
}

async function getConnection(pool) {
  const result = await pool.query(`
    SELECT *
    FROM dr_utmify_connection
    WHERE id = 1
    LIMIT 1
  `);
  return result.rows[0] || null;
}

async function ensureConnection(pool) {
  let connection = await getConnection(pool);
  if (!connection?.dashboard_id) {
    await discoverUtmify(pool);
    connection = await getConnection(pool);
  }
  return connection;
}

async function syncUtmify(pool, input = {}) {
  const range = validateSyncRange(input.from, input.to);
  const requestedLevels = Array.isArray(input.levels) && input.levels.length
    ? input.levels
    : ALLOWED_LEVELS;

  const levels = Array.from(new Set(requestedLevels))
    .filter((level) => ALLOWED_LEVELS.includes(level));

  if (!levels.length) {
    const error = new Error("nenhum nivel valido");
    error.statusCode = 400;
    throw error;
  }

  const connection = await ensureConnection(pool);
  const mcpRange = toMcpDateRange(
    range.from,
    range.to,
    Number(connection.time_zone || 0)
  );

  const enabledAccounts = Array.isArray(connection.meta_accounts)
    ? connection.meta_accounts.map((item) => item.id).filter(Boolean)
    : [];

  const syncResult = await pool.query(`
    INSERT INTO dr_utmify_syncs (
      dashboard_id, date_from, date_to, levels, status
    )
    VALUES ($1,$2,$3,$4::jsonb,'running')
    RETURNING id
  `, [
    connection.dashboard_id,
    range.from,
    range.to,
    JSON.stringify(levels)
  ]);

  const syncId = Number(syncResult.rows[0].id);
  const counts = {};

  try {
    for (const level of levels) {
      const payload = await callMcpTool("get_meta_ad_objects", {
        dashboardId: connection.dashboard_id,
        dateRange: mcpRange,
        level,
        metaAdAccountIds: enabledAccounts.length ? enabledAccounts : null,
        accountStatuses: ["ACTIVE"]
      });

      const rows = Array.isArray(payload?.results)
        ? payload.results
        : [];

      counts[level] = rows.length;

      for (const raw of rows) {
        const item = normalizeMetaObject(raw, level);
        if (!item.object_id) continue;

        await pool.query(`
          INSERT INTO dr_utmify_ad_objects (
            sync_id, level, object_id, profile_id, account_id,
            campaign_id, adset_id, ad_id, name, status,
            account_name, metrics
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
          ON CONFLICT (sync_id, level, object_id) DO NOTHING
        `, [
          syncId,
          item.level,
          item.object_id,
          item.profile_id,
          item.account_id,
          item.campaign_id,
          item.adset_id,
          item.ad_id,
          item.name,
          item.status,
          item.account_name,
          JSON.stringify(item.metrics)
        ]);
      }
    }

    await pool.query(`
      UPDATE dr_utmify_syncs
      SET status = 'completed',
          counts = $1::jsonb,
          finished_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(counts), syncId]);

    await pool.query(`
      UPDATE dr_utmify_connection
      SET last_sync_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
      WHERE id = 1
    `);

    return { sync_id: syncId, counts, range };
  } catch (error) {
    await pool.query(`
      UPDATE dr_utmify_syncs
      SET status = 'failed',
          error = 'falha ao sincronizar UTMify',
          finished_at = NOW()
      WHERE id = $1
    `, [syncId]);

    await pool.query(`
      UPDATE dr_utmify_connection
      SET last_error = 'falha ao sincronizar UTMify',
          updated_at = NOW()
      WHERE id = 1
    `);

    throw error;
  }
}

async function latestSyncForRange(pool, from, to) {
  const result = await pool.query(`
    SELECT *
    FROM dr_utmify_syncs
    WHERE date_from = $1::date
      AND date_to = $2::date
      AND status = 'completed'
    ORDER BY finished_at DESC, id DESC
    LIMIT 1
  `, [from, to]);

  return result.rows[0] || null;
}

async function getPerformance(pool, input = {}) {
  const range = validateSyncRange(input.from, input.to);
  const level = ALLOWED_LEVELS.includes(input.level)
    ? input.level
    : "campaign";

  const sync = await latestSyncForRange(pool, range.from, range.to);
  if (!sync) {
    const error = new Error("periodo ainda nao sincronizado com a UTMify");
    error.statusCode = 404;
    throw error;
  }

  const rowsResult = await pool.query(`
    SELECT
      level, object_id, profile_id, account_id,
      campaign_id, adset_id, ad_id, name, status,
      account_name, metrics
    FROM dr_utmify_ad_objects
    WHERE sync_id = $1
    ORDER BY id
  `, [sync.id]);

  const all = rowsResult.rows;
  const campaignMap = new Map(
    all
      .filter((row) => row.level === "campaign")
      .map((row) => [row.campaign_id, row.name])
  );
  const adsetMap = new Map(
    all
      .filter((row) => row.level === "adset")
      .map((row) => [row.adset_id, row.name])
  );

  const nameMaps = {
    campaign: campaignMap,
    adset: adsetMap
  };

  const rows = all
    .filter((row) => row.level === level)
    .map((row) => performanceRow(row, nameMaps))
    .sort((a, b) => b.spend - a.spend);

  return {
    sync: {
      id: sync.id,
      date_from: sync.date_from,
      date_to: sync.date_to,
      finished_at: sync.finished_at
    },
    rows
  };
}



function safeRatio(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0
    ? n / d
    : null;
}

function buildEconomicsSummary(media = {}, internal = {}) {
  const spend = numberOrZero(media.spend);
  const utmifyPurchases = numberOrZero(media.purchases);
  const utmifyRevenue = numberOrZero(media.revenue);

  const internalFrontPurchases = numberOrZero(internal.front_purchases);
  const internalFrontRevenue = numberOrZero(internal.front_revenue);
  const mentorshipRevenue = numberOrZero(internal.mentorship_revenue);
  const bumpRevenue = numberOrZero(internal.bump_revenue);
  const refunds = numberOrZero(internal.refunds);
  const trackedNetRevenue = numberOrZero(internal.net_revenue);

  return {
    spend,
    utmify_purchases: utmifyPurchases,
    utmify_front_revenue: utmifyRevenue,
    utmify_cpa: safeRatio(spend, utmifyPurchases),
    utmify_front_roas: safeRatio(utmifyRevenue, spend),
    internal_front_purchases: internalFrontPurchases,
    internal_front_revenue: internalFrontRevenue,
    mentorship_purchases: numberOrZero(internal.mentorship_purchases),
    mentorship_revenue: mentorshipRevenue,
    bump_revenue: bumpRevenue,
    refunds,
    tracked_net_revenue: trackedNetRevenue,
    tracked_total_roas: safeRatio(trackedNetRevenue, spend),
    ltv_per_front_buyer:
      internal.ltv_per_front_buyer == null
        ? null
        : Number(internal.ltv_per_front_buyer),
    mentorship_attach_rate_pct:
      internal.mentorship_attach_rate_pct == null
        ? null
        : Number(internal.mentorship_attach_rate_pct),
    purchase_tracking_coverage_pct:
      utmifyPurchases > 0
        ? (internalFrontPurchases / utmifyPurchases) * 100
        : null,
    revenue_tracking_coverage_pct:
      utmifyRevenue > 0
        ? (internalFrontRevenue / utmifyRevenue) * 100
        : null,
    downstream_revenue:
      mentorshipRevenue + bumpRevenue - refunds
  };
}

async function getInternalEconomics(pool, from, to) {
  const result = await pool.query(`
    WITH cohort_purchases AS (
      SELECT event_id, click_id, value
      FROM dr_events
      WHERE event_name = 'purchase'
        AND (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
        AND (((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
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
        COUNT(DISTINCT e.click_id) FILTER (
          WHERE e.event_name = 'mentorship_purchase'
        )::int AS mentorship_purchases,
        COALESCE(SUM(e.value) FILTER (
          WHERE e.event_name = 'mentorship_purchase'
        ),0)::numeric AS mentorship_revenue,
        COALESCE(SUM(e.value) FILTER (
          WHERE e.event_name = 'order_bump_purchase'
        ),0)::numeric AS bump_revenue,
        COALESCE(SUM(ABS(e.value)) FILTER (
          WHERE e.event_name = 'refund'
        ),0)::numeric AS refunds
      FROM dr_events e
      JOIN cohort_clicks c ON c.click_id = e.click_id
    )
    SELECT
      f.front_purchases,
      f.front_revenue,
      d.mentorship_purchases,
      d.mentorship_revenue,
      d.bump_revenue,
      d.refunds,
      (
        f.front_revenue +
        d.mentorship_revenue +
        d.bump_revenue -
        d.refunds
      )::numeric AS net_revenue,
      CASE WHEN f.front_purchases > 0
        THEN ROUND((
          f.front_revenue +
          d.mentorship_revenue +
          d.bump_revenue -
          d.refunds
        ) / f.front_purchases, 2)
        ELSE NULL END AS ltv_per_front_buyer,
      CASE WHEN f.front_purchases > 0
        THEN ROUND(
          (d.mentorship_purchases::numeric / f.front_purchases) * 100,
          2
        )
        ELSE NULL END AS mentorship_attach_rate_pct
    FROM front f
    CROSS JOIN downstream d
  `, [from, to]);

  return result.rows[0] || {};
}

async function getUtmifyMediaTotals(pool, syncId) {
  const result = await pool.query(`
    SELECT
      COALESCE(SUM((metrics->>'spend')::numeric), 0)::numeric AS spend,
      COALESCE(SUM((metrics->>'purchases')::numeric), 0)::numeric AS purchases,
      COALESCE(SUM((metrics->>'revenue')::numeric), 0)::numeric AS revenue
    FROM dr_utmify_ad_objects
    WHERE sync_id = $1
      AND level = 'campaign'
  `, [syncId]);

  return result.rows[0] || {};
}

async function getEconomics(pool, input = {}) {
  const range = validateSyncRange(input.from, input.to);
  const sync = await latestSyncForRange(pool, range.from, range.to);

  if (!sync) {
    const error = new Error("periodo ainda nao sincronizado com a UTMify");
    error.statusCode = 404;
    throw error;
  }

  const [media, internal] = await Promise.all([
    getUtmifyMediaTotals(pool, sync.id),
    getInternalEconomics(pool, range.from, range.to)
  ]);

  return {
    sync: {
      id: sync.id,
      date_from: sync.date_from,
      date_to: sync.date_to,
      finished_at: sync.finished_at
    },
    economics: buildEconomicsSummary(media, internal)
  };
}

function registerUtmifyRoutes(app, pool) {
  app.get("/api/integrations/utmify/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const configured = Boolean(getMcpConfig().token);

    try {
      const connection = await getConnection(pool);
      const lastSync = await pool.query(`
        SELECT id, date_from, date_to, counts, status, finished_at
        FROM dr_utmify_syncs
        ORDER BY id DESC
        LIMIT 1
      `);

      res.json({
        ok: true,
        configured,
        connection,
        last_sync: lastSync.rows[0] || null
      });
    } catch {
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });

  app.post("/api/integrations/utmify/discover", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await discoverUtmify(pool);
      res.json({ ok: true, ...result });
    } catch {
      res.status(502).json({ ok: false, error: "nao foi possivel conectar a UTMify" });
    }
  });

  app.post("/api/integrations/utmify/sync", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await syncUtmify(pool, req.body || {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 502).json({
        ok: false,
        error: error.statusCode ? error.message : "falha ao sincronizar UTMify"
      });
    }
  });

  app.get("/api/integrations/utmify/performance", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await getPerformance(pool, {
        from: req.query.from,
        to: req.query.to,
        level: req.query.level
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        ok: false,
        error: error.statusCode ? error.message : "erro interno"
      });
    }
  });

  app.get("/api/integrations/utmify/economics", async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
      const result = await getEconomics(pool, {
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
  ALLOWED_LEVELS,
  MAX_SYNC_DAYS,
  buildEconomicsSummary,
  buildMcpUrl,
  callMcpTool,
  discoverUtmify,
  getEconomics,
  getPerformance,
  initUtmifyDb,
  normalizeDashboard,
  normalizeMetaObject,
  performanceRow,
  registerUtmifyRoutes,
  syncUtmify,
  toMcpDateRange,
  validateSyncRange
};

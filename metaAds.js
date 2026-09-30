const crypto = require("crypto");
const {
  normalizeSpendInput,
  upsertSpend
} = require("./spendStore");

const META_FIELDS = [
  "date_start",
  "date_stop",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "account_currency",
  "spend",
  "impressions",
  "clicks"
];

const META_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PAGE_CAP = 100;

let syncInProgress = false;

function httpError(message, statusCode, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function clean(value) {
  return String(value || "").trim();
}

function getMetaConfig(env = process.env) {
  return {
    accessToken: clean(env.META_ACCESS_TOKEN),
    adAccountId: clean(env.META_AD_ACCOUNT_ID),
    apiVersion: clean(env.META_API_VERSION),
    syncSecret: clean(env.META_SYNC_SECRET)
  };
}
function getMetaStatus(env = process.env) {
  const config = getMetaConfig(env);

  const status = {
    provider: "meta",
    service: "meta_ads",
    has_access_token: Boolean(config.accessToken),
    has_ad_account: Boolean(config.adAccountId),
    has_api_version: Boolean(config.apiVersion),
    has_sync_secret: Boolean(config.syncSecret)
  };

  status.configured =
    status.has_access_token &&
    status.has_ad_account &&
    status.has_api_version &&
    status.has_sync_secret;

  return status;
}

function getMissingMetaConfig(env = process.env) {
  const config = getMetaConfig(env);
  const missing = [];

  if (!config.accessToken) missing.push("META_ACCESS_TOKEN");
  if (!config.adAccountId) missing.push("META_AD_ACCOUNT_ID");
  if (!config.apiVersion) missing.push("META_API_VERSION");

  return missing;
}

function secretMatches(expected, received) {
  if (!expected || !received) return false;

  const expectedHash = crypto
    .createHash("sha256")
    .update(String(expected))
    .digest();

  const receivedHash = crypto
    .createHash("sha256")
    .update(String(received))
    .digest();

  return crypto.timingSafeEqual(expectedHash, receivedHash);
}

function normalizeAdAccountId(value) {
  const account = clean(value);
  if (!account) return "";
  return account.startsWith("act_") ? account : "act_" + account;
}
function validateIsoDate(value, field) {
  const normalized = clean(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw httpError(
      field + " deve usar o formato YYYY-MM-DD",
      400
    );
  }

  const parsed = new Date(normalized + "T00:00:00Z");

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw httpError(field + " deve ser uma data valida", 400);
  }

  return normalized;
}

function dateInTimeZone(now = new Date(), timeZone = META_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return values.year + "-" + values.month + "-" + values.day;
}

function shiftIsoDate(isoDate, days) {
  const date = new Date(isoDate + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function resolveMetaSyncRange(body = {}, now = new Date()) {
  let from = body.from ? validateIsoDate(body.from, "from") : null;
  let to = body.to ? validateIsoDate(body.to, "to") : null;

  if (!from && !to) {
    to = dateInTimeZone(now);
    from = shiftIsoDate(to, -1);
  } else if (from && !to) {
    to = from;
  } else if (!from && to) {
    from = to;
  }

  if (from > to) {
    throw httpError("from nao pode ser maior que to", 400);
  }

  return { from, to };
}
async function fetchWithTimeout(
  fetchImpl,
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw httpError("timeout ao consultar Meta Ads", 502);
    }

    throw httpError("falha ao consultar Meta Ads", 502);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizePagingUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "graph.facebook.com"
    ) {
      throw new Error("host de paginacao nao permitido");
    }

    url.searchParams.delete("access_token");
    return url.toString();
  } catch (error) {
    throw httpError("paginacao invalida da Meta Ads", 502);
  }
}

function buildInitialInsightsUrl(config, from, to) {
  const account = normalizeAdAccountId(config.adAccountId);

  const url = new URL(
    "https://graph.facebook.com/" +
      encodeURIComponent(config.apiVersion) +
      "/" +
      encodeURIComponent(account) +
      "/insights"
  );

  url.searchParams.set("level", "ad");
  url.searchParams.set("fields", META_FIELDS.join(","));
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("limit", "100");
  url.searchParams.set(
    "time_range",
    JSON.stringify({ since: from, until: to })
  );

  return url.toString();
}
async function fetchMetaInsights({
  config,
  from,
  to,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageCap = DEFAULT_PAGE_CAP
}) {
  if (typeof fetchImpl !== "function") {
    throw httpError("cliente HTTP indisponivel", 500);
  }

  let nextUrl = buildInitialInsightsUrl(config, from, to);
  const rows = [];
  let pages = 0;

  while (nextUrl) {
    pages += 1;

    if (pages > pageCap) {
      throw httpError("limite de paginacao da Meta Ads excedido", 502);
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      nextUrl,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer " + config.accessToken,
          Accept: "application/json"
        }
      },
      timeoutMs
    );

    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      throw httpError("resposta invalida da Meta Ads", 502);
    }

    if (!response.ok || (payload && payload.error)) {
      const providerCode =
        payload && payload.error && payload.error.code != null
          ? String(payload.error.code)
          : null;

      throw httpError("Meta Ads respondeu com erro", 502, {
        providerCode
      });
    }

    if (!payload || !Array.isArray(payload.data)) {
      throw httpError("formato inesperado da Meta Ads", 502);
    }

    rows.push(...payload.data);

    nextUrl =
      payload.paging && payload.paging.next
        ? sanitizePagingUrl(payload.paging.next)
        : null;
  }

  return {
    rows,
    pages
  };
}
async function persistMetaRows(pool, rows) {
  const client = await pool.connect();

  let upserted = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const row of rows) {
      try {
        if (!row || typeof row !== "object") {
          skipped += 1;
          continue;
        }

        const safeRow = row;
        const currency = clean(safeRow.account_currency).toUpperCase();

        if (!currency) {
          throw httpError("moeda da conta Meta nao informada", 502);
        }

        if (currency !== "BRL") {
          throw httpError("moeda da conta Meta ainda nao suportada", 409);
        }

        const normalized = normalizeSpendInput(
          {
            spend_date: safeRow.date_start,
            source: "meta",
            campaign_id: safeRow.campaign_id,
            campaign_name: safeRow.campaign_name,
            adset_id: safeRow.adset_id,
            adset_name: safeRow.adset_name,
            ad_id: safeRow.ad_id,
            ad_name: safeRow.ad_name,
            spend: safeRow.spend,
            impressions: safeRow.impressions,
            clicks: safeRow.clicks
          },
          { defaultSource: "meta" }
        );

        await upsertSpend(client, normalized);
        upserted += 1;
      } catch (error) {
        if (error && error.statusCode === 400) {
          skipped += 1;
          continue;
        }

        throw error;
      }
    }

    await client.query("COMMIT");

    return {
      upserted,
      skipped
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the original persistence error.
    }

    throw error;
  } finally {
    client.release();
  }
}
async function runMetaSync({
  pool,
  body = {},
  env = process.env,
  fetchImpl = global.fetch,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageCap = DEFAULT_PAGE_CAP
}) {
  if (syncInProgress) {
    throw httpError("sincronizacao Meta Ads ja esta em andamento", 409);
  }

  const missing = getMissingMetaConfig(env);

  if (missing.length > 0) {
    throw httpError("integracao Meta Ads nao configurada", 503, {
      missing
    });
  }

  const config = getMetaConfig(env);
  const range = resolveMetaSyncRange(body, now);

  syncInProgress = true;

  try {
    const fetched = await fetchMetaInsights({
      config,
      from: range.from,
      to: range.to,
      fetchImpl,
      timeoutMs,
      pageCap
    });

    const persisted = await persistMetaRows(pool, fetched.rows);

    return {
      provider: "meta",
      from: range.from,
      to: range.to,
      fetched: fetched.rows.length,
      upserted: persisted.upserted,
      skipped: persisted.skipped,
      pages: fetched.pages
    };
  } finally {
    syncInProgress = false;
  }
}

module.exports = {
  META_TIMEZONE,
  getMetaConfig,
  getMetaStatus,
  getMissingMetaConfig,
  secretMatches,
  normalizeAdAccountId,
  validateIsoDate,
  dateInTimeZone,
  shiftIsoDate,
  resolveMetaSyncRange,
  buildInitialInsightsUrl,
  fetchMetaInsights,
  runMetaSync
};

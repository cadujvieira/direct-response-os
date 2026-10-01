const crypto = require("crypto");

function parseCookies(header = "") {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf("=");
      if (index === -1) return acc;
      const key = decodeURIComponent(part.slice(0, index).trim());
      const value = decodeURIComponent(part.slice(index + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function normalizedWeight(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function hashToUnitInterval(key) {
  const digest = crypto.createHash("sha256").update(String(key)).digest();
  const integer = digest.readUInt32BE(0);
  return integer / 0x100000000;
}

function selectWeightedVariant(variants, key) {
  const active = (variants || []).filter(
    (variant) => variant && variant.active !== false && normalizedWeight(variant.weight) > 0
  );

  if (active.length === 0) return null;

  const total = active.reduce((sum, variant) => sum + normalizedWeight(variant.weight), 0);
  let cursor = hashToUnitInterval(key) * total;

  for (const variant of active) {
    cursor -= normalizedWeight(variant.weight);
    if (cursor < 0) return variant;
  }

  return active[active.length - 1];
}

function buildRedirectUrl(destinationUrl, params = {}) {
  let url;
  try {
    url = new URL(destinationUrl);
  } catch {
    const error = new Error("destination_url invalida");
    error.statusCode = 500;
    throw error;
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("destination_url deve usar http ou https");
    error.statusCode = 500;
    throw error;
  }

  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function ensureIdentifier(value, prefix) {
  const normalized = String(value || "").trim();
  return normalized || `${prefix}_${crypto.randomUUID()}`;
}

function resolveRouterIdentity(query = {}, cookies = {}) {
  return {
    clickId: ensureIdentifier(query.click_id, "dr"),
    visitorKey: ensureIdentifier(
      cookies.dr_visitor_id || cookies.dr_session,
      "visitor"
    )
  };
}

function routingTrackingParams(query = {}, clickId, experimentSlug, variantName) {
  const allowed = [
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "campaign_id", "adset_id", "ad_id", "fbclid", "gclid"
  ];
  const params = {};

  for (const key of allowed) {
    if (query[key] != null && query[key] !== "") params[key] = query[key];
  }

  params.click_id = clickId;
  params.dr_experiment = experimentSlug;
  params.dr_variant = variantName;
  return params;
}

module.exports = {
  parseCookies,
  selectWeightedVariant,
  buildRedirectUrl,
  ensureIdentifier,
  resolveRouterIdentity,
  routingTrackingParams
};

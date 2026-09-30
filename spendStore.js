const UPSERT_SPEND_SQL = `
  INSERT INTO dr_ad_spend (
    spend_date,
    source,
    campaign_id,
    campaign_name,
    adset_id,
    adset_name,
    ad_id,
    ad_name,
    spend,
    impressions,
    clicks
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
  )

  ON CONFLICT (
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
  )

  DO UPDATE SET
    campaign_name = EXCLUDED.campaign_name,
    adset_name = EXCLUDED.adset_name,
    ad_name = EXCLUDED.ad_name,
    spend = EXCLUDED.spend,
    impressions = EXCLUDED.impressions,
    clicks = EXCLUDED.clicks,
    updated_at = NOW()

  RETURNING
    id,
    spend_date,
    source,
    campaign_id,
    campaign_name,
    adset_id,
    adset_name,
    ad_id,
    ad_name,
    spend,
    impressions,
    clicks
`;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanString(value) {
  return String(value || "").trim();
}
function normalizeSpendInput(input = {}, options = {}) {
  if (!input.spend_date) {
    throw badRequest("spend_date obrigatorio");
  }

  const spendDate = cleanString(input.spend_date);
  const parsedSpendDate = new Date(spendDate + "T00:00:00Z");

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(spendDate) ||
    Number.isNaN(parsedSpendDate.getTime()) ||
    parsedSpendDate.toISOString().slice(0, 10) !== spendDate
  ) {
    throw badRequest(
      "spend_date deve ser uma data valida no formato YYYY-MM-DD"
    );
  }

  const campaignId = cleanString(input.campaign_id);
  const campaignName = cleanString(input.campaign_name);
  const adsetId = cleanString(input.adset_id);
  const adsetName = cleanString(input.adset_name);
  const adId = cleanString(input.ad_id);
  const adName = cleanString(input.ad_name);

  if (!campaignId && !campaignName) {
    throw badRequest("campaign_id ou campaign_name obrigatorio");
  }

  const defaultSource = cleanString(options.defaultSource || "meta") || "meta";
  const source = cleanString(input.source || defaultSource).toLowerCase() || defaultSource;

  const spend = Number(input.spend || 0);
  const impressions = Number(input.impressions || 0);
  const clicks = Number(input.clicks || 0);
  if (
    !Number.isFinite(spend) ||
    !Number.isFinite(impressions) ||
    !Number.isFinite(clicks)
  ) {
    throw badRequest("valores de midia invalidos");
  }

  if (!Number.isInteger(impressions) || !Number.isInteger(clicks)) {
    throw badRequest("impressions e clicks devem ser numeros inteiros");
  }

  if (spend < 0 || impressions < 0 || clicks < 0) {
    throw badRequest("valores de midia nao podem ser negativos");
  }

  return {
    spend_date: spendDate,
    source,
    campaign_id: campaignId || null,
    campaign_name: campaignName || null,
    adset_id: adsetId || null,
    adset_name: adsetName || null,
    ad_id: adId || null,
    ad_name: adName || null,
    spend,
    impressions,
    clicks
  };
}

async function upsertSpend(db, record) {
  const result = await db.query(UPSERT_SPEND_SQL, [
    record.spend_date,
    record.source,
    record.campaign_id,
    record.campaign_name,
    record.adset_id,
    record.adset_name,
    record.ad_id,
    record.ad_name,
    record.spend,
    record.impressions,
    record.clicks
  ]);

  return result.rows[0];
}
module.exports = {
  UPSERT_SPEND_SQL,
  normalizeSpendInput,
  upsertSpend
};

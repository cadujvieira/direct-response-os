// Desempenho por pagina quando o anuncio aponta direto para a landing page (sem router). A tag das paginas grava
// em cada clique o endereco da pagina onde o visitante chegou (dr_clicks.page_url = origem + caminho), entao da
// para somar cliques, compradores e receita por pagina. Cliques que passaram pelo router ficam de fora (ja aparecem
// na tabela da rota); clique recuperado pelo checkout nao sabe a pagina e aparece como "nao identificada".
//
// Investimento por pagina: o gasto de cada anuncio (dr_ad_spend, vindo da UTMify) e dividido entre as paginas na
// proporcao dos cliques daquele anuncio no periodo. Com um link por criativo, o anuncio inteiro cai numa pagina so.
// Gasto de anuncio sem nenhum clique registrado fica em "sem pagina identificada", para o total bater.

// host + caminho, sem protocolo, www, parametros, ancora e barra final. Endereco que nao e http(s) vira null.
function normalizePage(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\/+$/, "");
    return (url.hostname.toLowerCase().replace(/^www\./, "") + path).slice(0, 300);
  } catch (error) { return null; }
}

const PAGE_SQL = `regexp_replace(regexp_replace(lower(split_part(split_part(c.page_url, '?', 1), '#', 1)), '^https?://(www\\.)?', ''), '/+$', '')`;
const UNKNOWN = "__nao_identificada__", NO_CLICK = "__sem_clique__";
const DAY = column => `((${column} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date`;

async function getPagePerformance(pool, { from = null, to = null } = {}) {
  const rows = (await pool.query(`
    WITH clicks AS (
      SELECT c.click_id, NULLIF(TRIM(c.ad_id), '') AS ad_id,
        COALESCE(CASE WHEN c.page_url ~* '^https?://' THEN ${PAGE_SQL} END, '${UNKNOWN}') AS page
      FROM dr_clicks c
      WHERE COALESCE(c.capture_source, '') <> 'router'
        AND ($1::date IS NULL OR ${DAY("c.created_at")} >= $1::date)
        AND ($2::date IS NULL OR ${DAY("c.created_at")} <= $2::date)
    ),
    events AS (
      SELECT e.click_id,
        COUNT(*) FILTER (WHERE e.event_name = 'purchase')::int AS front_purchases,
        COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'purchase'), 0)::numeric AS front_revenue,
        COUNT(*) FILTER (WHERE e.event_name = 'mentorship_purchase')::int AS mentorship_purchases,
        COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'mentorship_purchase'), 0)::numeric AS mentorship_revenue,
        COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'order_bump_purchase'), 0)::numeric AS bump_revenue,
        COALESCE(SUM(ABS(e.value)) FILTER (WHERE e.event_name = 'refund'), 0)::numeric AS refunds
      FROM dr_events e JOIN clicks k ON k.click_id = e.click_id
      GROUP BY e.click_id
    ),
    by_page AS (
      SELECT k.page, COUNT(*)::int AS clicks,
        COUNT(*) FILTER (WHERE ev.front_purchases > 0)::int AS buyers,
        COALESCE(SUM(ev.front_purchases), 0)::int AS front_purchases,
        COALESCE(SUM(ev.front_revenue), 0)::numeric AS front_revenue,
        COALESCE(SUM(ev.mentorship_purchases), 0)::int AS mentorship_purchases,
        COALESCE(SUM(ev.mentorship_revenue), 0)::numeric AS mentorship_revenue,
        COALESCE(SUM(ev.bump_revenue), 0)::numeric AS bump_revenue,
        COALESCE(SUM(ev.refunds), 0)::numeric AS refunds
      FROM clicks k LEFT JOIN events ev ON ev.click_id = k.click_id
      GROUP BY k.page
    ),
    ad_spend AS (
      SELECT NULLIF(TRIM(s.ad_id), '') AS ad_id, SUM(s.spend)::numeric AS spend
      FROM dr_ad_spend s
      WHERE ($1::date IS NULL OR s.spend_date >= $1::date) AND ($2::date IS NULL OR s.spend_date <= $2::date)
      GROUP BY 1
    ),
    ad_page AS (
      SELECT ad_id, page, COUNT(*)::numeric AS n, SUM(COUNT(*)) OVER (PARTITION BY ad_id)::numeric AS total
      FROM clicks WHERE ad_id IS NOT NULL GROUP BY ad_id, page
    ),
    spend_by_page AS (
      SELECT p.page, SUM(a.spend * p.n / p.total)::numeric AS spend
      FROM ad_spend a JOIN ad_page p ON p.ad_id = a.ad_id GROUP BY p.page
      UNION ALL
      SELECT '${NO_CLICK}', SUM(a.spend)::numeric
      FROM ad_spend a WHERE a.ad_id IS NULL OR NOT EXISTS (SELECT 1 FROM ad_page p WHERE p.ad_id = a.ad_id)
      HAVING SUM(a.spend) > 0
    ),
    spend_total AS (SELECT page, SUM(spend) AS spend FROM spend_by_page GROUP BY page)
    SELECT COALESCE(b.page, st.page) AS page,
      COALESCE(b.clicks, 0) AS clicks, COALESCE(b.buyers, 0) AS buyers, COALESCE(b.front_purchases, 0) AS front_purchases,
      COALESCE(b.front_revenue, 0) AS front_revenue, COALESCE(b.mentorship_purchases, 0) AS mentorship_purchases,
      COALESCE(b.mentorship_revenue, 0) AS mentorship_revenue, COALESCE(b.bump_revenue, 0) AS bump_revenue,
      COALESCE(b.refunds, 0) AS refunds, ROUND(COALESCE(st.spend, 0), 2) AS spend
    FROM by_page b
    FULL JOIN spend_total st ON st.page = b.page
    ORDER BY COALESCE(b.buyers, 0) DESC, COALESCE(b.clicks, 0) DESC
  `, [from, to])).rows;

  // Nome da pagina: o mesmo usado nas rotas do router, quando o endereco bate com o destino de alguma LP.
  const names = new Map();
  for (const v of (await pool.query(`SELECT v.name, v.destination_url FROM dr_experiment_variants v ORDER BY v.id`)).rows) {
    const key = normalizePage(v.destination_url);
    if (key && !names.has(key)) names.set(key, v.name);
  }
  return rows.map(row => {
    const net = Number(row.front_revenue) + Number(row.mentorship_revenue) + Number(row.bump_revenue) - Number(row.refunds);
    const special = row.page === UNKNOWN || row.page === NO_CLICK;
    const label = row.page === NO_CLICK ? "Anúncios sem clique registrado" : row.page === UNKNOWN ? "Página não identificada"
      : names.get(row.page) || row.page;
    return { page: special ? null : row.page, name: label, unidentified: special, spend_without_page: row.page === NO_CLICK,
      clicks: Number(row.clicks), buyers: Number(row.buyers), front_purchases: Number(row.front_purchases),
      front_revenue: Number(row.front_revenue), mentorship_purchases: Number(row.mentorship_purchases),
      mentorship_revenue: Number(row.mentorship_revenue), bump_revenue: Number(row.bump_revenue), refunds: Number(row.refunds),
      net_revenue: Math.round(net * 100) / 100, spend: Number(row.spend) };
  });
}

function registerPagePerformanceRoutes(app, pool, parseReportRange) {
  // So contagens e valores agregados por pagina (host + caminho, sem parametros); mesmo nivel de acesso da tabela da rota.
  app.get("/api/pages/performance", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { from, to } = parseReportRange(req.query);
      res.json({ ok: true, range: { from, to }, pages: await getPagePerformance(pool, { from, to }) });
    } catch (error) {
      const statusCode = error.statusCode === 400 ? 400 : 500;
      res.status(statusCode).json({ ok: false, error: statusCode === 400 ? error.message : "erro interno" });
    }
  });
}

module.exports = { normalizePage, getPagePerformance, registerPagePerformanceRoutes };

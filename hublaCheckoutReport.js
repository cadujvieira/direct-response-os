// Relatorio de checkouts da Hubla: o que aconteceu com cada fatura (paga, Pix/boleto sem pagamento, cartao nao
// aprovado) e vendas por campanha (UTM do proprio checkout). Somente leitura sobre o inbox dr_hubla_events.
// Nunca devolve nome, e-mail, telefone, documento ou URL completa do checkout.
const { requireAdmin } = require("./trackingHealth");
const { hublaConfig } = require("./hublaWebhook");

const PAID = new Set(["paid", "refunded", "partially_refunded", "chargeback", "in_protest"]);
const METHOD_LABEL = { pix: "Pix", bank_slip: "Boleto", credit_card: "Cartão" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(value, max = 200) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).replace(/[\u0000-\u001f]/g, " ").trim();
  return result ? result.slice(0, max) : null;
}
function paidHistory(invoice) {
  return (Array.isArray(invoice?.statusAt) ? invoice.statusAt : []).some(e => e && PAID.has(e.status));
}
function sessionUtm(invoice) {
  const session = invoice?.paymentSession && typeof invoice.paymentSession === "object" ? invoice.paymentSession : {};
  const utm = session.utm && typeof session.utm === "object" ? session.utm : {};
  const params = {};
  if (session.params && typeof session.params === "object") {
    for (const [key, value] of Object.entries(session.params)) params[key.toLowerCase()] = value;
  }
  if (typeof session.url === "string") {
    try { for (const [key, value] of new URL(session.url).searchParams) if (!(key.toLowerCase() in params)) params[key.toLowerCase()] = value; }
    catch { /* URL ilegivel: segue so com o que veio em params/utm */ }
  }
  const pick = (a, b) => text(a, 300) || text(b, 300);
  return { utm_source: pick(utm.source, params.utm_source), utm_campaign: pick(utm.campaign, params.utm_campaign), params };
}
// Nome da campanha sem o sufixo "|id" que o parametro padrao dos anuncios acrescenta.
function campaignName(value) {
  if (!value) return null;
  const parts = value.split("|");
  return parts.length > 1 && /^\d{6,}$/.test(parts[parts.length - 1].trim()) ? parts.slice(0, -1).join("|").trim() : value;
}
function outcomeOf(invoice) {
  if (paidHistory(invoice) || PAID.has(invoice?.status)) return "pago";
  const method = invoice?.paymentMethod;
  if (method === "credit_card") return "cartao_nao_aprovado";
  if (method === "pix") return "pix_sem_pagamento";
  if (method === "bank_slip") return "boleto_sem_pagamento";
  return "sem_forma_de_pagamento";
}
const OUTCOME_LABEL = { pago: "Pago", cartao_nao_aprovado: "Cartão não aprovado", pix_sem_pagamento: "Pix gerado e não pago",
  boleto_sem_pagamento: "Boleto gerado e não pago", sem_forma_de_pagamento: "Sem forma de pagamento informada" };

// rows: avisos reais (sem sandbox) com payload, em qualquer ordem. Funcao pura, coberta por teste.
function buildCheckoutReport(rows, config = hublaConfig()) {
  const byInvoice = new Map();
  const abandoned = new Set();
  for (const row of rows) {
    const body = row.payload || {};
    if (body.type === "lead.abandoned_checkout") {
      const id = text(body.event?.lead?.id, 100) || "aviso:" + row.id;
      abandoned.add(id);
      continue;
    }
    const invoice = body.event?.invoice;
    const id = text(invoice?.id, 100);
    if (!id || !String(body.type || "").startsWith("invoice.")) continue;
    const version = Number.isInteger(invoice.version) ? invoice.version : -1;
    const order = [version, new Date(row.received_at).getTime() || 0, Number(row.id) || 0];
    const current = byInvoice.get(id);
    const newer = !current || order[0] > current.order[0] || (order[0] === current.order[0] &&
      (order[1] > current.order[1] || (order[1] === current.order[1] && order[2] > current.order[2])));
    const everPaid = (current?.everPaid || false) || paidHistory(invoice) || PAID.has(invoice.status);
    const first = current ? Math.min(current.first, new Date(row.received_at).getTime()) : new Date(row.received_at).getTime();
    byInvoice.set(id, newer ? { order, body, invoice, everPaid, first } : { ...current, everPaid, first });
  }
  const invoices = [...byInvoice.entries()].map(([id, item]) => {
    const { invoice, body } = item;
    const products = Array.isArray(body.event?.products) ? body.event.products : body.event?.product ? [body.event.product] : [];
    const ids = [];
    for (const p of products) { if (p?.id) ids.push(String(p.id)); for (const o of Array.isArray(p?.offers) ? p.offers : []) if (o?.id) ids.push(String(o.id)); }
    const kinds = [...new Set(ids.map(pid => config.kinds.get(pid)).filter(Boolean))];
    const origin = sessionUtm(invoice);
    const outcome = item.everPaid ? "pago" : outcomeOf(invoice);
    const totalCents = Number.isInteger(invoice.amount?.totalCents) ? invoice.amount.totalCents : null;
    const created = Date.parse(invoice.createdAt);
    return {
      invoice: id.slice(0, 8),
      created_at: new Date(Number.isFinite(created) ? created : item.first).toISOString(),
      status: text(invoice.status, 40),
      payment_method: METHOD_LABEL[invoice.paymentMethod] || (text(invoice.paymentMethod, 40) || "não informado"),
      outcome, outcome_label: OUTCOME_LABEL[outcome],
      product: text(products[0]?.name, 120) || "Produto não informado",
      product_kind: kinds.length === 1 ? kinds[0] : kinds.length > 1 ? "varios" : "outro",
      amount: totalCents == null ? null : totalCents / 100,
      utm_source: origin.utm_source,
      utm_campaign: campaignName(origin.utm_campaign),
      has_click_id: Boolean(text(origin.params[config.clickParam], 200))
    };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const count = (list, key) => list.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] || 0) + 1; return acc; }, {});
  const front = invoices.filter(i => i.product_kind === "front");
  const campaigns = new Map();
  for (const item of front) {
    const fromAds = /^(fb|facebook|ig|instagram|meta)$/i.test(item.utm_source || "");
    const key = fromAds ? (item.utm_campaign || "Anúncio sem nome de campanha") : item.utm_source ? "Outra origem: " + item.utm_source : "Sem UTM no checkout";
    const row = campaigns.get(key) || { campaign: key, from_ads: fromAds, invoices: 0, paid: 0, paid_value: 0 };
    row.invoices++;
    if (item.outcome === "pago") { row.paid++; row.paid_value += item.amount || 0; }
    campaigns.set(key, row);
  }
  return {
    summary: {
      invoices: invoices.length,
      front_invoices: front.length,
      other_product_invoices: invoices.length - front.length,
      paid: front.filter(i => i.outcome === "pago").length,
      paid_value: front.filter(i => i.outcome === "pago").reduce((sum, i) => sum + (i.amount || 0), 0),
      by_outcome: count(front, "outcome_label"),
      by_method: count(front, "payment_method"),
      abandoned_checkouts: abandoned.size
    },
    campaigns: [...campaigns.values()].sort((a, b) => b.paid - a.paid || b.invoices - a.invoices),
    invoices
  };
}

function registerHublaCheckoutReport(app, pool) {
  app.get("/api/integrations/hubla/checkout-report", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set("Cache-Control", "no-store");
    const from = String(req.query.from || ""), to = String(req.query.to || "");
    if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || (from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) {
      return res.status(400).json({ ok: false, error: "periodo invalido (use AAAA-MM-DD)" });
    }
    try {
      // Periodo pelo dia de Sao Paulo em que o aviso chegou; padrao: ultimos 30 dias.
      const { rows } = await pool.query(`SELECT id, payload, received_at FROM dr_hubla_events
        WHERE sandbox = FALSE
          AND ($1::date IS NULL OR (received_at AT TIME ZONE 'America/Sao_Paulo')::date >= $1::date)
          AND ($2::date IS NULL OR (received_at AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date)
          AND ($1::date IS NOT NULL OR $2::date IS NOT NULL OR received_at >= NOW() - INTERVAL '30 days')
        ORDER BY id LIMIT 20000`, [from || null, to || null]);
      const first = (await pool.query("SELECT MIN(received_at) AS first FROM dr_hubla_events WHERE sandbox = FALSE")).rows[0].first;
      res.json({ ok: true, from: from || null, to: to || null, webhook_first_notice_at: first, ...buildCheckoutReport(rows) });
    } catch (error) {
      console.error("Relatorio de checkout Hubla falhou (" + (error.code || "erro interno") + ")");
      res.status(500).json({ ok: false, error: "erro interno" });
    }
  });
}

module.exports = { buildCheckoutReport, campaignName, registerHublaCheckoutReport };

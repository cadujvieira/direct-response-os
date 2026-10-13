// Reembolsos nos relatorios (decisao do titular 13/10/2026: vendas, receita, CPA e ROAS do painel sao liquidos).
// Cada evento ganha duas marcas:
// - front_refund: reembolso/chargeback de compra front (ou reembolso antigo sem pedido ligado). O valor sai da receita.
// - completes_refund: o reembolso que zerou a compra front (ultimo reembolso de um pedido devolvido por inteiro).
//   E esse evento que tira 1 da contagem de vendas. Reembolso parcial tira valor, nao venda.
// Reembolso de mentoria nao entra: a receita destes relatorios e so a front.
// Como o resto dos relatorios, conta pela data do proprio evento (o reembolso cai no dia em que aconteceu).
const EVENTS_TAGGED_CTE = `events_tagged AS (
  SELECT e.click_id, e.created_at, e.event_name, e.value,
    (e.event_name = 'refund' AND (f.kind IS NULL OR f.kind = 'front')) AS front_refund,
    COALESCE(e.event_name = 'refund' AND f.kind = 'front' AND f.refunded_value >= o.valor
      AND e.created_at = MAX(e.created_at) FILTER (WHERE e.event_name = 'refund') OVER (PARTITION BY f.order_id), FALSE) AS completes_refund
  FROM dr_events e
  LEFT JOIN dr_funnel_orders f ON e.event_name = 'refund' AND f.order_id = e.raw_payload->>'order_id'
  LEFT JOIN dr_orders o ON o.order_id = f.order_id
)`;
module.exports = { EVENTS_TAGGED_CTE };

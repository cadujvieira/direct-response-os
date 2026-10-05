# Checkout e pós-compra

Esta é a API canônica para uso entre servidores. O checkout escolhido é a Hubla; o adaptador dela está em `hublaWebhook.js` (ver `HUBLA_INTEGRATION.md`) e ainda não foi validado com avisos reais. Qualquer adaptador deve verificar a autenticidade do webhook e traduzir somente pagamentos aprovados/reembolsos confirmados para este contrato. Nunca envie o segredo administrativo para o navegador, URL de checkout ou metadados do comprador.

## Contrato protegido

- `GET /api/integrations/funnel/status`: estado do canal, contagem de eventos integrados e data da última recepção; não retorna contatos ou credenciais.
- `POST /api/integrations/funnel/events`: usa `x-admin-secret`, o mesmo guard administrativo do sistema. Chamadas somente pelo backend/adaptador confiável.
- `provider_connected: false` neste endpoint é intencional: eventos canônicos não provam conexão com o checkout. O estado real da Hubla fica em `GET /api/integrations/hubla/status`.

Campos comuns: `event_name`, `event_id`, `order_id`, `front_order_id`, `click_id`, `email`, `telefone`, `nome`, `produto`, `value`, `currency`, `occurred_at`, `payment_status`. Campos desconhecidos são rejeitados; payloads e tokens do provedor não devem ser repassados integralmente.

`occurred_at` é a hora real do evento, em ISO 8601 com fuso (`Z` ou `-03:00`), não a hora de recebimento. No máximo cinco minutos no futuro para tolerância de relógio. Os eventos são armazenados em UTC e os relatórios continuam usando os dias de São Paulo.

`value` está em reais, com até duas casas decimais, positivo para receita/reembolso. `currency: BRL` é obrigatório para valores financeiros. O adaptador deve converter centavos para reais quando essa for a unidade do checkout; nunca converter moeda implicitamente.

## Compra front

```json
{
  "event_name": "purchase",
  "order_id": "checkout:pedido-front-123",
  "click_id": "ID-capturado-pelo-router",
  "email": "comprador@example.test",
  "nome": "Comprador",
  "produto": "Oferta em dólar com IA",
  "value": 297,
  "currency": "BRL",
  "payment_status": "approved",
  "occurred_at": "2026-10-01T20:00:00-03:00"
}
```

Exige click conhecido e email ou telefone. Cria o lead se ainda não existir, copiando a origem capturada; contatos que apontem para leads diferentes geram conflito. Não inventa IDs de mídia nem escolhe um click por email. Um click de Google/orgânico também pode ser usado; continuará fora da coorte Meta.

Preserve `click_id` da LP nos metadados/campo rastreável do pedido. A forma exata depende do checkout escolhido. IDs de pedidos devem ter prefixo da plataforma para evitar colisões entre provedores.

## Call e oferta de mentoria

```json
{
  "event_name": "call_booked",
  "event_id": "agenda:call-456",
  "front_order_id": "checkout:pedido-front-123",
  "occurred_at": "2026-10-02T15:00:00-03:00"
}
```

Também suporta `call_attended`, `call_no_show` e `mentorship_offer`. Use o ID estável da call/ocorrência; a etapa entra na chave, permitindo registrar agendamento e presença da mesma call. Não há receita nesses eventos. O pedido front resolve o comprador e o click originais mesmo se o contato do CRM tiver sido editado.

`checkout_started` é anterior ao pedido pago: exige `click_id`, `event_id` estável e `occurred_at`, sem `order_id/front_order_id` e sem receita.

## Compra de mentoria

```json
{
  "event_name": "mentorship_purchase",
  "order_id": "checkout:pedido-mentoria-789",
  "front_order_id": "checkout:pedido-front-123",
  "value": 5000,
  "currency": "BRL",
  "payment_status": "approved",
  "occurred_at": "2026-10-03T16:00:00-03:00"
}
```

Mentoria e futuro `order_bump_purchase` possuem pedido próprio e usam `front_order_id`. Não entram como uma nova venda front. Um click recebido diferente do original é rejeitado. Sem pedido original integrado, retorna 409; o adaptador deve guardar e reenviar o evento depois de integrar a compra front.

## Reembolso

```json
{
  "event_name": "refund",
  "event_id": "checkout:reembolso-321",
  "order_id": "checkout:pedido-mentoria-789",
  "value": 500,
  "currency": "BRL",
  "payment_status": "refunded",
  "occurred_at": "2026-10-04T16:00:00-03:00"
}
```

Use o pedido reembolsado (front, mentoria ou bump) e o ID estável do reembolso, não um ID novo de entrega. `payment_status` aceita `refunded` (reembolso confirmado) ou `chargeback` (estorno definitivo pela operadora); solicitação de reembolso e disputa em aberto não são aceitas. Suporta reembolsos parciais distintos; sua soma não pode exceder o valor pago. O pedido recebe `partially_refunded` ou `refunded`. A receita líquida/LTV/CPA descontam o valor uma vez. O lifecycle CRM mantém a regra existente: qualquer evento de refund sinaliza o lead como `refunded`, inclusive reembolso parcial.

## Reenvios, ordem e falhas

- Pedido pago é deduplicado por tipo/pedido, mesmo que o provedor troque o ID de entrega.
- Calls e reembolsos usam etapa/pedido/ID de ocorrência. Repetir um ID com valor, origem ou horário diferente retorna 409.
- Click inexistente retorna 422; a captura/transferência do ID deve ser corrigida antes de reenviar.
- Calls, mentoria e refunds não podem ter horário anterior ao pedido de referência.
- Pedido, evento, vínculo do comprador, CRM, auditoria e fila de automações compartilham uma transação. Qualquer falha impede o ACK e reverte todas essas gravações; reenvie a mesma ocorrência após corrigir a causa.
- `dr_funnel_orders` e `dr_funnel_receipts` são tabelas adicionais. Pedidos/eventos legados são preservados; não são reatribuídos ou regravados silenciosamente.
- As rotas `/track/event` e `/track/purchase` continuam existindo e também usam gravação atômica. Elas mantêm o contrato de tracking público; o canal protegido acima é a entrada recomendada para o adaptador de pagamento.

## Homologação

O roteiro `validation/funnel.integration.js` testa o router, compra R$297, calls, mentoria, refunds, concorrência, falhas transacionais, CRM, LTV, CPA e decisões em PostgreSQL isolado. Ele só aceita `DR_VALIDATION_DATABASE_URL` em loopback com banco `oferta_validation`, e `DR_VALIDATION_BASE_URL` em loopback. Não usa produção para testes.

Para fechar a operação real ainda é necessário escolher checkout/agendamento, configurar os eventos e IDs de produtos no adaptador, confirmar taxas/impostos/split/custos e executar o teste oficial da plataforma. Os custos no staging não são confirmados automaticamente por esta homologação.

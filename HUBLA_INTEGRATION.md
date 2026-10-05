# Hubla → Oferta DR

Receptor dedicado dos webhooks da Hubla (`hublaWebhook.js`). Ele autentica, grava o aviso em uma caixa de entrada durável, responde, e só depois traduz para o contrato canônico de `FUNNEL_INTEGRATION.md`. Baseado na documentação pública da Hubla consultada em 04/10/2026 (payload `2.0.0`). Em 05/10/2026 o teste oficial da conta ("Testar configuração") foi recebido em staging: token, gravação e separação do sandbox confirmados. **Ainda não houve aviso de venda real**; pagamento, reembolso e devolução do `click_id` reais seguem sem comprovação.

## Configuração (somente variáveis de ambiente)

| Variável | Uso |
|---|---|
| `HUBLA_WEBHOOK_TOKEN` | "Hubla Webhook Token" (Integrações → Webhook → Autenticação). Sem ele o receptor responde 503. |
| `HUBLA_FRONT_PRODUCT_IDS` | IDs do produto e/ou da oferta front, separados por vírgula. |
| `HUBLA_MENTORSHIP_PRODUCT_IDS` | IDs do produto/oferta de mentoria (se for cobrada na Hubla). |
| `HUBLA_BUMP_PRODUCT_IDS` | Reservado. Avisos de bump ficam em revisão até o formato real ser confirmado. |
| `HUBLA_CLICK_ID_PARAM` | Nome do parâmetro do checkout que carrega o click. Padrão `click_id`. |

Nunca coloque o token no código, na URL do webhook, no dashboard ou em conversas.

Na Hubla, crie uma regra de webhook com:

- URL: `https://<serviço>/api/integrations/hubla/webhook`
- Eventos: **`invoice.status_updated`** (trilha financeira) e **`invoice.refunded`** (confirma reembolso total). Outros eventos são aceitos e ignorados.
- Produtos: front (e mentoria, se aplicável).
- Modo "Integração recomendada" ou "compatibilidade": produto é reconhecido pelo ID do produto **ou** da oferta, então os dois funcionam para venda de um produto. Venda com mais de um produto fica em revisão nos dois modos.

## Rotas

- `POST /api/integrations/hubla/webhook` — `x-hubla-token` obrigatório. 401 token inválido, 503 sem token configurado, 400 corpo sem `type`, 200 depois de gravar. `x-hubla-idempotency` identifica o aviso; `x-hubla-sandbox: true` marca teste.
- `GET /api/integrations/hubla/status` — `x-admin-secret`. Configuração (sem segredos), contagem por estado, sandbox separado, `provider_connected` (verdadeiro só após um aviso autenticado **fora** do sandbox), `payments_not_integrated` (faturas pagas que ainda não entraram no funil) e `reversals_not_integrated` (reembolsos/chargebacks recebidos e ainda não descontados).
- `GET /api/integrations/hubla/events?status=&sandbox=&limit=` — lista sem payload e sem dados pessoais.
- `POST /api/integrations/hubla/process` — processa a fila agora.
- `POST /api/integrations/hubla/events/:id/retry` — reabre um aviso pendente/em revisão.
- `POST /api/integrations/hubla/events/:id/resolve-refund` `{ "value": 100.50 }` — informa o valor conferido na Hubla de um reembolso sem valor no aviso.

## Regras de tradução

- **Trilha única**: só `invoice.status_updated` gera efeito financeiro. `invoice.payment_succeeded`, `invoice.created`, `invoice.expired`, `invoice.payment_failed`, `refund_request.*`, `subscription.*`, `smart_installment.*` são gravados como `ignored`. Assim a mesma transição nunca é contada por dois tipos de evento.
- **Pagamento**: existe venda quando o histórico `invoice.statusAt` contém `paid`. `unpaid`, `overdue` e `canceled` sem pagamento não geram receita. Qualquer outro status sem data de pagamento legível no histórico vai para revisão, nunca é ignorado. Cada aviso carrega o histórico completo, então um reembolso que chega antes do aviso de pagamento ainda cria a venda e depois a reverte.
- **Pedido**: `order_id = "hubla:" + invoice.id`. A deduplicação financeira é pelo pedido no livro canônico, não pelo `x-hubla-idempotency`.
- **Valor**: `(amount.totalCents − amount.installmentFeeCents) / 100`, em reais. Juros de parcelamento pagos pelo comprador não são receita do produtor. `amount.total` (reais, enviado desde 23/09/2026) serve apenas para conferir a unidade; divergência → revisão. Taxas da Hubla **não** são descontadas aqui (o CPA Máximo modela taxas sobre a venda bruta); o líquido do vendedor fica disponível no payload guardado para conciliação.
- **Horário**: `when` do status no histórico (primeiro `paid`; último `refunded`/`chargeback`), não o horário de recebimento.
- **Produto**: pelo ID em `event.product.id`, `event.products[].id` ou `event.products[].offers[].id`. Nunca por nome ou por valor R$297. Sem mapeamento → `unmapped_product` (reprocessado a cada reinício do serviço, depois de configurar o ID).
- **click_id**: lido de `invoice.paymentSession.params.<click_id>` (ou da query string de `paymentSession.url`). Sem click, ou com click que não existe em `dr_clicks`, a compra front fica `pending_attribution`: o pagamento é preservado e visível, mas não entra em receita/LTV/CPA. Nenhum click é criado e nada é atribuído por email, nome ou UTM.
- **Mentoria**: pedido próprio ligado ao front pelo `payerId` da Hubla. Exatamente um front integrado para o comprador → vincula. Nenhum → `pending_front_order`. Mais de um → `needs_review`.
- **Reembolso**: a Hubla envia `invoice.refunded` apenas no reembolso total e não informa o valor no parcial. Com `invoice.refunded` recebido → desconta o saldo do pedido uma vez. Sem ele, espera 30 min (`pending_refund_confirmation`) e então vai para `needs_review` sem descontar nada, até alguém informar o valor em `resolve-refund`.
- **Disputa** (`disputed`): registrada, sem desconto. Disputa ganha (`disputed → paid`) mantém a venda.
- **Chargeback**: estorno definitivo. Lançado como `refund` canônico com `payment_status: "chargeback"` pelo saldo do pedido, ID `hubla:<fatura>:chargeback`. Reembolso + chargeback do mesmo pedido nunca passam do valor pago.
- **Revisão em vez de palpite** (`needs_review`): venda com mais de um produto, fatura filha (`parentInvoiceId`), parcela 2+ de parcelamento inteligente, `type` diferente de `sell`, moeda diferente de BRL ou liquidação em outra moeda, valores inválidos, conflito com o livro canônico, fatura que volta a `paid` depois de revertida, `invoice.refunded` com fatura em outro status, histórico de status ilegível.
- **Sandbox**: avisos com `x-hubla-sandbox: true` são gravados com `sandbox = true`, apenas lidos (o motivo mostra tipo, valor e se havia click) e **nunca** tocam `dr_orders`, `dr_events` ou leads.

## Durabilidade

Tabela `dr_hubla_events` (aditiva). O ACK 200 só sai depois do `INSERT`. A Hubla tenta 5 vezes em ~10 minutos e não garante ordem; por isso o processamento é independente da entrega: worker a cada 30 s, `FOR UPDATE SKIP LOCKED`, trava por fatura, recuperação de avisos presos em `processing` (>5 min) e novas tentativas com espera crescente (1 min até 6 h, 12 tentativas automáticas; depois, somente manual). O lançamento canônico é uma transação própria e idempotente; nenhuma chamada externa acontece dentro dela. Quando um pedido entra no funil, avisos da mesma fatura e mentorias do mesmo comprador que tinham esgotado as tentativas voltam para a fila. A mesma chave `x-hubla-idempotency` com conteúdo diferente é guardada como aviso próprio, não descartada.

O payload é guardado sem documento (CPF/CNPJ), endereço, IP, user agent e contatos de recebedores. Logs registram apenas o ID interno do aviso e o código do erro.

## click_id da LP até o checkout

`/go/:slug` entrega `click_id` na URL da LP. A LP precisa repassá-lo ao link do checkout como `?click_id=...`. O script `GET /assets/dr-checkout.js` faz isso para links de `pay.hub.la`/`hub.la`: guarda o click e as UTMs da entrada e completa os links (sem sobrescrever UTMs já presentes e sem criar click quando ele não veio). O click fica guardado por 7 dias para páginas seguintes do mesmo funil, mas uma visita que chega com UTMs/`gclid`/`fbclid` e sem `click_id` não reaproveita o click antigo. Atributos opcionais na tag: `data-checkout-hosts`, `data-click-param`.

Não coberto: checkout embutido em iframe, botões que redirecionam por JavaScript sem link, e funis em que a LP fica em um domínio e o botão em outro (o click precisa estar na URL da página do botão).

**A confirmar com compra real**: a documentação afirma que qualquer parâmetro da URL do checkout aparece em `paymentSession.params`, mas o sandbox usa valores fictícios. Só uma fatura real mostra se `click_id` volta no aviso.

## Formato observado no teste oficial (05/10/2026)

- A regra está em "Integração recomendada": `event.product.id` traz o ID da **oferta** e `event.products[].id` o ID do **produto**; cada oferta traz `amountCents` e `isOrderBump`. Configure os dois IDs em `HUBLA_FRONT_PRODUCT_IDS` para cobrir outras ofertas do mesmo produto.
- O teste usa o produto real da conta, com `invoice.id`, `orderId` e `payerId` terminados em `-tester`. O receptor trata esse sufixo como sandbox mesmo se o cabeçalho `x-hubla-sandbox` faltar.
- `invoice.refunded` de teste chega com histórico `unpaid → refunded`, sem `paid`, todos com o mesmo horário. É dado fictício; o receptor classifica como revisão (`missing_paid_history`). Se um reembolso real chegar assim, ele também vai para revisão em vez de ser descontado.
- `paymentSession` de teste não traz `url` nem `cookies`; `params` traz `src` e `sck`. `payer.phone` veio sem código do país; não há campo `document`.

## Limitações conhecidas

1. Formato real dos avisos (modo recomendado, order bump, parcelamento inteligente, reembolso parcial) ainda não observado.
2. Parcelas 2+ do parcelamento inteligente não entram como receita (ficam em revisão). Relevante se a mentoria for vendida assim.
3. `checkout_started` não é gerado a partir da Hubla.
4. Compras front sem click ficam fora de receita/LTV/CPA por decisão de contrato.
5. As pendências aparecem só pela API administrativa; ainda não há tela no dashboard.

## Homologação local

`validation/hubla.integration.js` (mesmas travas do roteiro do funil: banco `oferta_validation` e HTTP em loopback). A aplicação sob teste precisa de `HUBLA_WEBHOOK_TOKEN` igual a `DR_VALIDATION_HUBLA_TOKEN` (prefixo `hubla-validation-`), `HUBLA_FRONT_PRODUCT_IDS=qa-front-product,qa-front-offer` e `HUBLA_MENTORSHIP_PRODUCT_IDS=qa-mentor-product`.

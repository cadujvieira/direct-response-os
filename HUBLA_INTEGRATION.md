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
- **click_id**: lido de `invoice.paymentSession.params.<click_id>` (ou da query string de `paymentSession.url`). Sem click, ou com click que não existe em `dr_clicks`, a compra front fica `pending_attribution`: o pagamento é preservado e visível, mas não entra em receita/LTV/CPA. Um click só é criado pela recuperação descrita em "click_id sem redirecionamento"; nada é atribuído por email, nome ou valor.
- **Mentoria**: pedido próprio ligado ao front pelo `payerId` da Hubla. Exatamente um front integrado para o comprador → vincula. Nenhum → `pending_front_order`. Mais de um → `needs_review`.
- **Reembolso**: a Hubla envia `invoice.refunded` apenas no reembolso total e não informa o valor no parcial. Com `invoice.refunded` recebido → desconta o saldo do pedido uma vez. Sem ele, espera 30 min (`pending_refund_confirmation`) e então vai para `needs_review` sem descontar nada, até alguém informar o valor em `resolve-refund`.
- **Disputa** (`disputed`): registrada, sem desconto. Disputa ganha (`disputed → paid`) mantém a venda.
- **Chargeback**: estorno definitivo. Lançado como `refund` canônico com `payment_status: "chargeback"` pelo saldo do pedido, ID `hubla:<fatura>:chargeback`. Reembolso + chargeback do mesmo pedido nunca passam do valor pago.
- **Revisão em vez de palpite** (`needs_review`): venda com mais de um produto, fatura filha (`parentInvoiceId`), parcela 2+ de parcelamento inteligente, `type` diferente de `sell`, moeda diferente de BRL ou liquidação em outra moeda, valores inválidos, conflito com o livro canônico, fatura que volta a `paid` depois de revertida, `invoice.refunded` com fatura em outro status, histórico de status ilegível.
- **Sandbox**: avisos com `x-hubla-sandbox: true` são gravados com `sandbox = true`, apenas lidos (o motivo mostra tipo, valor e se havia click) e **nunca** tocam `dr_orders`, `dr_events` ou leads.

## Durabilidade

Tabela `dr_hubla_events` (aditiva). O ACK 200 só sai depois do `INSERT`. A Hubla tenta 5 vezes em ~10 minutos e não garante ordem; por isso o processamento é independente da entrega: worker a cada 30 s, `FOR UPDATE SKIP LOCKED`, trava por fatura, recuperação de avisos presos em `processing` (>5 min) e novas tentativas com espera crescente (1 min até 6 h, 12 tentativas automáticas; depois, somente manual). O lançamento canônico é uma transação própria e idempotente; nenhuma chamada externa acontece dentro dela. Quando um pedido entra no funil, avisos da mesma fatura e mentorias do mesmo comprador que tinham esgotado as tentativas voltam para a fila. A mesma chave `x-hubla-idempotency` com conteúdo diferente é guardada como aviso próprio, não descartada.

O payload é guardado sem documento (CPF/CNPJ), endereço, IP, user agent e contatos de recebedores. Logs registram apenas o ID interno do aviso e o código do erro.

## click_id sem redirecionamento (tag das páginas)

Os anúncios apontam direto para as páginas. O servidor do Oferta DR não fica no caminho do visitante; se ele cair, página e venda seguem normais.

A tag (`checkoutLinks.js`, servida em `GET /assets/dr-checkout.js` ou colada inteira no GTM com o endereço fixo no lugar de `__DR_ENDPOINT__`):

1. Usa o `click_id` da URL quando ele vem (router ou link entre domínios próprios) e está em formato válido.
2. Sem `click_id` na URL, cria um (`dr_` + UUID) e guarda por 7 dias em `localStorage`, com cookie da própria página como reserva.
3. Mesma origem (mesmos UTMs/IDs/`fbclid`/`gclid`) em outra página = mesmo clique. Origem diferente = outro clique. URL sem nada = reaproveita o guardado.
4. Avisa `POST /track/click` em segundo plano, uma vez por clique; se falhar, tenta na próxima página. Nada bloqueia a página.
5. Acrescenta `click_id`, UTMs e IDs aos links de `pay.hub.la`/`hub.la` e aos links para outro domínio próprio, também no momento do clique (botões liberados pelo vídeo).

No servidor:

- `POST /track/click` é público, valida formato e tamanho, tem limite de volume por origem e geral, e **nunca troca a origem de um clique existente**. UTMs e IDs de mídia são um bloco único: só entram em um clique que ainda não tem nenhuma origem. O router (`/go/:slug`) segue a mesma regra.
- IDs de campanha, conjunto e anúncio vêm de `campaign_id`/`adset_id`/`ad_id` ou, na falta deles, do padrão da UTMify `nome|id` em `utm_campaign`/`utm_medium`/`utm_content`. Nada é deduzido de nomes sem o sufixo numérico.
- **Recuperação pelo checkout**: se a venda chega com um `click_id` no formato da tag que não está em `dr_clicks`, o receptor cria o clique com o que o checkout devolveu em `paymentSession` (UTMs, IDs, `fbclid`/`gclid`), com `capture_source = 'checkout_recovered'` e horário da criação da fatura. Um `click_id` em outro formato continua como `pending_attribution`. Nada é atribuído por email, nome ou valor.
- `dr_clicks.capture_source`: `tag`, `router`, `checkout_recovered` ou `legacy`.

Consequências conhecidas: cliques sem compra ficam subcontados quando o navegador bloqueia o aviso; uma URL com `click_id` compartilhada entre pessoas faz todas usarem o mesmo clique; UTMs internas em links entre páginas iniciam outro clique.

Comprovado em 05/10/2026 com compra real: a Hubla devolve em `paymentSession.params` os parâmetros da URL do checkout, inclusive `click_id`.

Não coberto: checkout embutido em iframe e botões que redirecionam por JavaScript sem link.

## Formato observado no teste oficial (05/10/2026)

- A regra está em "Integração recomendada": `event.product.id` traz o ID da **oferta** e `event.products[].id` o ID do **produto**; cada oferta traz `amountCents` e `isOrderBump`. Configure os dois IDs em `HUBLA_FRONT_PRODUCT_IDS` para cobrir outras ofertas do mesmo produto.
- O teste usa o produto real da conta, com `invoice.id`, `orderId` e `payerId` terminados em `-tester`. O receptor trata esse sufixo como sandbox mesmo se o cabeçalho `x-hubla-sandbox` faltar.
- `invoice.refunded` de teste chega com histórico `unpaid → refunded`, sem `paid`, todos com o mesmo horário. É dado fictício; o receptor classifica como revisão (`missing_paid_history`). Se um reembolso real chegar assim, ele também vai para revisão em vez de ser descontado.
- `paymentSession` de teste não traz `url` nem `cookies`; `params` traz `src` e `sck`. `payer.phone` veio sem código do país; não há campo `document`.

## Limitações conhecidas

1. Formato real dos avisos (modo recomendado, order bump, parcelamento inteligente, reembolso parcial) ainda não observado.
2. Parcelas 2+ do parcelamento inteligente não entram como receita (ficam em revisão). Relevante se a mentoria for vendida assim.
3. `checkout_started` não é gerado a partir da Hubla.
4. Compras front sem `click_id`, ou com `click_id` fora do formato da tag e desconhecido, ficam fora de receita/LTV/CPA até serem resolvidas.
5. As pendências aparecem na aba Integrações do dashboard (`hublaDashboard.js`), com as ações de tentar de novo e informar valor de reembolso.

## Homologação local

`validation/hubla.integration.js` (mesmas travas do roteiro do funil: banco `oferta_validation` e HTTP em loopback). A aplicação sob teste precisa de `HUBLA_WEBHOOK_TOKEN` igual a `DR_VALIDATION_HUBLA_TOKEN` (prefixo `hubla-validation-`), `HUBLA_FRONT_PRODUCT_IDS=qa-front-product,qa-front-offer` e `HUBLA_MENTORSHIP_PRODUCT_IDS=qa-mentor-product`.

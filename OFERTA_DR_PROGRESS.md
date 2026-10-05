# Oferta DR — registro de progresso

Registro vivo das pendências do handoff de 04/10/2026. Atualize a cada entrega.

## Estado atual (05/10/2026)

- Staging publicado com `ca6ac08` em 04/10 (deploy manual pelo dashboard do Render; o serviço não tem auto-deploy).
- No Render do staging: `HUBLA_WEBHOOK_TOKEN` e `HUBLA_FRONT_PRODUCT_IDS` configurados (oferta `HC0TaiMJfWxtvfCzBISz`).
- Regra de webhook criada na Hubla (produto "MMD | Make Money in Dollar", eventos `invoice.status_updated` e `invoice.refunded`) apontando para o staging.
- Conferido no endereço real: 503 antes do token, 401 sem token depois dele, rotas administrativas 401 sem senha, script da LP 200.
- Teste oficial da Hubla recebido: 4 avisos, todos gravados como sandbox, nenhum pedido criado. `provider_connected` segue falso (nenhum aviso real).
- ID do produto observado no aviso: `E2BQDamsTpmOHKIqPLde` (a oferta é `HC0TaiMJfWxtvfCzBISz`).

### Decisão revista (05/10/2026): router para dividir tráfego entre LPs

- O Carlos precisa que o router divida o tráfego entre LPs de ângulos diferentes e que o painel mostre qual performa melhor. A opção sem redirecionamento deixa de ser o caminho principal e vira rede de segurança (a tag cria o `click_id` se o visitante chegar sem ele).
- Entregue: router que redireciona mesmo com o banco lento ou fora do ar (`resilientRouter.js`), desempenho por LP na aba Router com filtro de período e leitura estatística cautelosa, `GET /api/router/health`.
- Proteções ainda pendentes: instância paga do serviço de produção (o banco já está pago), subdomínio próprio para o router, monitoramento externo com alerta, `DR_ROUTER_FALLBACK_URL` em produção.
- Risco residual aceito e comunicado: se a Render inteira cair, os cliques dos anúncios falham até ela voltar.
- Alternativa explicada ao Carlos: um anúncio por ângulo apontando direto para a página do ângulo, deixando a Meta distribuir. Ele preferiu o router.

### Decisão de arquitetura anterior (05/10/2026): sem redirecionamento

- Requisito do Carlos: nada pode tirar o caminho do anúncio do ar. Decisão: os anúncios apontam direto para as páginas; a tag cria o `click_id`; o Oferta DR sai do caminho do visitante. O router continua no sistema, sem uso em anúncios.
- Plano de ida para produção revisado pelo Carlos em documento próprio (Claude Docs, "Oferta DR — plano de ida para produção").
- Entregue nesta etapa: tag versão 2, `POST /track/click` endurecido, recuperação do clique pelo checkout, rotas antigas de receita com senha, painel de pendências da Hubla.
- Testes: unitários completos, `validation/hubla.integration.js` (10 grupos), `validation/funnel.integration.js` (7 grupos), tag em Chromium real (12 cenários), painel conferido em desktop e celular. Revisão independente feita; achados de atribuição corrigidos.
- Produção na Render: serviço e banco estão no plano gratuito. **O banco de produção expira em 29/10/2026** se não for para plano pago. O Carlos vai contratar.
- Pendente: publicar no staging, testar a tag versão 2 nas páginas reais, Black Track trocar a tag no GTM, aprovação de produção.

### Compra real controlada (05/10/2026, staging)

- Router `teste-hubla` (staging) → checkout da Hubla com `click_id` → Pix de R$297 pago pelo titular.
- Avisos reais: `invoice.status_updated` unpaid (ignorado) e paid (pedido front R$297, lead criado, origem e `click_id` do acesso real). **A Hubla devolve o `click_id` em `paymentSession.params`.**
- Reembolso total pelo vendedor: `invoice.status_updated` refunded + `invoice.refunded` chegaram juntos; desconto de R$297 aplicado uma única vez; lead em `refunded`; líquido zero.
- Histórico real veio completo (unpaid → paid → refunded). `provider_connected` passou a verdadeiro.
- Não observado em caso real: solicitação de reembolso pelo comprador, reembolso parcial, cartão parcelado, disputa, chargeback, parcelamento inteligente.

### LPs e rastreamento (05/10/2026)

- `felipelona-vsl.com` (Hostinger, HTML): `/ig/` e a VSL já repassam toda a query string, inclusive `click_id`, até o link do checkout. Conferido: router `teste-vsl` → `/ig/` → VSL com o mesmo `click_id`. O último clique (VSL → checkout) foi confirmado pela leitura do código, não por clique.
- `felipelona.com/vsl-NN` (HospedaInfo, WordPress + Elementor): o botão de compra só leva `sck`; `click_id` e UTMs não chegam ao checkout. Precisa do script.
- Script entregue para instalação por tag de HTML personalizado no GTM `GTM-TCM58X4P` (container gerido pela Black Track) ou pelo rodapé do WordPress. Instalação pendente de terceiros.
- Informado pelo Carlos: somente a Black Track envia Purchase para a Meta, e ela recebe a compra por webhook da Hubla. Eventos da Black Track: PageView, InitiateCheckout, Purchase. O Oferta DR não envia nada para a Meta.
- Carregados nas páginas de `felipelona.com`: GTM, pixel Meta, pixel UTMify, Stape, Vturb.
- Pendente de decisão: domínio próprio para o router (evitar `onrender.com` em anúncios).

## Estado em 04/10/2026

- Branch de trabalho: `feature/offer-crm-experiments`, a partir de `5f51f33` (igual ao último staging confirmado).
- Checkout restaurado por clone do GitHub. Os caminhos antigos no Mac não foram inspecionados; o remoto já continha o último commit confirmado, então nada indicava trabalho local faltando.
- Produção (`main`, `6a277a0`) não foi tocada.

## Etapa A — ambiente e auditoria: concluída

- Lidos `CLAUDE.md`, `OFFER_ARCHITECTURE.md`, `FUNNEL_INTEGRATION.md`, `package.json`. Não existe `AGENTS.md`.
- 125/125 testes unitários reproduzidos antes de qualquer mudança; `validation/funnel.integration.js` reproduzido em PostgreSQL 16 local isolado.

## Etapa B — receptor Hubla: implementado e testado localmente; falta publicar e validar com a Hubla

Entregue (detalhes em `HUBLA_INTEGRATION.md`):

- `POST /api/integrations/hubla/webhook` com `x-hubla-token`, caixa de entrada durável `dr_hubla_events`, ACK após gravar, worker com novas tentativas.
- Trilha financeira única (`invoice.status_updated`) + `invoice.refunded` como confirmação de reembolso total.
- Produto por ID, valor em centavos → reais sem juros de parcelamento, horário real do status.
- Pendências auditáveis: sem click, front ausente, produto sem mapeamento, reembolso sem valor, casos ambíguos.
- Chargeback como reversão definitiva no contrato canônico (`payment_status: "chargeback"`); disputa não desconta.
- Sandbox separado, somente leitura.
- Rotas administrativas: status, lista, processar, retry, resolve-refund.

Testes executados nesta entrega:

- `npm test`: 148/148 (23 novos em `hublaWebhook.test.js`).
- `validation/hubla.integration.js`: 9 grupos em PostgreSQL local (avisos **sintéticos** no formato publicado).
- `validation/funnel.integration.js`: 7 grupos, sem regressão.
- Revisão independente do código; os achados de perda silenciosa de valor foram corrigidos e cobertos por teste.

Não feito / não comprovado:

- Nenhum aviso de venda real foi recebido. `provider_connected` continua falso até isso acontecer.
- O push é feito pelo Mac do Carlos (esta sessão não tem permissão de escrita no repositório); o deploy de staging é manual.

## Etapa C — click_id: parcialmente concluída

- Router → LP: já preservava `click_id` (coberto pelos roteiros).
- LP → checkout: novo `GET /assets/dr-checkout.js`, testado em navegador real (Chromium) com 5 cenários.
- Checkout → webhook: receptor lê `paymentSession.params.click_id`. **Depende de confirmação com uma compra real**; a documentação afirma que qualquer parâmetro da URL é devolvido, o sandbox não comprova.
- Não iniciado: Hubla → UTMify (separação front/mentoria), Black Track.

## Etapas D, E, F: não iniciadas

Dependem das informações abaixo.

## Depende do Carlos

1. Compra real controlada pelo titular (router → LP → checkout com `click_id`), seguida de reembolso, para confirmar o `click_id` no aviso e o formato real de pagamento e reembolso.
2. Acrescentar o ID do produto `E2BQDamsTpmOHKIqPLde` em `HUBLA_FRONT_PRODUCT_IDS`.
3. Informar o que está ativo na Hubla em Pixels/API de Conversões e na integração UTMify.
4. A mentoria será cobrada na Hubla? Com parcelamento inteligente?
5. Documentação/instruções da Black Track.
6. Ferramenta de agenda e como registrar presença/no-show.
7. Custos reais (taxas, impostos, split, custos variáveis) e objetivo econômico.
8. Onde ficam as LPs (para instalar o script) e se o checkout é aberto por link ou embutido.

## Decisões técnicas que precisam de confirmação

- Receita da venda = valor cobrado menos juros de parcelamento do comprador; taxas da Hubla ficam para o modelo de custos (evita descontar duas vezes).
- Compra front sem click não entra em receita/LTV/CPA; fica pendente e visível.
- Parcelas 2+ de parcelamento inteligente ficam em revisão (não somam receita ainda).
- Reembolso parcial exige informar o valor manualmente, porque a Hubla não o envia no aviso.

## Riscos observados fora do escopo desta entrega

- `/track/purchase`, `/track/event`, `/track/click` e `/track/spend` são públicas e sem autenticação. Qualquer pessoa que conheça a URL pode gravar compras ou gasto. Auditar antes da liberação operacional (handoff §5).
- `GET /` devolve `error.message` do banco em caso de falha.
- As pendências da Hubla só aparecem pela API; falta uma tela no dashboard.

## Próximos passos técnicos

1. (feito) Publicar em staging e conferir 401/503/200 no endereço real.
2. (feito) Disparar "Testar configuração" na Hubla e conferir a leitura dos avisos do sandbox.
3. Compra real controlada (pelo titular) para confirmar `click_id` em `paymentSession.params` e o formato real do aviso.
4. Ajustar o receptor ao formato real (modo recomendado, bump, parcelamento, reembolso parcial).
5. Tela de pendências da Hubla no dashboard.
6. Hubla → UTMify e Black Track (Etapa C), depois D, E, F.

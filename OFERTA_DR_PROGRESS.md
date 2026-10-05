# Oferta DR — registro de progresso

Registro vivo das pendências do handoff de 04/10/2026. Atualize a cada entrega.

## Estado atual (04/10/2026)

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

- Nenhum aviso real ou do sandbox oficial da Hubla foi recebido. `provider_connected` continua falso até isso acontecer.
- Não publicado em staging: esta sessão não tem permissão de push no repositório nem acesso de rede ao Render.

## Etapa C — click_id: parcialmente concluída

- Router → LP: já preservava `click_id` (coberto pelos roteiros).
- LP → checkout: novo `GET /assets/dr-checkout.js`, testado em navegador real (Chromium) com 5 cenários.
- Checkout → webhook: receptor lê `paymentSession.params.click_id`. **Depende de confirmação com uma compra real**; a documentação afirma que qualquer parâmetro da URL é devolvido, o sandbox não comprova.
- Não iniciado: Hubla → UTMify (separação front/mentoria), Black Track.

## Etapas D, E, F: não iniciadas

Dependem das informações abaixo.

## Depende do Carlos

1. Publicação: autorizar o repositório nesta sessão (ou fazer o push pelo Mac) para a branch chegar ao staging.
2. No Render (staging), configurar `HUBLA_WEBHOOK_TOKEN`, `HUBLA_FRONT_PRODUCT_IDS` e, se aplicável, `HUBLA_MENTORSHIP_PRODUCT_IDS`. O token não deve ser colado em conversas.
3. Link do checkout e IDs reais do produto/oferta front na Hubla.
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

1. Publicar em staging e conferir 401/503/200 no endereço real.
2. Disparar "Testar configuração" na Hubla e conferir a leitura dos avisos do sandbox em `/api/integrations/hubla/events?sandbox=true`.
3. Compra real controlada (pelo titular) para confirmar `click_id` em `paymentSession.params` e o formato real do aviso.
4. Ajustar o receptor ao formato real (modo recomendado, bump, parcelamento, reembolso parcial).
5. Tela de pendências da Hubla no dashboard.
6. Hubla → UTMify e Black Track (Etapa C), depois D, E, F.

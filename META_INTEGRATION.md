# Integração Meta Ads

Esta integração prepara o Direct Response OS para importar automaticamente investimento, impressões e cliques da Meta Ads para a tabela `dr_ad_spend`.

## Estado atual

A infraestrutura de sincronização fica pronta no código, mas nenhuma chamada real à Meta é feita sem credenciais válidas.

O agendamento automático também fica propositalmente desativado até:
1. a BM/Business estar disponível;
2. a conta de anúncios estar vinculada e acessível;
3. o primeiro sync manual ser validado;
4. a atribuição campanha/conjunto/anúncio ser conferida no dashboard.

## Variáveis de ambiente necessárias

Configure no Render apenas quando a autorização estiver pronta:

- `META_ACCESS_TOKEN`
- `META_AD_ACCOUNT_ID`
- `META_API_VERSION`
- `META_SYNC_SECRET`

Nunca grave valores reais dessas variáveis no repositório.

### META_AD_ACCOUNT_ID

Pode ser informado com ou sem o prefixo `act_`.
O código normaliza automaticamente para o formato usado pela Graph API.

### META_API_VERSION

Deve ser informada explicitamente no ambiente.
O código não fixa uma versão da Graph API para evitar ficar preso a uma versão desatualizada.

## O que será necessário na Meta

Quando a BM estiver pronta, será necessário ter:

- acesso ao Business/BM;
- acesso à conta de anúncios que será sincronizada;
- ID da conta de anúncios;
- um access token adequado para leitura de anúncios/insights;
- capacidade de leitura dos dados de Ads da conta;
- uma versão da Graph API definida para a operação;
- conta de anúncios em BRL no MVP atual;
- preferência por uma conta de anúncios dedicada a esta oferta, cuja aquisição será escalada somente no Brasil.

Para operação estável, prefira um fluxo de token de longa duração ou system user adequado ao Business, em vez de um token manual temporário.

A permissão exata deve ser validada no momento da autorização conforme o tipo de ativo/Business utilizado.

## Rotas preparadas

### GET /integrations/meta/status

Retorna somente o estado de configuração, por exemplo:

```json
{
  "ok": true,
  "provider": "meta",
  "service": "meta_ads",
  "has_access_token": false,
  "has_ad_account": false,
  "has_api_version": false,
  "has_sync_secret": false,
  "configured": false
}
```

Nenhuma credencial é retornada.

### POST /integrations/meta/sync

Executa a sincronização manual.

Header obrigatório:

```
x-sync-secret: <META_SYNC_SECRET>
```

Body opcional:

```json
{
  "from": "2026-09-29",
  "to": "2026-09-30"
}
```

Se nenhuma data for enviada, o sync usa ontem até hoje no fuso `America/Sao_Paulo`.

A importação trabalha em nível de anúncio e solicita diariamente:

- campanha;
- conjunto;
- anúncio;
- investimento;
- impressões;
- cliques.

Cada linha é gravada usando o mesmo upsert/idempotência já usado pelo endpoint manual `/track/spend`.

## Segurança

- o token Meta nunca deve aparecer em logs ou respostas;
- o endpoint de sync exige `META_SYNC_SECRET`;
- o sync recusa chamadas concorrentes na mesma instância;
- chamadas à Meta possuem timeout;
- paginação possui limite de segurança;
- erros da Meta são sanitizados antes de chegar ao cliente;
- linhas malformadas da Meta são ignoradas sem contaminar as linhas válidas.

## Próxima etapa quando a BM estiver disponível

1. Obter/validar acesso ao Business e à conta de anúncios.
2. Gerar a credencial apropriada.
3. Configurar as quatro variáveis no Render.
4. Conferir `GET /integrations/meta/status`.
5. Fazer um primeiro sync manual de um período curto.
6. Conferir campanha, conjunto, anúncio, gasto, impressões e cliques no dashboard.
7. Somente depois habilitar automação/cron.

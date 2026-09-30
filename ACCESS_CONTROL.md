# Acesso, perfis e operação Brasil

## Objetivo

O Direct Response OS terá dois tipos de acesso:

- **Administrador**: controla usuários, permissões, custos manuais e integrações.
- **Cliente / Viewer**: consulta os indicadores e detalhamentos, sem permissão de alteração.

Todos os usuários desta fase enxergam a mesma operação. Ainda não existe isolamento por múltiplas ofertas/tenants.

## Mercado da operação

A aquisição e a venda desta oferta acontecem somente no Brasil.

Padrões do painel:
- mercado: Brasil;
- moeda: BRL;
- locale: pt-BR;
- fuso de relatório: America/Sao_Paulo.

A oferta pode ensinar o lead a escalar internacionalmente, mas isso não altera o mercado de aquisição do próprio produto.

## Primeiro administrador

Antes de publicar o login em produção, configurar no Render:

- `DR_ADMIN_NAME`
- `DR_ADMIN_EMAIL`
- `DR_ADMIN_PASSWORD`

Regras:
- senha mínima de 10 caracteres;
- valores reais nunca entram no repositório;
- o bootstrap cria o administrador apenas se o e-mail ainda não existir;
- reiniciar o serviço não redefine a senha de um administrador existente.

Depois do primeiro login, novos clientes são criados pelo próprio painel de administração.

Depois que o administrador inicial tiver sido criado e o login validado, `DR_ADMIN_PASSWORD` pode ser removida do ambiente. O usuário já persistido no banco continuará funcionando normalmente e não terá a senha redefinida em reinícios.

## Segurança implementada

- senhas com hash `scrypt` e salt aleatório;
- sessão aleatória armazenada no banco somente como hash SHA-256;
- cookie HttpOnly;
- SameSite=Lax;
- Secure em produção;
- sessão com validade de 7 dias;
- logout destrói a sessão no servidor;
- desativar um usuário encerra todas as sessões dele;
- redefinir senha encerra todas as sessões desse usuário;
- proteção contra remoção do último administrador ativo;
- limite simples de tentativas de login por IP/e-mail;
- respostas de autenticação não expõem hash de senha nem token de sessão.

## Rotas de acesso

Públicas:
- `GET /login`
- `GET /auth/status`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /health`

Autenticadas:
- `GET /dashboard`
- `GET /api/me`
- `GET /api/summary`
- `GET /api/campaigns`
- `GET /api/adsets`
- `GET /api/ads`

Somente administrador:
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PATCH /api/admin/users/:id`
- `POST /api/admin/users/:id/password`
- `GET /integrations/meta/status`
- `POST /track/spend`

A sincronização automática da Meta continua protegida pelo segredo próprio de integração e não depende do login do navegador.

## Tooltips

O ícone `?` usado no dashboard é chamado de **tooltip**.

Os tooltips devem:
- explicar o indicador em português claro;
- ser curtos o suficiente para leitura rápida;
- aparecer em hover, foco e toque/clique;
- funcionar fora de áreas com scroll sem serem cortados;
- nunca expor dados sensíveis;
- acompanhar novos KPIs adicionados ao dashboard.

## Checklist antes de liberar aos clientes

1. Configurar o administrador inicial no Render.
2. Validar login e logout em produção.
3. Criar um usuário Viewer de teste.
4. Confirmar que Viewer recebe 403 nas rotas administrativas.
5. Confirmar que Viewer vê o dashboard, filtros e breakdowns normalmente.
6. Validar responsividade mobile.
7. Somente depois criar acessos reais para clientes.

# Direct Response OS - Engineering Guide

## Project
Direct Response OS is a Node.js/Express/PostgreSQL tracking and performance system for direct-response funnels.

Production service:
- API: https://direct-response-api.onrender.com
- Dashboard: https://direct-response-api.onrender.com/dashboard
- Runtime: Render
- Repository branch: main

Never put credentials, tokens, DATABASE_URL values, or provider secrets in source code or documentation.

## Current architecture
- `index.js`: Express API, PostgreSQL initialization, tracking and reporting routes.
- `dashboard.html`: dependency-free dashboard (HTML/CSS/vanilla JS).
- PostgreSQL via `pg`.
- `dotenv` for local environment variables.
- Render auto-deploys from GitHub main.

Keep this architecture unless there is a strong reason to change it.

## Change workflow
- Never commit, push, merge, or deploy unless the supervising agent explicitly asks.
- Prefer feature branches/worktrees for implementation.
- Review the diff and run validation before anything reaches `main`.
- Production mutation endpoints must not be used for tests.

## Existing tracking contract
Working routes that must not regress:
- GET `/`
- GET `/health`
- GET `/api/summary`
- GET `/api/campaigns`
- GET `/dashboard`
- POST `/track/click`
- POST `/track/lead`
- POST `/track/event`
- POST `/track/purchase`
- POST `/track/spend`

Core funnel:
`click -> lead -> checkout_started -> purchase`

Attribution uses `click_id`.
Purchase idempotency uses `order_id` / purchase event IDs.
Lead duplicate protection is enforced at the database level for normalized email/phone.
Spend ingestion is an upsert by daily media scope.
## Database tables
- `dr_clicks`: attribution parameters, campaign/adset/ad IDs, UTM data.
- `dr_leads`: lead identity and attribution.
- `dr_events`: generic funnel/lifecycle events.
- `dr_orders`: paid orders.
- `dr_ad_spend`: daily paid-media spend, impressions, media clicks and campaign/adset/ad metadata.

Do not rename or destructively recreate existing tables.
Migrations must preserve production data.

## Reporting rules
- Never multiply metrics through fanout joins.
- Aggregate tracking/event/spend data before joining.
- Prefer campaign/adset/ad IDs when available.
- When an ID is absent on one side, normalized names may be used as a safe fallback.
- Never merge records solely by name when both sides have different non-null IDs.
- Keep tracking-only and spend-only rows visible.
- Protect every ratio from division by zero.
- Reporting endpoints accept optional `from` / `to` dates in YYYY-MM-DD; no dates means all time.
- Tracking dates use America/Sao_Paulo reporting-day boundaries.
- Clicks, leads, and events are filtered by each record's own `created_at`; spend is filtered by `spend_date`.
- Because reporting is event-date based, a period can legitimately show leads or purchases from clicks created before that period.
- `dr_ad_spend.spend_date` is treated as the ad-platform reporting date and is not timezone-shifted.
## Dashboard rules
- Preserve the dark visual language already in dashboard.html.
- Mobile responsiveness is required.
- Wide reporting tables may horizontally scroll.
- User-provided names must be escaped before injecting into HTML.
- Auto-refresh currently runs every 30 seconds and should remain unless intentionally redesigned.
- Use pt-BR formatting and BRL for monetary values.
- Avoid frontend frameworks unless explicitly approved.

## Validation before every commit
At minimum run:
```bash
node --check index.js
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' dashboard.html > /tmp/dashboard.js
node --check /tmp/dashboard.js
git diff --check
```

Also inspect `git diff` for accidental changes.
Do not use production mutation endpoints for test data.
Read-only production GET checks are allowed after deploy.

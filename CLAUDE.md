# Oferta DR - Engineering Guide

## Project
Oferta DR is a Node.js/Express/PostgreSQL tracking and performance system for direct-response funnels.

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

Core acquisition funnel:
`click -> landing_view -> lead -> checkout_started -> purchase`

Extended monetization funnel:
`purchase -> call_booked -> call_attended/call_no_show -> mentorship_offer -> mentorship_purchase`

Also supported as generic events: `refund` and future `order_bump_purchase`.

Attribution uses `click_id`. A persistent visitor ID is separate from `click_id`: every new router entry can create a fresh click while keeping the visitor sticky to the same experiment variant.
Purchase idempotency uses `order_id` / purchase event IDs.
Lead duplicate protection is enforced at the database level for normalized email/phone.
Spend ingestion is an upsert by daily media scope.
## Database tables
- `dr_clicks`: attribution parameters, campaign/adset/ad IDs, UTM data, fbclid/gclid, `capture_source` (tag, router, checkout_recovered, legacy).
- `dr_leads`: lead identity, attribution, lifecycle stage, temperature and lead score.
- `dr_events`: generic funnel/lifecycle events.
- `dr_orders`: paid orders.
- `dr_ad_spend`: daily paid-media spend, impressions, media clicks and campaign/adset/ad metadata.
- `dr_experiments`: router configurations (technical table name kept for compatibility).
- `dr_experiment_variants`: destination variants and traffic weights.
- `dr_experiment_assignments`: click-to-variant assignment with persistent visitor key.
- `dr_lead_crm_history`: CRM state audit trail.
- `dr_crm_followups`: persistent commercial follow-up queue linked to leads. Automated tasks can reference `automation_run_id` for idempotency.
- `dr_crm_saved_segments`: reusable CRM filter views saved by admin.
- `dr_automation_rules`: persistent Automation Hub rules (trigger, delay, conditions and action configuration).
- `dr_automation_runs`: durable queue and audit history for every scheduled automation execution.
- `dr_activation_exports`: immutable list-export batches with format, filters, repeat window and counts.
- `dr_activation_export_leads`: lead membership for each exported batch, used to prevent accidental repeat activation.
- `dr_utmify_connection`: selected UTMify dashboard metadata and enabled Meta accounts; never stores the MCP token.
- `dr_utmify_syncs`: audited UTMify snapshot runs by reporting period.
- `dr_utmify_ad_objects`: cached campaign/adset/ad objects and normalized metrics for each snapshot.
- `dr_monitor_log`: operation-health signals (source, ok, ms, short detail); no personal data.
- `dr_hubla_events`: durable inbox of Hubla webhook notices (sanitized payload, processing state, retries, sandbox flag).

Offer foundation routes:
- GET `/admin` serves the experiment administration UI.
- GET `/go/:slug`
- GET `/api/crm/summary`
- GET `/api/crm/facets` (requires `x-admin-secret`; segment counts + source/campaign filter options)
- GET `/api/crm/leads` (requires `x-admin-secret`; supports search, lifecycle, temperature, source, campaign, segment, sorting and pagination)
- GET `/api/crm/leads/:id/timeline` (requires `x-admin-secret`; event + CRM audit + follow-up history)
- PATCH `/api/crm/leads/:id` (requires `x-admin-secret`)
- POST `/api/crm/bulk-update` (requires `x-admin-secret`; update lifecycle/temperature/score/note for selected leads)
- GET/POST `/api/crm/followups` and PATCH `/api/crm/followups/:id` (requires `x-admin-secret`)
- GET/POST `/api/crm/saved-segments` and DELETE `/api/crm/saved-segments/:id` (requires `x-admin-secret`)
- GET `/api/automations/summary` (requires `x-admin-secret`)
- GET/POST `/api/automations/rules`, PATCH/DELETE `/api/automations/rules/:id` (requires `x-admin-secret`)
- GET `/api/automations/runs` (requires `x-admin-secret`; includes protected contact identity and safe run result)
- POST `/api/automations/process` (requires `x-admin-secret`; manually processes currently due runs)
- POST `/api/activation/eligibility` (requires `x-admin-secret`; excludes contacts exported within the configured window)
- POST `/api/activation/exports` (requires `x-admin-secret`; creates an immutable export batch and records its lead membership)
- GET `/api/activation/exports` (requires `x-admin-secret`; recent export history)
- GET `/api/activation/exports/:id/lead-ids` (requires `x-admin-secret`; batch membership)
- GET `/api/integrations/utmify/status` (requires `x-admin-secret`; never returns credentials)
- POST `/api/integrations/utmify/discover` (requires `x-admin-secret`; discovers dashboards/accounts through MCP)
- POST `/api/integrations/utmify/sync` (requires `x-admin-secret`; snapshots campaign/adset/ad metrics for a maximum 31-day range)
- GET `/api/integrations/utmify/performance` (requires `x-admin-secret`; reads local PostgreSQL snapshot only, never MCP live)
- GET `/api/integrations/utmify/economics` (requires `x-admin-secret`; combines UTMify acquisition snapshot with Oferta DR cohort monetization/LTV)
- GET `/api/tracking-health` (requires `x-admin-secret`; audits click/lead/buyer ID coverage, orphan relationships, UTMify object match and front-end source divergence for up to 90 days)
- GET `/api/experiments` (public-safe summary, no destination URLs)
- GET `/api/admin/experiments` (requires `x-admin-secret`; includes destination URLs)
- PUT `/api/experiments/:slug` (requires `x-admin-secret`; creates/updates experiment and variants)
- PATCH `/api/experiments/:slug/weights` (requires `x-admin-secret`)
- GET `/api/experiments/:slug/performance`
- GET `/api/revenue/ltv`
- GET `/api/overview/timeseries` (daily spend, purchases, revenue and ROAS for the overview chart; defaults to the latest 30 days when no date range is supplied)

Lead-level CRM, Automation Hub, List Activation, UTMify integration and Tracking Health reads/writes require `DR_ADMIN_SECRET`. Never expose this secret in dashboard source or API responses.

Tracking Health rules:
- the protected `Tracking` view diagnoses data quality; it never fixes, synthesizes or reassigns acquisition IDs;
- internal coverage and external match are separate concepts. Internal coverage asks whether the Oferta DR captured `click_id/campaign_id/adset_id/ad_id`; UTMify match asks whether that captured ID exists in the exact same-period local UTMify snapshot;
- campaign/adset/ad coverage uses the Meta-eligible cohort, not all traffic. Meta-family sources (Meta/Facebook/Instagram aliases) and source-less clicks that already carry Meta IDs are eligible; Google/direct traffic must not reduce Meta coverage;
- UTMify object-match percentages use only internally captured IDs as the denominator. Missing IDs are an internal-capture problem and must not be counted a second time as an external-match failure;
- a purchase with `click_id` but no matching `dr_clicks` row is an orphan and must remain visible as a critical issue;
- leads/events with orphan click IDs remain visible and are never silently dropped;
- repeated `purchase` events on the same `click_id` are diagnostic warnings, not automatically deleted, because they may be legitimate repurchases;
- exact-period UTMify snapshot absence is informational. Tracking Health must not call MCP live;
- front purchase/revenue divergence against UTMify uses the Meta-eligible Oferta DR cohort. If that cohort has purchases/revenue while the synchronized UTMify period reports zero, flag a critical divergence instead of treating the comparison as neutral;
- default health thresholds: coverage >=95% good, >=80% warning, below 80% critical; source divergence <=5% good, <=15% warning, above 15% critical;
- the health endpoint accepts a maximum 90-day range. Dashboard `Tudo` falls back to the latest 30 days for diagnostics;
- low-level health status must consider both explicit issues and metric states.

UTMify MCP rules:
- credentials are environment-only: `UTMIFY_MCP_TOKEN`, optional `UTMIFY_MCP_ENDPOINT`, optional `UTMIFY_MCP_RESOURCES`, optional `UTMIFY_DASHBOARD_ID`;
- optional `UTMIFY_META_ACCOUNTS` (comma-separated account names or IDs) restricts discovery and sync to the ad accounts of this offer. When it is set and any listed account is missing, discovery/sync fail with an explicit message; it never falls back to all accounts;
- never store or return the MCP token, full authenticated URL or provider error body;
- current allowed tools are read-only: dashboard discovery and Meta ad-object metrics;
- sync a bounded range of at most 31 days and fetch campaign/adset/ad sequentially to avoid abusive MCP traffic;
- PostgreSQL snapshots are the dashboard source after sync; 30-second dashboard refreshes must not hit MCP;
- UTMify monetary fields from MCP are integer/decimal cents and must be divided by 100 before storage/display; ratios such as ROAS/ROI/CTR are not currency and must not be divided;
- campaign/adset/ad parent names are reconstructed from the same local snapshot by IDs;
- Performance supports explicit source switching between Oferta DR and UTMify;
- UTMify Performance is enriched with downstream Oferta DR value by exact `campaign_id`, `adset_id` or `ad_id`; never guess adset/ad attribution by name;
- the selected reporting period defines the front-end buyer cohort. Mentorship, bump, calls and refunds for those same `click_id` values are accumulated downstream even when they occur after the acquisition period;
- rows expose tracked front buyers, mentorship buyers/revenue, LTV, tracked net revenue, total tracked ROAS and per-row purchase coverage;
- Performance source text must expose both ID coverage and UTMify object-match coverage. Internal IDs missing from the UTMify snapshot remain visible as `internal_only` / "Só DR" rows instead of being reassigned;
- stale Performance requests must never overwrite a newer source/level selection;
- the protected `Economia` view combines UTMify spend/front metrics with the Oferta DR front-buyer cohort, downstream mentorship revenue, refunds and LTV;
- `tracked_total_roas` is deliberately defined as Oferta DR tracked net cohort revenue divided by UTMify spend for the exact synced period;
- purchase and front-revenue tracking coverage compare Oferta DR against UTMify and must be shown alongside total ROAS; do not present total ROAS as validated attribution when those sources materially diverge;
- never add UTMify front revenue to Oferta DR front revenue in one total, because that would double count the same economic layer;
- the existing direct Meta integration remains frozen/optional and must not be silently mixed into UTMify snapshots.

List Activation rules:
- the dashboard `Listas` tab reuses CRM filters and saved segments; do not create a separate segmentation model;
- supported export formats are generic: contacts, phone/WhatsApp, email, audience and full CRM;
- phone exports include raw phone digits and a BR E.164 helper only when the number shape is confidently Brazilian;
- every generated CSV is registered as an immutable batch before download;
- repeat protection supports none, 7, 30, 90 days, or never-exported-before;
- export membership is stored by lead ID so the next batch can automatically skip recently worked contacts;
- server-side format validation prevents phone-only exports from including contacts without a phone, and likewise for email;
- export payloads are capped at 5,000 leads and stored filter metadata is allowlisted/bounded;
- this module prepares lists only. It does not send WhatsApp, email or other outbound messages.

Automation Hub worker rules:
- the PostgreSQL queue is the source of truth; delayed actions are never kept only in memory;
- event ingestion enqueues only after a new `dr_events` row is inserted;
- a unique `(rule_id, lead_id, source_event_id)` prevents duplicate runs;
- the worker claims due rows with `FOR UPDATE SKIP LOCKED`, recovers stale `running` rows, and processes bounded batches;
- conditions are re-evaluated at execution time, so checkout/purchase/call outcomes can cancel a pending action safely;
- follow-up creation is idempotent through `automation_run_id`;
- disabling a rule prevents new enqueues and causes still-disabled pending runs to skip at execution;
- changing a rule delay affects only future enqueues;
- external WhatsApp/email sending is not connected yet. The current action is creation of an internal CRM follow-up.

Default system rules:
- `checkout_abandoned`: checkout_started -> 60 min -> skip if purchase -> high-priority recovery follow-up;
- `frontend_without_call`: purchase -> 24 h -> skip if call_booked -> high-priority call follow-up;
- `no_show_recovery`: call_no_show -> immediate -> skip if a newer call_booked exists -> urgent rebooking follow-up;
- `post_call_without_mentorship`: call_attended -> 24 h -> skip if mentorship_purchase -> high-priority sales follow-up.

Do not rename or destructively recreate existing tables.

`scripts/zerar-dados-de-teste.js` is the only sanctioned way to clear test data: it is run by the owner in the Render shell, lists what will be removed, keeps configuration tables, requires a typed phrase and refuses to run once real volume exists. Every new table must be added to its `WIPE` or `KEEP` list (an unclassified table makes it stop). Never expose this as an HTTP route.
Migrations must preserve production data.

## Reporting rules
Funnel integration rules:
- `/api/integrations/funnel/status` and POST `/api/integrations/funnel/events` are protected server-to-server canonical APIs. Never claim a real checkout connection from synthetic validation;
- monetary events require approved payments/confirmed refunds, explicit BRL, finite positive amounts with <=2 decimals, stable business identifiers and an actual occurrence timestamp with timezone;
- `dr_funnel_orders`/`dr_funnel_receipts` are additive and preserve immutable original click/buyer/order references. Post-purchase attribution uses the front order, never a guess from contact or media name;
- purchase events are deduplicated by paid order even if delivery IDs change; calls/refunds use stable occurrence IDs. Conflicting replays return 409; missing clicks return 422;
- all financial/event writes, CRM changes/audit and automation enqueues share one transaction. Never swallow failed side effects and acknowledge a partially applied sale;
- a linked internal lead ID is trusted only from the order ledger, not accepted from public payloads;
- refunds are bounded cumulatively by the original order value, serialized per order and deducted once; CRM retains the existing any-refund lifecycle rule;
- no staging/production economic settings are invented or auto-confirmed. Provider selection and real platform tests remain necessary;
- canonical `refund` accepts `payment_status` `refunded` or `chargeback` (final reversal only; never a refund request or an open dispute);
- see `FUNNEL_INTEGRATION.md` and the loopback-only `validation/funnel.integration.js`.

Hubla receiver rules (`hublaWebhook.js`, details in `HUBLA_INTEGRATION.md`):
- POST `/api/integrations/hubla/webhook` authenticates with `x-hubla-token` (`HUBLA_WEBHOOK_TOKEN`, environment only). Admin routes under `/api/integrations/hubla/*` use `x-admin-secret`;
- store first, ACK after the durable insert, process asynchronously through the PostgreSQL inbox. Never process inside the request and never keep the queue only in memory;
- `invoice.status_updated` is the only financial trail; `invoice.refunded` only confirms a full refund. Do not add a second trail for the same transition;
- products are mapped by real product/offer IDs from the environment, never by name or price;
- a front purchase without a `click_id` stays `pending_attribution`. A missing click is created only from the checkout's own session data when the id has the page-tag format (`dr_` + UUID), marked `capture_source = 'checkout_recovered'`; never attribute by email, name or value;
- sandbox notices (`x-hubla-sandbox`) are stored and read only; they must never write orders, events or leads;
- ambiguous cases (multi-product, child invoice, smart-installment follow-ups, non-BRL, unconfirmed/partial refund) go to `needs_review` instead of being guessed;
- stored payloads exclude document, address, IP and user agent; logs never include tokens or payloads;
- `provider_connected` on the Hubla status is true only after an authenticated non-sandbox notice;
- GET `/assets/dr-checkout.js` (`checkoutLinks.js`) is the page tag for the no-redirect flow: it creates the `click_id` on the page when none came in the URL, reports it to POST `/track/click` in the background and forwards it to checkout links. It must stay ES5 (it is also pasted into Google Tag Manager: no arrow functions, `const`/`let`, template literals or double braces) and must never block the page.

Router rules (`resilientRouter.js`, GET `/go/:slug`):
- the router is in the visitor's path for split tests, so its first duty is to redirect. Never add an awaited dependency that can turn a slow or unavailable database into an error page;
- route + variants are cached in memory (10 s); with the database down the last known configuration is used, the same visitor keeps the same LP (deterministic hash of the visitor key) and click/assignment writes go to a bounded in-memory queue that is flushed when the database returns;
- a failed database call pauses database use for 5 s (breaker) so later visitors do not wait;
- `DR_ROUTER_FALLBACK_URL` (optional) is the emergency destination when the service starts with the database unavailable and has no cached route;
- GET `/api/router/health` (admin) exposes queue size, late writes, drops and degraded redirects;
- GET `/api/experiments/:slug/performance` accepts `from`/`to` (São Paulo day of the click assignment) and returns clicks, buyers and revenue per LP; downstream revenue of those clicks counts even after the period;
- the dashboard Router tab (`routerDashboard.js`) compares only LPs with at least 5 buyers and only when the conversion difference passes a two-proportion test. With fewer than 30 buyers on either of the two best LPs the reading is labelled "indicação inicial" (owner's decision for routes with many pages); "na frente" is reserved for 30+ buyers each. Never present the initial reading as a closed result.

Operation health rules (`operationHealth.js`, dashboard block in `healthDashboard.js`):
- the health block at the top of the dashboard mirrors the Garagem em Escala monitor: one traffic light, alerts in plain Portuguese with "o que fazer", chips per integration, and an optional AI diagnosis;
- `dr_monitor_log` stores signals (`erro` for 5xx responses, `hubla_auth` for refused webhook tokens, `site`/`lp` for outside probes, `saude` for level changes). `record` never throws and is capped per minute per source; rows older than 30 days are pruned;
- the server re-evaluates health every minute even with the dashboard closed and records each change of situation; GET `/api/operation-health` (admin) returns level, alerts, metrics and the last 24 h of changes;
- `evaluate()` is a pure function with the alert rules; change thresholds there and cover them in `operationHealth.test.js`. Traffic/sales rules are `attention` at most, never `critical`, and never recommend pausing or scaling ads;
- outside probes use `DR_PUBLIC_URL` or `RENDER_EXTERNAL_URL` for the service itself and the active router destinations for landing pages (every 5 min, public hosts only). Checkout hosts are never probed, so the monitor does not distort Hubla conversion numbers; a 401/403/406/429 from a page is "could not verify", not an outage; a failed probe is retried once before it becomes an alert; redirects are followed manually and every hop must be a public host;
- POST `/api/operation-health/diagnosis` (admin) calls the Anthropic API with `ANTHROPIC_API_KEY` (environment only; optional `ANTHROPIC_MODEL`). It sends only the alert list and count/timing metrics: never payloads, contacts, tokens or destination query strings. It always answers 200 with a Portuguese message;
- the health metrics must stay free of personal data; add counts and timings only.

Click capture rules (`clickCapture.js`):
- ads may point straight to a page (no redirect) or to the router. In both cases a server outage may lose a click record but must never lose a visit or a sale: the page tag creates the `click_id` when the visitor arrives without one;
- POST `/track/click` is public, validated and rate limited. Attribution (UTMs + media IDs) is one block and is written to an existing click only when that click has none; `/go/:slug` follows the same rule. Never add a path that overwrites the origin of an existing click;
- media IDs come from explicit `campaign_id`/`adset_id`/`ad_id` or from the UTMify `name|id` suffix; never from names;
- `/track/purchase` and `/track/spend` require `x-admin-secret`. `/track/event` is public only for non-monetary navigation events with value 0; revenue and post-purchase event names require the secret.

Decision Center rules:
- protected read-only GET `/api/decisions` reuses `getCpaReport` and its exact-period/Meta/BRL rules; no new monetary aggregation, provider calls or media mutations;
- diagnose each campaign/adset/ad by exact ID. Each card carries evidence, criteria, priority and a manual next step;
- own-scope economic eligibility is mandatory for scale, above-limit, negative-contribution and mentorship comparisons. Global cost/currency/snapshot/tracking blockers suppress all media recommendations;
- scale requires current CPA <=80% of the scope's prudent limit. Above the calculated maximum means failure to preserve the configured objective, not necessarily accounting loss;
- high LTV requires >=2x the eligible general mature-buyer weighted mean. Low monetization requires CPA <=80%, LTV <=75%, and mentorship attach <=50% of their eligible general references;
- no-purchase spend review requires zero front buyers in both sources, an exact matched object, an eligible positive general CPA maximum, spend >=1.4x that general maximum, and a closed period of at least three days. Explicitly label the borrowed general reference; it is not an automatic pause instruction;
- mature net ROAS is mature tracked net revenue / total cohort spend. Do not extrapolate immature revenue or sum UTMify front revenue into DR revenue;
- provisional general comparisons never replace a valid own-scope decision; unknown costs, small/immature samples, currency problems, unmatched IDs and concentration remain visible as data limitations;
- return at most 100 priority cards with full counts and a visible truncation notice; filters apply to those returned cards;
- settings revision, snapshot ID, calculation time and rule thresholds remain visible. Stale requests and authentication changes must not restore old decisions.

CPA Maximum rules:
- protected routes: GET `/api/cpa-max`, GET/PUT `/api/cpa-max/settings`; use the existing `x-admin-secret` guard;
- `dr_cpa_settings` is an additive singleton table with versioned economic assumptions. Reject stale settings revisions with 409;
- calibrate only from the first front purchase per `click_id` in the selected Meta cohort; count downstream transactions once, aggregate per buyer before grouping by exact media IDs;
- only buyers that completed the configured monetization window contribute to the observed unit economics. Positive downstream revenue is bounded by that window; subsequent refunds remain deducted through now;
- BRL is required for both event values and UTMify configuration. Never sum mixed currencies or invent exchange rates;
- fees are modeled on gross sales and considered non-refundable; taxes/split use positive revenue after refunds. Variable costs include front servicing and mentorship delivery per transaction;
- preserve contribution mode uses contribution before media × (1 − target); media ROI uses contribution ÷ (1 + target). Contribution reserve is not a revenue/profit accounting margin;
- scenario assumptions never replace observed data or qualify a scope for scale;
- scale eligibility requires confirmed costs, healthy Tracking Health, an exact-period matched UTMify object, per-scope front purchase/revenue divergence <=5%, sufficient mature sample and >=80% cohort maturity;
- mentorship revenue with fewer than three mentorship buyers or >50% concentrated in one buyer is provisional; a snapshot >24 hours old blocks recommendations for an open reporting period;
- CPA diagnostics do not mutate ad budgets or automatically pause/scale campaigns;
- display initial zero costs as unconfirmed rather than treating unknown fees/split as zero validated cost;
- dashboard refresh must not overwrite unsaved settings; stale requests cannot replace newer period/level selections.

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
node --check automationHub.js
node --check activationHub.js
node --check utmifyMcp.js
node --check trackingHealth.js
node --check hublaWebhook.js
node --check clickCapture.js
node --check resilientRouter.js
node --check routerDashboard.js
node --check hublaDashboard.js
node --check checkoutLinks.js
node --check operationHealth.js
node --check healthDashboard.js
npm test
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' dashboard.html > /tmp/dashboard.js
node --check /tmp/dashboard.js
git diff --check
```

Also inspect `git diff` for accidental changes.
Do not use production mutation endpoints for test data.
Read-only production GET checks are allowed after deploy.

# Oferta DR — Offer Foundation

## Business model

The front-end product is R$297. The operation can run near break-even on the front-end because the main profit opportunity is the post-purchase mentorship funnel. Reporting must therefore separate front-end ROAS from total revenue and LTV.

## Canonical funnel

`click -> landing_view -> lead -> checkout_started -> purchase -> call_booked -> call_attended/call_no_show -> mentorship_offer -> mentorship_purchase`

Additional supported lifecycle events:
- `refund`
- `order_bump_purchase` (reserved for future tests)

All of these event names can use the existing generic `POST /track/event`. The normal front-end purchase continues to use `POST /track/purchase`.

## Router and one-link routing

The router endpoint is `GET /go/:slug`.

It:
- receives or creates a fresh `click_id` for each router entry;
- keeps the current `click_id` in a first-party cookie for downstream tracking;
- keeps a separate persistent visitor ID for sticky experiment assignment;
- records every new click and its attribution fields without collapsing repeat paid clicks;
- finds the active experiment by slug;
- chooses among active variants using weighted deterministic allocation by visitor;
- stores an assignment for each click in `dr_experiment_assignments`;
- redirects to the assigned landing page;
- forwards `click_id`, campaign/ad IDs, UTMs, fbclid/gclid and experiment/variant labels.

Traffic allocation is fully dynamic and uses relative weights, not a hard-coded 20/20/20/20/20 split. Examples: 50/20/15/10/5, 80/20/0/0/0, or equal weights. Weights can be changed without changing the public /go link. A weight of zero removes that variant from routing immediately, including previously sticky visitors.

Router configuration is not hard-coded. `PUT /api/experiments/:slug` with `x-admin-secret` creates or updates the router configuration and its landing-page variants, including destination URLs, active flags and weights. Variants omitted from that configuration are disabled.

The administration UI is served at `/admin`. It keeps `DR_ADMIN_SECRET` only in browser session storage, loads full experiment configuration through the protected admin API, and allows editing URLs, active flags and relative weights without changing the public routing link.

Administrative weight-only changes use `PATCH /api/experiments/:slug/weights` with `x-admin-secret`. The body is `{ "weights": { "LP_A": 80, "LP_B": 20, "LP_C": 0 } }`. At least one active variant must keep a positive weight.

## CRM model

Lifecycle stage and lead temperature are intentionally separate.

Lifecycle stages:
`lead`, `checkout`, `customer`, `call_booked`, `mentorship_opportunity`, `mentorship_customer`, `refunded`.

Temperatures:
`cold`, `warm`, `hot`.

The event-to-CRM mapper only moves a lead forward in the commercial lifecycle, except an explicit refund, which moves the lifecycle to `refunded`. Manual CRM edits are recorded in `dr_lead_crm_history`.

CRM routes:
- `GET /api/crm/summary` exposes aggregate counts only;
- `GET /api/crm/facets` exposes protected segment counts and source/campaign filter options;
- `GET /api/crm/leads` exposes protected lead-level data with filters, sorting, pagination, attributed revenue and derived offer segments;
- `GET /api/crm/leads/:id/timeline` combines funnel events, CRM audit history and follow-up activity;
- `PATCH /api/crm/leads/:id` updates lifecycle, temperature, score and notes;
- `POST /api/crm/bulk-update` applies audited lifecycle/temperature/score/note changes to selected leads;
- `GET/POST /api/crm/followups` plus `PATCH /api/crm/followups/:id` power a persistent follow-up queue with due date, priority and completion state;
- `GET/POST/DELETE /api/crm/saved-segments` stores reusable dynamic filter views for commercial lists.

Offer-specific quick segments currently include: checkout abandoned, front-end buyer without a booked call, call booked, no-show, mentorship opportunity and mentorship customer. The CRM UI can save any filter combination as a reusable dynamic segment and export filtered or selected contacts to CSV.

Lead-level read/write routes require `DR_ADMIN_SECRET`. This variable must exist only in environment configuration, never in source.

## Automation Hub

Automation Hub is a durable event-to-action engine layered on top of the canonical funnel. It does not send WhatsApp or email yet; its current action is to create persistent CRM follow-up tasks for the commercial team.

Persistence:
- `dr_automation_rules` stores rule trigger, delay, conditions, action configuration and active/system state;
- `dr_automation_runs` is both the delayed queue and the audit trail;
- `dr_crm_followups.automation_run_id` guarantees that retrying a run cannot create the same automatic follow-up twice.

Event ingestion enqueues a run only when a new `dr_events` row is inserted. The unique key `(rule_id, lead_id, source_event_id)` prevents duplicate runs for repeated webhooks/events.

The worker:
- uses PostgreSQL as the source of truth rather than in-memory timers;
- claims bounded batches with `FOR UPDATE SKIP LOCKED`;
- recovers stale `running` executions after ten minutes;
- evaluates conditions again only when the scheduled time arrives;
- skips a run when a configured blocking event has occurred after the source event;
- skips terminal/configured lifecycle stages;
- skips a pending run when its rule is disabled at execution time;
- isolates failures so one bad run cannot break the rest of the batch.

Default system rules:
- `checkout_abandoned`: `checkout_started`, wait 60 minutes, skip if `purchase`, create high-priority recovery follow-up;
- `frontend_without_call`: `purchase`, wait 24 hours, skip if `call_booked`, create high-priority call follow-up;
- `no_show_recovery`: `call_no_show`, immediate, skip if a newer `call_booked` exists, create urgent rebooking follow-up;
- `post_call_without_mentorship`: `call_attended`, wait 24 hours, skip if `mentorship_purchase`, create high-priority sales follow-up.

System rules may be edited, paused or re-enabled but not deleted. Custom rules use the same editor and are soft-deleted so historical runs remain auditable. Changing a delay affects only future enqueues and does not rewrite already scheduled runs.

Protected routes:
- `GET /api/automations/summary`;
- `GET/POST /api/automations/rules`;
- `PATCH/DELETE /api/automations/rules/:id`;
- `GET /api/automations/runs`;
- `POST /api/automations/process` for an admin-triggered processing tick.

All Automation Hub routes require `x-admin-secret` and share the same browser session secret as CRM.

## List Activation

The `Listas` view is the operational bridge between CRM segmentation and external communication tools. Oferta DR does not send outbound messages directly; it prepares controlled, auditable contact batches that can be uploaded or pasted into the tool chosen by the operator.

The list source reuses the CRM model:
- built-in offer segments such as checkout abandoned, front-end buyer without call, no-show and mentorship opportunity;
- cold/warm/hot temperature;
- saved CRM segments;
- the filters currently applied in the CRM.

Supported generic output formats:
- `contacts`: name, phone, BR E.164 helper, email and attribution;
- `phone`: phone-oriented file for phone/WhatsApp workflows;
- `email`: email-oriented file;
- `audience`: normalized phone/email identity columns for generic audience import;
- `crm`: full operational CRM context.

Persistence:
- `dr_activation_exports` stores an immutable export batch with name, format, stored filter metadata, repeat window and aggregate counts;
- `dr_activation_export_leads` stores which lead IDs belonged to that batch.

Repeat protection can be disabled or configured for 7, 30, 90 days, or never-exported-before. Eligibility is checked both during preview and again inside the export transaction, so two browser sessions cannot safely cause the same recently exported contact to slip into a protected batch.

Format validation also runs server-side. A phone-only batch excludes contacts without a phone; an email-only batch excludes contacts without email. Export requests are capped at 5,000 contacts and stored filter metadata is allowlisted and length-bounded.

The dashboard supports:
- choosing the source segment;
- choosing output format;
- choosing repeat-protection window;
- choosing a batch size from 100 to 5,000;
- preview counts for found, valid, recently exported and ready contacts;
- copying ready phone numbers or emails;
- generating the CSV;
- reviewing recent export history.

Protected routes:
- `POST /api/activation/eligibility`;
- `POST /api/activation/exports`;
- `GET /api/activation/exports`;
- `GET /api/activation/exports/:id/lead-ids`.

All List Activation routes require `x-admin-secret` and share the same browser session secret as CRM.

## UTMify MCP integration

UTMify is the preferred paid-media integration for the MVP. The direct Meta Ads integration remains available as a frozen optional path, but UTMify is used first because it already exposes attributed media and sales metrics through MCP.

Credentials:
- `UTMIFY_MCP_TOKEN` is required and environment-only;
- `UTMIFY_MCP_ENDPOINT` defaults to the UTMify MCP endpoint;
- `UTMIFY_MCP_RESOURCES` controls the resource grant string;
- `UTMIFY_DASHBOARD_ID` can pin a dashboard when an account has more than one.

The token and authenticated MCP URL are never persisted in PostgreSQL or returned to the dashboard.

Persistence:
- `dr_utmify_connection` stores the selected dashboard, timezone, currency and enabled Meta accounts;
- `dr_utmify_syncs` audits each period snapshot;
- `dr_utmify_ad_objects` stores campaign, adset and ad objects plus normalized metrics for that snapshot.

Sync behavior:
- discovery reads dashboard/account metadata from MCP;
- a sync is limited to 31 calendar days;
- campaign, adset and ad levels are fetched sequentially;
- the MCP is contacted only during explicit discovery/sync, never by the 30-second dashboard refresh;
- Performance reads PostgreSQL snapshots through `GET /api/integrations/utmify/performance`;
- parent campaign/adset names are reconstructed by IDs from the same snapshot.

UTMify MCP money fields are denominated in cents. Spend, revenue, profit, CPA, CPL, CPC and CPM are divided by 100 before storage. Ratios/counts such as ROAS, ROI, CTR, impressions, clicks and orders are not divided.

The Performance screen keeps an explicit source switch:
- `Oferta DR` uses internal attribution/spend tables;
- `UTMify` uses a synchronized UTMify snapshot for the selected period.

UTMify Performance also carries downstream cohort value from Oferta DR:
- the selected period defines the front-end purchase cohort;
- each cohort buyer is joined back to the acquisition click by `click_id`;
- campaign, adset and ad attribution use exact persisted Meta IDs only;
- calls, mentorship purchases, bump revenue and refunds for those same buyers are accumulated after acquisition, including events that happen after the selected period;
- each media row can therefore show tracked buyers, mentorship buyers/revenue, LTV, tracked net revenue and total tracked ROAS;
- ID coverage measures how much of the internal front-buyer cohort has the required ID for the selected breakdown level;
- UTMify match coverage measures how much of that cohort matches an actual object in the synchronized UTMify snapshot;
- internal IDs without a UTMify match are surfaced explicitly as `internal_only` / "Só DR" rows. They are never forced into a similarly named object.

The protected `Economia` view intentionally keeps acquisition and monetization sources separate:
- UTMify supplies spend, front-end purchases, front-end revenue, front CPA and front ROAS;
- Oferta DR supplies the front-buyer cohort, mentorship revenue, bump revenue, refunds, tracked net revenue and LTV;
- `tracked_total_roas = tracked_net_revenue / utmify_spend`;
- purchase tracking coverage compares internal front purchases against UTMify purchases;
- revenue tracking coverage compares internal front revenue against UTMify front revenue;
- total tracked ROAS must be read together with those coverage values. If UTMify and internal front-end totals diverge materially, the UI explicitly warns that the ratio is mathematical but not yet validated attribution.

UTMify front revenue is never added to Oferta DR front revenue in the same total, because that would double count the entry product.

Protected routes:
- `GET /api/integrations/utmify/status`;
- `POST /api/integrations/utmify/discover`;
- `POST /api/integrations/utmify/sync`;
- `GET /api/integrations/utmify/performance`;
- `GET /api/integrations/utmify/economics`.

All UTMify integration routes require `x-admin-secret`.

## Tracking Health

Tracking Health is a protected diagnostic layer for acquisition-data quality. It never writes, repairs, synthesizes or reassigns tracking IDs.

The selected dashboard period defines the diagnostic window, up to 90 days. When the dashboard is on `Tudo`, the Tracking view uses the latest 30 days so diagnostics remain bounded.

It measures two separate layers:

1. Internal capture
- campaign/adset/ad coverage is measured on the Meta-eligible cohort rather than all traffic, so Google/direct traffic does not create false Meta failures;
- Meta-family sources are eligible; source-less records that already carry Meta IDs are also eligible;
- click coverage for `campaign_id`, `adset_id` and `ad_id`;
- lead coverage for `click_id` and source;
- front-buyer coverage for `click_id`, resolved click row and each paid-media ID;
- orphan lead/event/purchase relationships;
- repeated front `purchase` events sharing one `click_id` as warnings for investigation.

2. UTMify reconciliation
- Tracking Health reads only the exact same-period completed UTMify snapshot already stored in PostgreSQL;
- match percentages use only captured IDs as their denominator, so a missing `ad_id` is reported as internal capture failure rather than being double-counted as UTMify mismatch;
- it measures whether captured campaign/adset/ad IDs actually exist in that snapshot;
- it compares the Meta-eligible Oferta DR front purchases/revenue with UTMify front purchases/revenue;
- it never calls the MCP during dashboard refresh.

Default diagnostic thresholds:
- coverage >=95%: healthy;
- coverage >=80% and <95%: warning;
- coverage <80%: critical;
- absolute source divergence <=5%: healthy;
- >5% and <=15%: warning;
- >15%: critical.

A synchronized UTMify period with zero purchases/revenue while Oferta DR has front purchases/revenue is explicitly critical rather than neutral.

Protected route:
- `GET /api/tracking-health?from=YYYY-MM-DD&to=YYYY-MM-DD`.

The Tracking dashboard must keep internal coverage and UTMify match visually distinct and must never hide unmatched IDs.

## CPA Maximum

The protected `CPA Maximo` view at `/dashboard#cpa` combines exact-period UTMify acquisition with mature Oferta DR buyer unit economics. It reads local snapshots only.

- `GET /api/cpa-max?from=YYYY-MM-DD&to=YYYY-MM-DD&level=campaign|adset|ad` (1–31 days).
- `GET /api/cpa-max/settings`.
- `PUT /api/cpa-max/settings` with `{settings, expected_revision}`.

All API routes require the existing administrative secret. Configuration lives in the additive `dr_cpa_settings` table with an atomic revision guard. No provider secrets are stored in it.

The acquisition period selects the first front purchase for each click ID. Meta-eligible buyers only are used. Mature buyers have completed the configured monetization horizon (default 30 days). Positive mentorship/bump revenue is counted within that horizon; refunds after the horizon remain deducted through the present. This avoids treating unmonetized recent buyers as fully mature or inflating short horizons with late positive revenue. A recent acquisition cohort may have no mature sample; select an older period for mature calibration.

Unit contribution deducts refunds, modeled fees, taxes, split and variable fulfillment costs from tracked revenue. Fees are charged on gross sale values and assumed non-refundable; taxes/split use positive revenue after refunds. Fixed overhead is excluded. All monetary inputs and source values must be BRL; mixed currencies are not converted implicitly.

Two objectives are explicit:
- reserve a percentage of contribution before media: `CPA max = max(contribution * (1 - target), 0)`;
- minimum return over media: `CPA max = max(contribution / (1 + target), 0)`.

A separate safety discount produces a prudent CPA limit. The reserve objective is not an accounting margin on revenue.

The view shows actual CPA, calculated maximum, prudent limit, headroom, mature contribution breakdown and campaign/adset/ad rows. Manual scenarios use gross front ticket, mentorship conversion × ticket, expected bump and refunds, and the same modeled costs. They remain explicit hypotheses and never qualify a scope for scale.

Default guards: costs unconfirmed until reviewed; at least 30 mature buyers; at least 80% of the cohort mature; healthy Tracking Health; matching local UTMify snapshot and exact object IDs; <=5% per-scope front purchase/revenue divergence; positive media spend and purchases. Mentorship revenue depending on fewer than three mentorship buyers or >50% from one buyer remains provisional. Open-period snapshots older than 24 hours are provisional. These are operational guardrails, not statistical guarantees or an automated media control system.

## Revenue and LTV

`GET /api/revenue/ltv` is cohort-based: the selected date range chooses the front-end buyers, then downstream revenue for those same attributed buyers is accumulated through the present.

It reports:
- front-end purchases/revenue;
- mentorship purchases/revenue;
- future bump revenue;
- refunds;
- net revenue;
- LTV per front-end buyer;
- mentorship attach rate;
- booked/attended call metrics.

`GET /api/experiments/:slug/performance` compares landing-page variants through downstream outcomes, not just lead conversion.

## Routing/compliance boundary

Routing is for legitimate traffic management: landing-page distribution, attribution continuity, traffic quality, geographic/device/source rules when added, and fraud/bot handling.

It must not be used to present different content to advertising-platform reviewers in order to evade platform policies. The same commercial offer must remain compliant for real users and platform review.

## Deployment rule

This work is isolated in a feature worktree. No merge, push, Render deploy, Meta synchronization or production mutation is authorized by this document.

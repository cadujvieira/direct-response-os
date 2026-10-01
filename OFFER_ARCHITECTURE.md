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

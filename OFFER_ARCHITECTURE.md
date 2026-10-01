# Direct Response OS — Offer Foundation

## Business model

The front-end product is R$297. The operation can run near break-even on the front-end because the main profit opportunity is the post-purchase mentorship funnel. Reporting must therefore separate front-end ROAS from total revenue and LTV.

## Canonical funnel

`click -> landing_view -> lead -> checkout_started -> purchase -> call_booked -> call_attended/call_no_show -> mentorship_offer -> mentorship_purchase`

Additional supported lifecycle events:
- `refund`
- `order_bump_purchase` (reserved for future tests)

All of these event names can use the existing generic `POST /track/event`. The normal front-end purchase continues to use `POST /track/purchase`.

## Experiments and one-link routing

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

Experiment configuration is not hard-coded. `PUT /api/experiments/:slug` with `x-admin-secret` creates or updates the experiment and its landing-page variants, including destination URLs, active flags and weights. Variants omitted from that configuration are disabled.

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
- `GET /api/crm/leads` exposes lead-level data only with `x-admin-secret`;
- `PATCH /api/crm/leads/:id` updates CRM state only with `x-admin-secret`.

Lead-level read/write routes require `DR_ADMIN_SECRET`. This variable must exist only in environment configuration, never in source.

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

Routing is for legitimate traffic management: experiments, attribution continuity, traffic quality, geographic/device/source rules when added, and fraud/bot handling.

It must not be used to present different content to advertising-platform reviewers in order to evade platform policies. The same commercial offer must remain compliant for real users and platform review.

## Deployment rule

This work is isolated in a feature worktree. No merge, push, Render deploy, Meta synchronization or production mutation is authorized by this document.

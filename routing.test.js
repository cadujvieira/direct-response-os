const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCookies,
  selectWeightedVariant,
  buildRedirectUrl,
  ensureIdentifier,
  resolveRouterIdentity,
  routingTrackingParams
} = require("./routing");

test("selectWeightedVariant is deterministic for the same key", () => {
  const variants = [
    { id: 1, name: "A", weight: 20, active: true },
    { id: 2, name: "B", weight: 20, active: true },
    { id: 3, name: "C", weight: 20, active: true },
    { id: 4, name: "D", weight: 20, active: true },
    { id: 5, name: "E", weight: 20, active: true }
  ];
  const first = selectWeightedVariant(variants, "click-123");
  const second = selectWeightedVariant(variants, "click-123");
  assert.equal(first.id, second.id);
});

test("weighted selector ignores inactive and zero-weight variants", () => {
  const variants = [
    { id: 1, name: "A", weight: 0, active: true },
    { id: 2, name: "B", weight: 100, active: false },
    { id: 3, name: "C", weight: 1, active: true }
  ];
  assert.equal(selectWeightedVariant(variants, "any-key").id, 3);
});

test("buildRedirectUrl preserves destination query and adds tracking", () => {
  const url = new URL(buildRedirectUrl("https://example.com/lp?existing=1", {
    click_id: "abc",
    utm_source: "meta"
  }));
  assert.equal(url.searchParams.get("existing"), "1");
  assert.equal(url.searchParams.get("click_id"), "abc");
  assert.equal(url.searchParams.get("utm_source"), "meta");
});

test("buildRedirectUrl blocks non-http protocols", () => {
  assert.throws(() => buildRedirectUrl("ftp://example.com/file", {}));
});

test("cookies and tracking params are normalized", () => {
  const cookies = parseCookies("dr_click_id=click_1; dr_session=session_1");
  assert.equal(cookies.dr_click_id, "click_1");
  assert.equal(cookies.dr_session, "session_1");
  const params = routingTrackingParams(
    { utm_campaign: "teste", fbclid: "fb-1", ignored: "x" },
    "click_1",
    "renda-extra",
    "LP_A"
  );
  assert.deepEqual(params, {
    utm_campaign: "teste",
    fbclid: "fb-1",
    click_id: "click_1",
    dr_experiment: "renda-extra",
    dr_variant: "LP_A"
  });
});

test("ensureIdentifier keeps provided values and creates missing values", () => {
  assert.equal(ensureIdentifier("existing", "dr"), "existing");
  assert.match(ensureIdentifier("", "dr"), /^dr_[0-9a-f-]{36}$/);
});

test("router keeps visitor sticky but creates a fresh click when none is supplied", () => {
  const cookies = { dr_visitor_id: "visitor_123", dr_click_id: "old_click" };
  const first = resolveRouterIdentity({}, cookies);
  const second = resolveRouterIdentity({}, cookies);

  assert.equal(first.visitorKey, "visitor_123");
  assert.equal(second.visitorKey, "visitor_123");
  assert.notEqual(first.clickId, second.clickId);
  assert.notEqual(first.clickId, "old_click");
});

test("router preserves an explicit inbound click_id", () => {
  const identity = resolveRouterIdentity(
    { click_id: "external_click_1" },
    { dr_visitor_id: "visitor_123" }
  );

  assert.equal(identity.clickId, "external_click_1");
  assert.equal(identity.visitorKey, "visitor_123");
});

test("equal weights distribute a large visitor sample without material bias", () => {
  const variants = ["A", "B", "C", "D", "E"].map((name, index) => ({
    id: index + 1,
    name,
    weight: 20,
    active: true
  }));
  const counts = Object.fromEntries(variants.map((variant) => [variant.name, 0]));

  for (let index = 0; index < 10000; index += 1) {
    const selected = selectWeightedVariant(variants, "visitor-" + index);
    counts[selected.name] += 1;
  }

  for (const count of Object.values(counts)) {
    assert.ok(count > 1800 && count < 2200, "distribution outside expected range");
  }
});

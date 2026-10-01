const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveCrmState,
  normalizeWeightUpdates
} = require("./offerFoundation");

test("checkout warms a cold lead and advances lifecycle", () => {
  assert.deepEqual(
    deriveCrmState("lead", "cold", "checkout_started"),
    { lifecycle_stage: "checkout", temperature: "warm" }
  );
});

test("older events do not regress a customer", () => {
  assert.deepEqual(
    deriveCrmState("mentorship_customer", "hot", "checkout_started"),
    { lifecycle_stage: "mentorship_customer", temperature: "hot" }
  );
});

test("mentorship purchase advances to final commercial stage", () => {
  assert.deepEqual(
    deriveCrmState("customer", "hot", "mentorship_purchase"),
    { lifecycle_stage: "mentorship_customer", temperature: "hot" }
  );
});

test("refund explicitly moves lifecycle to refunded", () => {
  assert.deepEqual(
    deriveCrmState("mentorship_customer", "hot", "refund"),
    { lifecycle_stage: "refunded", temperature: "hot" }
  );
});

test("unknown events do not create CRM transitions", () => {
  assert.equal(deriveCrmState("lead", "cold", "landing_view"), null);
});

test("weight updates accept arbitrary relative traffic mixes", () => {
  assert.deepEqual(
    normalizeWeightUpdates({
      LP_A: 50,
      LP_B: 20,
      LP_C: 15,
      LP_D: 10,
      LP_E: 5
    }),
    [
      { name: "LP_A", weight: 50 },
      { name: "LP_B", weight: 20 },
      { name: "LP_C", weight: 15 },
      { name: "LP_D", weight: 10 },
      { name: "LP_E", weight: 5 }
    ]
  );
});

test("weight updates allow zero to remove traffic from a variant", () => {
  assert.deepEqual(
    normalizeWeightUpdates({ LP_A: 80, LP_B: 20, LP_C: 0 }),
    [
      { name: "LP_A", weight: 80 },
      { name: "LP_B", weight: 20 },
      { name: "LP_C", weight: 0 }
    ]
  );
});

test("weight updates reject negative values", () => {
  assert.throws(
    () => normalizeWeightUpdates({ LP_A: -1 }),
    /peso deve ser/
  );
});

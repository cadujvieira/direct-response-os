const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveCrmState,
  normalizeExperimentConfig,
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

test("experiment config accepts custom traffic weights and urls", () => {
  const config = normalizeExperimentConfig({
    name: "Oferta Dolar",
    variants: [
      { name: "LP_A", destination_url: "https://example.com/a", weight: 70 },
      { name: "LP_B", destination_url: "https://example.com/b", weight: 30 },
      { name: "LP_C", destination_url: "https://example.com/c", weight: 0 }
    ]
  });

  assert.equal(config.name, "Oferta Dolar");
  assert.equal(config.variants[0].weight, 70);
  assert.equal(config.variants[2].weight, 0);
});

test("experiment config rejects duplicate variant names", () => {
  assert.throws(
    () => normalizeExperimentConfig({
      name: "Teste",
      variants: [
        { name: "LP_A", destination_url: "https://example.com/a", weight: 50 },
        { name: "LP_A", destination_url: "https://example.com/b", weight: 50 }
      ]
    }),
    /unicos/
  );
});

test("experiment config rejects an all-zero active mix", () => {
  assert.throws(
    () => normalizeExperimentConfig({
      name: "Teste",
      variants: [
        { name: "LP_A", destination_url: "https://example.com/a", weight: 0 },
        { name: "LP_B", destination_url: "https://example.com/b", weight: 0 }
      ]
    }),
    /peso maior que zero/
  );
});

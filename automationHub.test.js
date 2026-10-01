const test = require("node:test");
const assert = require("node:assert/strict");

const {
  describeConditions,
  normalizeAutomationRule
} = require("./automationHub");

function validRule(overrides = {}) {
  return {
    key: "custom_followup",
    name: "Follow-up customizado",
    description: "Regra de teste",
    trigger_event: "purchase",
    delay_minutes: 60,
    conditions: {
      missing_events: ["call_booked"],
      skip_lifecycle_stages: ["refunded"]
    },
    action_type: "create_followup",
    action_config: {
      priority: "high",
      note: "Entrar em contato."
    },
    active: true,
    ...overrides
  };
}

test("normaliza uma regra valida no formato do Automation Hub", () => {
  const rule = normalizeAutomationRule(validRule(), { creating: true });

  assert.equal(rule.key, "custom_followup");
  assert.equal(rule.name, "Follow-up customizado");
  assert.equal(rule.trigger_event, "purchase");
  assert.equal(rule.delay_minutes, 60);
  assert.deepEqual(rule.conditions.missing_events, ["call_booked"]);
  assert.deepEqual(rule.conditions.skip_lifecycle_stages, ["refunded"]);
  assert.equal(rule.action_type, "create_followup");
  assert.equal(rule.action_config.priority, "high");
  assert.equal(rule.active, true);
});

test("rejeita delay negativo", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({ delay_minutes: -1 }),
      { creating: true }
    ),
    /delay_minutes/
  );
});

test("rejeita delay acima de 30 dias", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({ delay_minutes: 43201 }),
      { creating: true }
    ),
    /delay_minutes/
  );
});

test("rejeita lifecycle stage invalido nas condicoes", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({
        conditions: {
          missing_events: [],
          skip_lifecycle_stages: ["cliente_vip_inventado"]
        }
      }),
      { creating: true }
    ),
    /skip_lifecycle_stages/
  );
});

test("rejeita action type nao suportado", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({ action_type: "execute_code" }),
      { creating: true }
    ),
    /action_type/
  );
});

test("rejeita prioridade de follow-up invalida", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({
        action_config: {
          priority: "critical",
          note: "Entrar em contato."
        }
      }),
      { creating: true }
    ),
    /prioridade/
  );
});

test("descricao de condicoes resume eventos ausentes e etapas ignoradas", () => {
  const description = describeConditions({
    missing_events: ["purchase", "call_booked"],
    skip_lifecycle_stages: ["refunded", "mentorship_customer"]
  });

  assert.match(description, /purchase/);
  assert.match(description, /call_booked/);
  assert.match(description, /refunded/);
  assert.match(description, /mentorship_customer/);
});

test("rejeita key insegura em regra customizada", () => {
  assert.throws(
    () => normalizeAutomationRule(
      validRule({ key: "DROP TABLE rules;" }),
      { creating: true }
    ),
    /key/
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatPhoneE164Br,
  isEligibleContact,
  normalizeExportInput
} = require("./activationHub");

test("normaliza lote de exportacao valido", () => {
  const value = normalizeExportInput({
    name: "Front sem call - lote 1",
    export_format: "phone",
    exclusion_days: 7,
    lead_ids: [1, 2, 2, 3],
    filters: { segment: "frontend_no_call" }
  });

  assert.equal(value.name, "Front sem call - lote 1");
  assert.equal(value.export_format, "phone");
  assert.equal(value.exclusion_days, 7);
  assert.deepEqual(value.lead_ids, [1, 2, 3]);
  assert.deepEqual(value.filters, { segment: "frontend_no_call" });
});

test("remove chaves de filtro nao reconhecidas do historico", () => {
  const value = normalizeExportInput({
    name: "Teste",
    export_format: "contacts",
    exclusion_days: 0,
    lead_ids: [1],
    filters: {
      segment: "frontend_no_call",
      _source_label: "Front sem call",
      arbitrary_payload: "<script>alert(1)</script>",
      _batch_size: 500
    }
  });

  assert.deepEqual(value.filters, {
    segment: "frontend_no_call",
    _source_label: "Front sem call",
    _batch_size: 500
  });
});

test("rejeita formato de exportacao invalido", () => {
  assert.throws(
    () => normalizeExportInput({
      name: "Teste",
      export_format: "execute_script",
      exclusion_days: 0,
      lead_ids: [1]
    }),
    /formato/
  );
});

test("rejeita janela de exclusao fora das opcoes", () => {
  assert.throws(
    () => normalizeExportInput({
      name: "Teste",
      export_format: "contacts",
      exclusion_days: 15,
      lead_ids: [1]
    }),
    /janela/
  );
});

test("rejeita lote acima de 5000 contatos", () => {
  assert.throws(
    () => normalizeExportInput({
      name: "Teste",
      export_format: "contacts",
      exclusion_days: 0,
      lead_ids: Array.from({ length: 5001 }, (_, index) => index + 1)
    }),
    /5000/
  );
});

test("formato telefone exige telefone", () => {
  assert.equal(
    isEligibleContact(
      { email: "teste@example.com", telefone: null },
      "phone"
    ),
    false
  );

  assert.equal(
    isEligibleContact(
      { email: null, telefone: "(11) 99999-9999" },
      "phone"
    ),
    true
  );
});

test("formato email exige email", () => {
  assert.equal(
    isEligibleContact(
      { email: null, telefone: "11999999999" },
      "email"
    ),
    false
  );

  assert.equal(
    isEligibleContact(
      { email: "teste@example.com", telefone: null },
      "email"
    ),
    true
  );
});

test("formato contatos aceita telefone ou email", () => {
  assert.equal(
    isEligibleContact({ email: null, telefone: null }, "contacts"),
    false
  );
  assert.equal(
    isEligibleContact({ email: "a@b.com", telefone: null }, "contacts"),
    true
  );
});

test("normaliza telefone brasileiro para e164 sem inventar pais em numeros desconhecidos", () => {
  assert.equal(formatPhoneE164Br("(11) 99999-9999"), "+5511999999999");
  assert.equal(formatPhoneE164Br("5511999999999"), "+5511999999999");
  assert.equal(formatPhoneE164Br("123456"), "123456");
});

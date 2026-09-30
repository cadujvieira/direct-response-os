const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMetaStatus,
  secretMatches,
  normalizeAdAccountId,
  resolveMetaSyncRange,
  buildInitialInsightsUrl,
  fetchMetaInsights,
  runMetaSync
} = require("./metaAds");

const {
  normalizeSpendInput
} = require("./spendStore");

test("status nunca expoe valores de credenciais", () => {
  const env = {
    META_ACCESS_TOKEN: "token-secreto",
    META_AD_ACCOUNT_ID: "123",
    META_API_VERSION: "v99.0",
    META_SYNC_SECRET: "sync-secreto"
  };

  const status = getMetaStatus(env);

  assert.equal(status.configured, true);
  assert.equal(status.has_access_token, true);
  assert.equal(status.has_ad_account, true);
  assert.equal(status.has_api_version, true);
  assert.equal(status.has_sync_secret, true);
  assert.equal(JSON.stringify(status).includes("token-secreto"), false);
  assert.equal(JSON.stringify(status).includes("sync-secreto"), false);
});

test("normaliza conta Meta para act_", () => {
  assert.equal(normalizeAdAccountId("123"), "act_123");
  assert.equal(normalizeAdAccountId("act_123"), "act_123");
});
test("range padrao usa ontem ate hoje em Sao Paulo", () => {
  const now = new Date("2026-09-30T15:00:00Z");
  const range = resolveMetaSyncRange({}, now);

  assert.deepEqual(range, {
    from: "2026-09-29",
    to: "2026-09-30"
  });
});

test("range parcial vira um unico dia", () => {
  assert.deepEqual(
    resolveMetaSyncRange({ from: "2026-09-20" }),
    { from: "2026-09-20", to: "2026-09-20" }
  );

  assert.deepEqual(
    resolveMetaSyncRange({ to: "2026-09-21" }),
    { from: "2026-09-21", to: "2026-09-21" }
  );
});

test("range invalido retorna erro 400", () => {
  assert.throws(
    () => resolveMetaSyncRange({
      from: "2026-09-30",
      to: "2026-09-20"
    }),
    (error) => error.statusCode === 400
  );
});

test("URL inicial nao inclui token e normaliza ad account", () => {
  const url = new URL(buildInitialInsightsUrl(
    {
      accessToken: "SECRET",
      adAccountId: "123",
      apiVersion: "v99.0"
    },
    "2026-09-29",
    "2026-09-30"
  ));

  assert.equal(url.pathname, "/v99.0/act_123/insights");
  assert.equal(url.searchParams.get("level"), "ad");
  assert.equal(url.searchParams.has("access_token"), false);
  assert.equal(url.searchParams.get("time_increment"), "1");
  assert.equal(url.searchParams.get("limit"), "100");
});
test("paginacao remove access_token do paging.next", async () => {
  const calls = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });

    if (calls.length === 1) {
      return {
        ok: true,
        async json() {
          return {
            data: [{ date_start: "2026-09-29" }],
            paging: {
              next:
                "https://graph.facebook.com/v99.0/act_123/insights?after=abc&access_token=SECRET"
            }
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          data: [{ date_start: "2026-09-30" }]
        };
      }
    };
  };

  const result = await fetchMetaInsights({
    config: {
      accessToken: "SECRET",
      adAccountId: "123",
      apiVersion: "v99.0"
    },
    from: "2026-09-29",
    to: "2026-09-30",
    fetchImpl
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(calls[1].url.includes("access_token"), false);
  assert.equal(calls[0].options.headers.Authorization, "Bearer SECRET");
  assert.equal(calls[1].options.headers.Authorization, "Bearer SECRET");
});
test("spend manual rejeita valores negativos", () => {
  assert.throws(
    () => normalizeSpendInput({
      spend_date: "2026-09-30",
      campaign_id: "123",
      spend: -1,
      impressions: 10,
      clicks: 2
    }),
    (error) => error.statusCode === 400
  );
});

test("sync persiste linha valida em transacao", async () => {
  const queries = [];
  let released = false;

  const client = {
    async query(sql) {
      queries.push(String(sql));

      if (String(sql).includes("INSERT INTO dr_ad_spend")) {
        return {
          rows: [{ id: 1 }]
        };
      }

      return { rows: [] };
    },
    release() {
      released = true;
    }
  };

  const pool = {
    async connect() {
      return client;
    }
  };

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        data: [
          null,
          {
            date_start: "2026-09-30",
            campaign_id: "123",
            campaign_name: "Campanha",
            adset_id: "456",
            adset_name: "Conjunto",
            ad_id: "789",
            ad_name: "Anuncio",
            account_currency: "BRL",
            spend: "50.25",
            impressions: "1000",
            clicks: "25"
          }
        ]
      };
    }
  });
  const result = await runMetaSync({
    pool,
    body: {
      from: "2026-09-30",
      to: "2026-09-30"
    },
    env: {
      META_ACCESS_TOKEN: "SECRET",
      META_AD_ACCOUNT_ID: "123",
      META_API_VERSION: "v99.0"
    },
    fetchImpl
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.upserted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.pages, 1);
  assert.equal(queries[0], "BEGIN");
  assert.equal(
    queries.some((sql) => sql.includes("INSERT INTO dr_ad_spend")),
    true
  );
  assert.equal(queries.at(-1), "COMMIT");
  assert.equal(released, true);
});

test("sync sem configuracao informa apenas chaves ausentes", async () => {
  await assert.rejects(
    () => runMetaSync({
      pool: {},
      env: {},
      body: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.deepEqual(
        error.missing,
        [
          "META_ACCESS_TOKEN",
          "META_AD_ACCOUNT_ID",
          "META_API_VERSION"
        ]
      );
      return true;
    }
  );
});


test("erro da Meta e sanitizado sem token/provider body", async () => {
  const fetchImpl = async () => ({
    ok: false,
    async json() {
      return {
        error: {
          code: 190,
          message: "Invalid token SECRET-LEAK"
        }
      };
    }
  });

  await assert.rejects(
    () => fetchMetaInsights({
      config: {
        accessToken: "SECRET-LEAK",
        adAccountId: "123",
        apiVersion: "v99.0"
      },
      from: "2026-09-30",
      to: "2026-09-30",
      fetchImpl
    }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message.includes("SECRET-LEAK"), false);
      assert.equal(error.providerCode, "190");
      return true;
    }
  );
});

test("paginacao respeita limite de seguranca", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        data: [],
        paging: {
          next: "https://graph.facebook.com/v99.0/next?after=x"
        }
      };
    }
  });

  await assert.rejects(
    () => fetchMetaInsights({
      config: {
        accessToken: "SECRET",
        adAccountId: "123",
        apiVersion: "v99.0"
      },
      from: "2026-09-30",
      to: "2026-09-30",
      fetchImpl,
      pageCap: 1
    }),
    (error) => error.statusCode === 502
  );
});


test("paginacao rejeita host externo para nao vazar bearer token", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        data: [],
        paging: {
          next: "https://evil.example/steal?after=x"
        }
      };
    }
  });

  await assert.rejects(
    () => fetchMetaInsights({
      config: {
        accessToken: "SECRET",
        adAccountId: "123",
        apiVersion: "v99.0"
      },
      from: "2026-09-30",
      to: "2026-09-30",
      fetchImpl
    }),
    (error) => error.statusCode === 502
  );
});


test("comparacao do sync secret exige valor exato", () => {
  assert.equal(secretMatches("abc123", "abc123"), true);
  assert.equal(secretMatches("abc123", "abc124"), false);
  assert.equal(secretMatches("", "abc123"), false);
  assert.equal(secretMatches("abc123", ""), false);
});


test("sync recusa conta Meta fora de BRL para evitar ROAS incorreto", async () => {
  const client = {
    async query() {
      return { rows: [] };
    },
    release() {}
  };

  const pool = {
    async connect() {
      return client;
    }
  };

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        data: [{
          date_start: "2026-09-30",
          campaign_id: "123",
          adset_id: "456",
          ad_id: "789",
          account_currency: "USD",
          spend: "10",
          impressions: "100",
          clicks: "5"
        }]
      };
    }
  });

  await assert.rejects(
    () => runMetaSync({
      pool,
      body: {
        from: "2026-09-30",
        to: "2026-09-30"
      },
      env: {
        META_ACCESS_TOKEN: "SECRET",
        META_AD_ACCOUNT_ID: "123",
        META_API_VERSION: "v99.0"
      },
      fetchImpl
    }),
    (error) => error.statusCode === 409
  );
});

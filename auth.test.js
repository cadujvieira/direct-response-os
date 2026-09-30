const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  safeUser,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  hashPassword,
  verifyPassword,
  ensureBootstrapAdmin
} = require("./auth");

test("normaliza email sem alterar outros dados", () => {
  assert.equal(
    normalizeEmail("  CLIENTE@EXEMPLO.COM "),
    "cliente@exemplo.com"
  );
});

test("hash de senha nao armazena texto puro", async () => {
  const password = "SenhaForte123";
  const hash = await hashPassword(password);

  assert.equal(hash.startsWith("scrypt$"), true);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("SenhaErrada123", hash), false);
});

test("senha curta e rejeitada", async () => {
  await assert.rejects(
    () => hashPassword("123"),
    (error) =>
      error.statusCode === 400 &&
      error.message.includes(String(PASSWORD_MIN_LENGTH))
  );
});

test("safeUser nunca retorna password_hash", () => {
  const user = safeUser({
    id: 1,
    name: "Cliente",
    email: "cliente@exemplo.com",
    role: "viewer",
    is_active: true,
    password_hash: "nao-pode-vazar",
    created_at: new Date()
  });

  assert.equal(user.password_hash, undefined);
  assert.equal(user.role, "viewer");
});
test("cookies de sessao usam HttpOnly e Secure em producao", () => {
  const cookie = buildSessionCookie("TOKEN", true);

  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /dr_session=TOKEN/);

  const clear = buildClearCookie(true);

  assert.match(clear, /Max-Age=0/);
  assert.match(clear, /Secure/);
});

test("parseCookies recupera sessao", () => {
  const parsed = parseCookies(
    "theme=dark; dr_session=abc123; other=x"
  );

  assert.equal(parsed.dr_session, "abc123");
  assert.equal(parsed.theme, "dark");
});

test("bootstrap admin grava hash e nunca senha pura", async () => {
  const calls = [];

  const pool = {
    async query(sql, params = []) {
      calls.push({
        sql: String(sql),
        params
      });

      if (String(sql).includes("SELECT id")) {
        return { rows: [] };
      }

      return { rows: [] };
    }
  };

  const result = await ensureBootstrapAdmin(pool, {
    DR_ADMIN_NAME: "Administrador",
    DR_ADMIN_EMAIL: "ADMIN@EXEMPLO.COM",
    DR_ADMIN_PASSWORD: "SenhaForte123"
  });

  assert.equal(result.configured, true);
  assert.equal(result.created, true);

  const insert = calls.find((call) =>
    call.sql.includes("INSERT INTO dr_users")
  );

  assert.ok(insert);
  assert.equal(insert.params[0], "Administrador");
  assert.equal(insert.params[1], "admin@exemplo.com");
  assert.equal(insert.params[2].startsWith("scrypt$"), true);
  assert.equal(insert.params.includes("SenhaForte123"), false);
});

test("viewer e bloqueado pelo middleware de administrador", async () => {
  const { createAuthService } = require("./auth");

  const pool = {
    async query() {
      return {
        rows: [{
          id: 2,
          name: "Cliente",
          email: "cliente@exemplo.com",
          role: "viewer",
          is_active: true
        }]
      };
    }
  };

  const auth = createAuthService(pool, {
    NODE_ENV: "production"
  });

  const req = {
    headers: {
      cookie: "dr_session=token-valido"
    },
    socket: {}
  };

  let statusCode = null;
  let payload = null;
  let nextCalled = false;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    }
  };

  await auth.requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.equal(payload.error, "acesso restrito ao administrador");
});

test("admin passa pelo middleware de administrador", async () => {
  const { createAuthService } = require("./auth");

  const pool = {
    async query() {
      return {
        rows: [{
          id: 1,
          name: "Admin",
          email: "admin@exemplo.com",
          role: "admin",
          is_active: true
        }]
      };
    }
  };

  const auth = createAuthService(pool, {});
  const req = {
    headers: {
      cookie: "dr_session=token-valido"
    },
    socket: {}
  };

  let nextCalled = false;

  const res = {
    status() {
      return this;
    },
    json() {
      return this;
    }
  };

  await auth.requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.user.role, "admin");
});

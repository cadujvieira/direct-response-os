const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);

const SESSION_COOKIE = "dr_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 10;

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function safeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    is_active: row.is_active,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null
  };
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function parseCookies(header = "") {
  const cookies = {};

  String(header)
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index < 0) return;

      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      if (key) {
        try {
          cookies[key] = decodeURIComponent(value);
        } catch (error) {
          cookies[key] = value;
        }
      }
    });

  return cookies;
}

function buildSessionCookie(token, production) {
  const parts = [
    SESSION_COOKIE + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
  ];

  if (production) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildClearCookie(production) {
  const parts = [
    SESSION_COOKIE + "=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (production) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
function validatePassword(password) {
  const value = String(password || "");

  if (value.length < PASSWORD_MIN_LENGTH) {
    const error = new Error(
      "a senha deve ter pelo menos " +
        PASSWORD_MIN_LENGTH +
        " caracteres"
    );
    error.statusCode = 400;
    throw error;
  }

  if (value.length > 256) {
    const error = new Error("senha muito longa");
    error.statusCode = 400;
    throw error;
  }

  return value;
}

async function hashPassword(password) {
  const finalPassword = validatePassword(password);
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scryptAsync(finalPassword, salt, 64);

  return [
    "scrypt",
    salt,
    Buffer.from(derived).toString("base64url")
  ].join("$");
}

async function verifyPassword(password, storedHash) {
  try {
    if (String(password || "").length > 256) {
      return false;
    }

    const [scheme, salt, encoded] =
      String(storedHash || "").split("$");

    if (!scheme || scheme !== "scrypt" || !salt || !encoded) {
      return false;
    }

    const expected = Buffer.from(encoded, "base64url");
    const derived = Buffer.from(
      await scryptAsync(String(password || ""), salt, expected.length)
    );

    return (
      expected.length === derived.length &&
      crypto.timingSafeEqual(expected, derived)
    );
  } catch (error) {
    return false;
  }
}

async function initAuthDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer'
        CHECK (role IN ('admin', 'viewer')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dr_users_email_unique
    ON dr_users (LOWER(TRIM(email)));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dr_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL
        REFERENCES dr_users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_sessions_user_id_idx
    ON dr_sessions (user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS dr_sessions_expires_at_idx
    ON dr_sessions (expires_at);
  `);

  await pool.query(`
    DELETE FROM dr_sessions
    WHERE expires_at <= NOW();
  `);
}
async function getAuthStatus(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE role = 'admin' AND is_active = TRUE
      )::int AS active_admins,
      COUNT(*) FILTER (
        WHERE is_active = TRUE
      )::int AS active_users
    FROM dr_users
  `);

  const row = result.rows[0] || {};

  return {
    ready: Number(row.active_admins || 0) > 0,
    active_admins: Number(row.active_admins || 0),
    active_users: Number(row.active_users || 0)
  };
}

async function ensureBootstrapAdmin(pool, env = process.env) {
  const email = normalizeEmail(env.DR_ADMIN_EMAIL);
  const password = String(env.DR_ADMIN_PASSWORD || "");
  const name = clean(env.DR_ADMIN_NAME) || "Administrador";

  if (!email || !password) {
    return {
      configured: false,
      created: false
    };
  }

  validatePassword(password);

  const existing = await pool.query(`
    SELECT id
    FROM dr_users
    WHERE LOWER(TRIM(email)) = $1
    LIMIT 1
  `, [email]);

  if (existing.rows[0]) {
    return {
      configured: true,
      created: false
    };
  }

  const passwordHash = await hashPassword(password);

  await pool.query(`
    INSERT INTO dr_users (
      name,
      email,
      password_hash,
      role,
      is_active
    )
    VALUES ($1, $2, $3, 'admin', TRUE)
  `, [name, email, passwordHash]);

  return {
    configured: true,
    created: true
  };
}

async function findUserByEmail(pool, email) {
  const result = await pool.query(`
    SELECT
      id,
      name,
      email,
      password_hash,
      role,
      is_active,
      last_login_at,
      created_at
    FROM dr_users
    WHERE LOWER(TRIM(email)) = $1
    LIMIT 1
  `, [normalizeEmail(email)]);

  return result.rows[0] || null;
}
async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await pool.query(`
    DELETE FROM dr_sessions
    WHERE expires_at <= NOW()
  `);

  await pool.query(`
    INSERT INTO dr_sessions (
      user_id,
      token_hash,
      expires_at
    )
    VALUES ($1, $2, $3)
  `, [userId, tokenHash, expiresAt]);

  return {
    token,
    expires_at: expiresAt
  };
}

async function destroySession(pool, req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];

  if (!token) return;

  await pool.query(`
    DELETE FROM dr_sessions
    WHERE token_hash = $1
  `, [sha256(token)]);
}

async function getUserFromRequest(pool, req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];

  if (!token) return null;

  const result = await pool.query(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      u.is_active,
      u.last_login_at,
      u.created_at
    FROM dr_sessions s
    JOIN dr_users u
      ON u.id = s.user_id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW()
      AND u.is_active = TRUE
    LIMIT 1
  `, [sha256(token)]);

  return safeUser(result.rows[0]);
}

async function authenticate(pool, email, password) {
  const user = await findUserByEmail(pool, email);

  if (!user || !user.is_active) {
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    return null;
  }

  await pool.query(`
    UPDATE dr_users
    SET last_login_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [user.id]);

  return safeUser({
    ...user,
    last_login_at: new Date()
  });
}
async function createUser(
  pool,
  { name, email, password, role = "viewer" }
) {
  const finalName = clean(name);
  const finalEmail = normalizeEmail(email);
  if (!["admin", "viewer"].includes(role)) {
    const error = new Error("permissao invalida");
    error.statusCode = 400;
    throw error;
  }

  const finalRole = role;

  if (!finalName) {
    const error = new Error("nome obrigatorio");
    error.statusCode = 400;
    throw error;
  }

  if (!finalEmail || !finalEmail.includes("@")) {
    const error = new Error("email invalido");
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await hashPassword(password);

  try {
    const result = await pool.query(`
      INSERT INTO dr_users (
        name,
        email,
        password_hash,
        role,
        is_active
      )
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING
        id,
        name,
        email,
        role,
        is_active,
        last_login_at,
        created_at
    `, [
      finalName,
      finalEmail,
      passwordHash,
      finalRole
    ]);

    return safeUser(result.rows[0]);
  } catch (error) {
    if (error && error.code === "23505") {
      const duplicate = new Error("email ja cadastrado");
      duplicate.statusCode = 409;
      throw duplicate;
    }

    throw error;
  }
}

async function listUsers(pool) {
  const result = await pool.query(`
    SELECT
      id,
      name,
      email,
      role,
      is_active,
      last_login_at,
      created_at
    FROM dr_users
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      is_active DESC,
      name ASC
  `);

  return result.rows.map(safeUser);
}

async function updateUser(
  pool,
  userId,
  { is_active, role, name }
) {
  const id = Number(userId);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("usuario invalido");
    error.statusCode = 400;
    throw error;
  }

  const currentResult = await pool.query(`
    SELECT *
    FROM dr_users
    WHERE id = $1
    LIMIT 1
  `, [id]);

  const current = currentResult.rows[0];

  if (!current) {
    const error = new Error("usuario nao encontrado");
    error.statusCode = 404;
    throw error;
  }

  const finalName =
    name == null
      ? current.name
      : clean(name);

  if (
    role != null &&
    !["admin", "viewer"].includes(role)
  ) {
    const error = new Error("permissao invalida");
    error.statusCode = 400;
    throw error;
  }

  const finalRole =
    role == null
      ? current.role
      : role;

  if (
    is_active != null &&
    typeof is_active !== "boolean"
  ) {
    const error = new Error("status de usuario invalido");
    error.statusCode = 400;
    throw error;
  }

  const finalActive =
    is_active == null
      ? current.is_active
      : is_active;

  if (!finalName) {
    const error = new Error("nome obrigatorio");
    error.statusCode = 400;
    throw error;
  }

  if (
    current.role === "admin" &&
    (finalRole !== "admin" || !finalActive)
  ) {
    const remainingAdmins = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM dr_users
      WHERE role = 'admin'
        AND is_active = TRUE
        AND id <> $1
    `, [id]);

    if (Number(remainingAdmins.rows[0]?.total || 0) === 0) {
      const error = new Error(
        "nao e possivel remover o ultimo administrador ativo"
      );
      error.statusCode = 400;
      throw error;
    }
  }

  const result = await pool.query(`
    UPDATE dr_users
    SET
      name = $2,
      role = $3,
      is_active = $4,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      name,
      email,
      role,
      is_active,
      last_login_at,
      created_at
  `, [id, finalName, finalRole, finalActive]);

  if (!finalActive) {
    await pool.query(`
      DELETE FROM dr_sessions
      WHERE user_id = $1
    `, [id]);
  }

  return safeUser(result.rows[0]);
}
async function resetUserPassword(pool, userId, password) {
  const id = Number(userId);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("usuario invalido");
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await hashPassword(password);

  const result = await pool.query(`
    UPDATE dr_users
    SET
      password_hash = $2,
      updated_at = NOW()
    WHERE id = $1
    RETURNING id
  `, [id, passwordHash]);

  if (!result.rows[0]) {
    const error = new Error("usuario nao encontrado");
    error.statusCode = 404;
    throw error;
  }

  await pool.query(`
    DELETE FROM dr_sessions
    WHERE user_id = $1
  `, [id]);

  return true;
}

function createLoginLimiter({
  maxAttempts = 8,
  windowMs = 15 * 60 * 1000
} = {}) {
  const attempts = new Map();

  function prune(now = Date.now()) {
    if (attempts.size < 1000) return;

    for (const [key, item] of attempts.entries()) {
      if (now - item.started_at > windowMs) {
        attempts.delete(key);
      }
    }

    if (attempts.size > 5000) {
      attempts.clear();
    }
  }

  function keyFor(req, email) {
    const forwarded =
      String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();

    const ip =
      forwarded ||
      req.socket.remoteAddress ||
      "unknown";

    return ip + "|" + normalizeEmail(email);
  }

  function isBlocked(req, email) {
    prune();

    const key = keyFor(req, email);
    const item = attempts.get(key);

    if (!item) return false;

    if (Date.now() - item.started_at > windowMs) {
      attempts.delete(key);
      return false;
    }

    return item.count >= maxAttempts;
  }

  function fail(req, email) {
    const now = Date.now();
    prune(now);

    const key = keyFor(req, email);
    const item = attempts.get(key);

    if (!item || now - item.started_at > windowMs) {
      attempts.set(key, {
        count: 1,
        started_at: now
      });
      return;
    }

    item.count += 1;
  }

  function success(req, email) {
    attempts.delete(keyFor(req, email));
  }

  return {
    isBlocked,
    fail,
    success
  };
}
function createAuthService(pool, env = process.env) {
  const production = env.NODE_ENV === "production";
  const limiter = createLoginLimiter();

  async function requireAuth(req, res, next) {
    try {
      const user = await getUserFromRequest(pool, req);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "autenticacao necessaria"
        });
      }

      req.user = user;
      next();
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "erro interno"
      });
    }
  }

  async function requireAdmin(req, res, next) {
    try {
      const user = await getUserFromRequest(pool, req);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "autenticacao necessaria"
        });
      }

      if (user.role !== "admin") {
        return res.status(403).json({
          ok: false,
          error: "acesso restrito ao administrador"
        });
      }

      req.user = user;
      next();
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "erro interno"
      });
    }
  }

  async function requirePageAuth(req, res, next) {
    try {
      const user = await getUserFromRequest(pool, req);

      if (!user) {
        return res.redirect("/login");
      }

      req.user = user;
      next();
    } catch (error) {
      res.redirect("/login");
    }
  }

  return {
    production,
    limiter,
    requireAuth,
    requireAdmin,
    requirePageAuth
  };
}

module.exports = {
  SESSION_COOKIE,
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  safeUser,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  hashPassword,
  verifyPassword,
  initAuthDb,
  getAuthStatus,
  ensureBootstrapAdmin,
  authenticate,
  createSession,
  destroySession,
  getUserFromRequest,
  createUser,
  listUsers,
  updateUser,
  resetUserPassword,
  createAuthService
};

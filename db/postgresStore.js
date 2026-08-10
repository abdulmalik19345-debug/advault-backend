// db/postgresStore.js
// ============================================================================
// PostgreSQL store for AdVault Spy (production database).
//
// Implements the exact same store interface as sqliteStore.js (see db/store.js)
// so the backend code does not change when pointed at Supabase PostgreSQL.
//
// Connection comes entirely from the DATABASE_URL environment variable
// (server-side only — never exposed to the browser). The schema is created
// automatically on first use and is also available as a standalone file at
// db/migrations/001_supabase_schema.sql for manual Supabase setup.
//
// Production: DB_ENGINE=postgres + DATABASE_URL=<Supabase connection string>.
// ============================================================================

const { Pool } = require("pg");
const crypto = require("node:crypto");

// Mirrors the SQLite schema 1:1. All timestamps are stored as TEXT in the same
// ISO-8601 format the rest of the app already uses, so existing behavior
// (lexicographic expiry comparisons, Date parsing) is preserved exactly.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id                      TEXT PRIMARY KEY,
    email                   TEXT NOT NULL UNIQUE,
    password_hash           TEXT NOT NULL,
    plan                    TEXT NOT NULL DEFAULT 'FREE',
    subscription_status     TEXT NOT NULL DEFAULT 'NONE',
    paypal_subscription_id  TEXT,
    email_verified_at       TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS usage_daily (
    user_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date),
    CONSTRAINT fk_usage_daily_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- DEV-ONLY: anonymous extension usage counter (see DEV_ANON_USAGE in server.js).
-- No FK to users — an anonymous device id never corresponds to a user account.
CREATE TABLE IF NOT EXISTS usage_dev_anon (
    device_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, date)
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    used_at     TEXT,
    CONSTRAINT fk_email_verification_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_verification_user_id ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_token_hash ON email_verification_tokens(token_hash);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    used_at         TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens(token_hash);

CREATE TABLE IF NOT EXISTS rate_events (
    key TEXT NOT NULL,
    ts  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_key_ts ON rate_events(key, ts);
`;

function nowIso() {
    return new Date().toISOString();
}

function createPostgresStore({ connectionString }) {
    if (!connectionString || typeof connectionString !== "string") {
        throw new Error(
            "DB_ENGINE=postgres requires DATABASE_URL (the Supabase " +
            "PostgreSQL connection string)."
        );
    }

    // Supabase requires TLS. If the connection string does not already carry an
    // sslmode parameter, default to TLS with normal certificate verification
    // (the Supabase pooler uses a publicly trusted certificate). When sslmode IS
    // present (e.g. ?sslmode=require), we leave the ssl option unset so pg's
    // pg-connection-string handles it — passing an explicit ssl would override it.
    let ssl;
    try {
        const parsed = new URL(connectionString);
        if (!parsed.searchParams.has("sslmode")) ssl = true;
    } catch {
        ssl = true;
    }

    const poolOptions = {
        connectionString,
        max: 10,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 30_000,
    };
    if (ssl) poolOptions.ssl = ssl;
    const pool = new Pool(poolOptions);

    // Schema initialization runs once; every store method awaits it so a cold
    // Supabase project is migrated automatically on first boot.
    let initPromise = null;
    function ensureSchema() {
        if (!initPromise) {
            initPromise = (async () => {
                await pool.query(SCHEMA_SQL);
                // Additive migration for databases created before
                // email_verified_at existed (mirrors sqliteStore.js).
                const has = await pool.query(
                    `SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema()
                       AND table_name = 'users'
                       AND column_name = 'email_verified_at'`
                );
                if (has.rowCount === 0) {
                    await pool.query(
                        "ALTER TABLE users ADD COLUMN email_verified_at TEXT"
                    );
                }
            })();
        }
        return initPromise;
    }

    const store = {
        label: "postgres",
        isMemory: false,

        // ---- Users ----
        async createUser({
            email,
            passwordHash,
            plan = "FREE",
            subscriptionStatus = "NONE",
            paypalSubscriptionId = null,
            emailVerifiedAt = null,
        }) {
            await ensureSchema();
            const user = {
                id: crypto.randomUUID(),
                email: String(email).toLowerCase().trim(),
                passwordHash,
                plan: String(plan).toUpperCase(),
                subscriptionStatus: String(subscriptionStatus).toUpperCase(),
                paypalSubscriptionId: paypalSubscriptionId || null,
                emailVerifiedAt,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            };
            await pool.query(
                `INSERT INTO users (
                    id, email, password_hash, plan, subscription_status,
                    paypal_subscription_id, email_verified_at, created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    user.id,
                    user.email,
                    user.passwordHash,
                    user.plan,
                    user.subscriptionStatus,
                    user.paypalSubscriptionId,
                    user.emailVerifiedAt,
                    user.createdAt,
                    user.updatedAt,
                ]
            );
            return user;
        },

        async findUserByEmail(email) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
                [String(email).toLowerCase().trim()]
            );
            return rows[0] || null;
        },

        async findUserById(id) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
                [id]
            );
            return rows[0] || null;
        },

        async updateUser(id, fields = {}) {
            await ensureSchema();
            const allowed = [
                "plan",
                "passwordHash",
                "subscriptionStatus",
                "paypalSubscriptionId",
                "emailVerifiedAt",
            ];
            const columnMap = {
                plan: "plan",
                passwordHash: "password_hash",
                subscriptionStatus: "subscription_status",
                paypalSubscriptionId: "paypal_subscription_id",
                emailVerifiedAt: "email_verified_at",
            };
            const sets = [];
            const values = [];
            for (const key of allowed) {
                if (key in fields) {
                    sets.push(`${columnMap[key]} = $${values.length + 1}`);
                    values.push(fields[key] ?? null);
                }
            }
            if (sets.length) {
                sets.push(`updated_at = $${values.length + 1}`);
                values.push(nowIso());
                values.push(id);
                await pool.query(
                    `UPDATE users SET ${sets.join(", ")} WHERE id = $${values.length}`,
                    values
                );
            }
            return store.findUserById(id);
        },

        // ---- Sessions ----
        async createSession({ tokenHash, userId, expiresAt }) {
            await ensureSchema();
            const session = { tokenHash, userId, createdAt: nowIso(), expiresAt };
            await pool.query(
                `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
                 VALUES ($1, $2, $3, $4)`,
                [tokenHash, userId, session.createdAt, expiresAt]
            );
            return session;
        },

        async findSessionByTokenHash(tokenHash) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT token_hash AS "tokenHash", user_id AS "userId",
                        created_at AS "createdAt", expires_at AS "expiresAt"
                 FROM sessions WHERE token_hash = $1`,
                [tokenHash]
            );
            return rows[0] || null;
        },

        async deleteSessionByTokenHash(tokenHash) {
            await ensureSchema();
            await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
                tokenHash,
            ]);
        },

        async deleteSessionsForUser(userId) {
            await ensureSchema();
            await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
        },

        async deleteExpiredSessions(nowIsoValue) {
            await ensureSchema();
            await pool.query("DELETE FROM sessions WHERE expires_at < $1", [
                nowIsoValue,
            ]);
        },

        // ---- Email Verification Tokens ----
        async createEmailVerificationToken({ userId, tokenHash, expiresAt }) {
            await ensureSchema();
            const token = {
                id: crypto.randomUUID(),
                userId,
                tokenHash,
                expiresAt,
                createdAt: nowIso(),
                usedAt: null,
            };
            await pool.query(
                `INSERT INTO email_verification_tokens
                    (id, user_id, token_hash, expires_at, created_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [token.id, token.userId, token.tokenHash, token.expiresAt, token.createdAt]
            );
            return token;
        },

        async findEmailVerificationTokenByHash(tokenHash) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT id, user_id AS "userId", token_hash AS "tokenHash",
                        expires_at AS "expiresAt", created_at AS "createdAt",
                        used_at AS "usedAt"
                 FROM email_verification_tokens WHERE token_hash = $1`,
                [tokenHash]
            );
            return rows[0] || null;
        },

        async findEmailVerificationTokensByUserId(userId) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT id, user_id AS "userId", token_hash AS "tokenHash",
                        expires_at AS "expiresAt", created_at AS "createdAt",
                        used_at AS "usedAt"
                 FROM email_verification_tokens
                 WHERE user_id = $1 AND used_at IS NULL`,
                [userId]
            );
            return rows;
        },

        async markEmailVerificationTokenUsed(tokenId, usedAt) {
            await ensureSchema();
            await pool.query(
                "UPDATE email_verification_tokens SET used_at = $1 WHERE id = $2",
                [usedAt, tokenId]
            );
        },

        async deleteEmailVerificationTokensForUser(userId) {
            await ensureSchema();
            await pool.query(
                "DELETE FROM email_verification_tokens WHERE user_id = $1",
                [userId]
            );
        },

        // ---- Password reset tokens ----
        async createPasswordResetToken({ userId, tokenHash, expiresAt }) {
            await ensureSchema();
            const token = { id: crypto.randomUUID(), userId, tokenHash, expiresAt, createdAt: nowIso(), usedAt: null };
            await pool.query(
                `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
                [token.id, token.userId, token.tokenHash, token.expiresAt, token.createdAt]
            );
            return token;
        },

        async findPasswordResetTokenByHash(tokenHash) {
            await ensureSchema();
            const { rows } = await pool.query(
                `SELECT id, user_id AS "userId", token_hash AS "tokenHash", expires_at AS "expiresAt", created_at AS "createdAt", used_at AS "usedAt" FROM password_reset_tokens WHERE token_hash = $1`,
                [tokenHash]
            );
            return rows[0] || null;
        },

        async markPasswordResetTokenUsed(tokenId, usedAt) {
            await ensureSchema();
            await pool.query("UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2", [usedAt, tokenId]);
        },

        async deletePasswordResetTokensForUser(userId) {
            await ensureSchema();
            await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
        },

        // ---- Usage ----
        async getDailyUsage(userId, date) {
            await ensureSchema();
            const { rows } = await pool.query(
                "SELECT count FROM usage_daily WHERE user_id = $1 AND date = $2",
                [userId, date]
            );
            return rows.length ? Number(rows[0].count) : 0;
        },

        async incrementDailyUsage(userId, date, limit) {
            await ensureSchema();
            // Atomic: increments only while the current count is under the limit
            // (same contract as sqliteStore.incrementDailyUsage).
            const { rows } = await pool.query(
                `INSERT INTO usage_daily (user_id, date, count) VALUES ($1, $2, 1)
                 ON CONFLICT (user_id, date)
                 DO UPDATE SET count = usage_daily.count + 1
                 WHERE usage_daily.count < $3
                 RETURNING count`,
                [userId, date, limit]
            );
            if (rows.length === 0) {
                const cur = await pool.query(
                    "SELECT count FROM usage_daily WHERE user_id = $1 AND date = $2",
                    [userId, date]
                );
                return {
                    allowed: false,
                    used: cur.rows.length ? Number(cur.rows[0].count) : 0,
                };
            }
            return { allowed: true, used: Number(rows[0].count) };
        },

        // ---- DEV-ONLY anonymous usage (see DEV_ANON_USAGE in server.js) ----
        async getDevAnonUsage(deviceId, date) {
            await ensureSchema();
            const { rows } = await pool.query(
                "SELECT count FROM usage_dev_anon WHERE device_id = $1 AND date = $2",
                [deviceId, date]
            );
            return rows.length ? Number(rows[0].count) : 0;
        },

        async incrementDevAnonUsage(deviceId, date, limit) {
            await ensureSchema();
            const { rows } = await pool.query(
                `INSERT INTO usage_dev_anon (device_id, date, count) VALUES ($1, $2, 1)
                 ON CONFLICT (device_id, date)
                 DO UPDATE SET count = usage_dev_anon.count + 1
                 WHERE usage_dev_anon.count < $3
                 RETURNING count`,
                [deviceId, date, limit]
            );
            if (rows.length === 0) {
                const cur = await pool.query(
                    "SELECT count FROM usage_dev_anon WHERE device_id = $1 AND date = $2",
                    [deviceId, date]
                );
                return {
                    allowed: false,
                    used: cur.rows.length ? Number(cur.rows[0].count) : 0,
                };
            }
            return { allowed: true, used: Number(rows[0].count) };
        },

        // ---- Rate limiting (abuse protection) ----
        async pruneRateEvents(beforeMs) {
            await ensureSchema();
            await pool.query("DELETE FROM rate_events WHERE ts < $1", [beforeMs]);
        },

        async countRateEvents(key, sinceMs) {
            await ensureSchema();
            const { rows } = await pool.query(
                "SELECT COUNT(*)::int AS c FROM rate_events WHERE key = $1 AND ts >= $2",
                [key, sinceMs]
            );
            return rows.length ? Number(rows[0].c) : 0;
        },

        async addRateEvent(key, ts) {
            await ensureSchema();
            await pool.query(
                "INSERT INTO rate_events (key, ts) VALUES ($1, $2)",
                [key, ts]
            );
        },

        // ---- Misc ----
        async ping() {
             try {
                 await ensureSchema();
                 await pool.query("SELECT 1");
                 return true;
             } catch (err) {
                 console.error("[AdVault Spy] PostgreSQL ping failed:", {
                     message: err?.message,
                     code: err?.code,
                     name: err?.name,
                     detail: err?.detail,
                     hint: err?.hint,
                });
                return false;
             }
        },

        async close() {
            try {
                await pool.end();
            } catch {
                // already closed
            }
        },
    };

    return store;
}

module.exports = { createPostgresStore, SCHEMA_SQL };

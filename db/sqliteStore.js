// db/sqliteStore.js
// ============================================================================
// Persistent SQLite store for AdVault Spy (production-capable).
//
// Uses Node's built-in `node:sqlite` module (DatabaseSync) — available since
// Node 22.5 and stable in current releases. No native compilation is needed.
//
// Data lives in a single file (default: ./data/advault.sqlite) and survives
// server restarts, extension reinstalls, and browser storage clears — which is
// exactly what the backend-owned quota requires.
// ============================================================================

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = `
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
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS usage_daily (
    user_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date),
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
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    used_at         TEXT,
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
    ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_key_ts ON rate_events(key, ts);
`;

const USER_COLUMNS = `
    id,
    email,
    password_hash           AS passwordHash,
    plan,
    subscription_status     AS subscriptionStatus,
    paypal_subscription_id  AS paypalSubscriptionId,
    email_verified_at       AS emailVerifiedAt,
    created_at              AS createdAt,
    updated_at              AS updatedAt
`;

function createSqliteStore(file) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);

    // ---- Schema migrations (additive only) ----
    // CREATE TABLE IF NOT EXISTS never alters an existing table, so a database
    // file created by an older build keeps its original columns and the
    // prepared statements below would throw "no column named ..." at startup.
    // These ALTER TABLE statements bring old files up to date without touching
    // existing rows.
    const userCols = () =>
        new Set(
            db.prepare("PRAGMA table_info(users)").all().map((c) => c.name)
        );
    if (!userCols().has("email_verified_at")) {
        db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
    }

    // Prepared statements.
    const stmt = {
        insertUser: db.prepare(`
            INSERT INTO users (
                id, email, password_hash, plan, subscription_status,
                paypal_subscription_id, email_verified_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        userByEmail: db.prepare(`
            SELECT ${USER_COLUMNS} FROM users WHERE email = ? COLLATE NOCASE
        `),
        userById: db.prepare(`
            SELECT ${USER_COLUMNS} FROM users WHERE id = ?
        `),
        insertSession: db.prepare(`
            INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)
        `),
        sessionByHash: db.prepare(`
            SELECT token_hash AS tokenHash, user_id AS userId,
                   created_at AS createdAt, expires_at AS expiresAt
            FROM sessions WHERE token_hash = ?
        `),
        deleteSession: db.prepare(`
            DELETE FROM sessions WHERE token_hash = ?
        `),
        deleteSessionsForUser: db.prepare(`
            DELETE FROM sessions WHERE user_id = ?
        `),
        deleteExpiredSessions: db.prepare(`
            DELETE FROM sessions WHERE expires_at < ?
        `),
        usageRow: db.prepare(`
            SELECT count FROM usage_daily WHERE user_id = ? AND date = ?
        `),
        upsertUsage: db.prepare(`
            INSERT INTO usage_daily (user_id, date, count) VALUES (?, ?, 1)
            ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
        `),
        devAnonUsageRow: db.prepare(`
            SELECT count FROM usage_dev_anon WHERE device_id = ? AND date = ?
        `),
        upsertDevAnonUsage: db.prepare(`
            INSERT INTO usage_dev_anon (device_id, date, count) VALUES (?, ?, 1)
            ON CONFLICT(device_id, date) DO UPDATE SET count = count + 1
        `),
        pruneRateEvents: db.prepare(`
            DELETE FROM rate_events WHERE ts < ?
        `),
        countRateEvents: db.prepare(`
            SELECT COUNT(*) AS c FROM rate_events WHERE key = ? AND ts >= ?
        `),
        addRateEvent: db.prepare(`
            INSERT INTO rate_events (key, ts) VALUES (?, ?)
        `),
        // Email verification tokens
        insertEmailVerificationToken: db.prepare(`
            INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `),
        findEmailVerificationTokenByHash: db.prepare(`
            SELECT id, user_id AS userId, token_hash AS tokenHash, expires_at AS expiresAt,
                   created_at AS createdAt, used_at AS usedAt
            FROM email_verification_tokens WHERE token_hash = ?
        `),
        findEmailVerificationTokensByUserId: db.prepare(`
            SELECT id, user_id AS userId, token_hash AS tokenHash, expires_at AS expiresAt,
                   created_at AS createdAt, used_at AS usedAt
            FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL
        `),
        markEmailVerificationTokenUsed: db.prepare(`
            UPDATE email_verification_tokens SET used_at = ? WHERE id = ?
        `),
        deleteEmailVerificationTokensForUser: db.prepare(`
            DELETE FROM email_verification_tokens WHERE user_id = ?
        `),
        insertPasswordResetToken: db.prepare(`
            INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `),
        findPasswordResetTokenByHash: db.prepare(`
            SELECT id, user_id AS userId, token_hash AS tokenHash, expires_at AS expiresAt,
                   created_at AS createdAt, used_at AS usedAt
            FROM password_reset_tokens WHERE token_hash = ?
        `),
        markPasswordResetTokenUsed: db.prepare(`
            UPDATE password_reset_tokens SET used_at = ? WHERE id = ?
        `),
        deletePasswordResetTokensForUser: db.prepare(`
            DELETE FROM password_reset_tokens WHERE user_id = ?
        `),
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function rowToUser(row) {
        if (!row) return null;
        return {
            id: row.id,
            email: row.email,
            passwordHash: row.passwordHash,
            plan: row.plan,
            subscriptionStatus: row.subscriptionStatus,
            paypalSubscriptionId: row.paypalSubscriptionId,
            emailVerifiedAt: row.emailVerifiedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    const store = {
        label: "sqlite",
        isMemory: false,

        // ---- Users ----
        createUser({
            email,
            passwordHash,
            plan = "FREE",
            subscriptionStatus = "NONE",
            paypalSubscriptionId = null,
            emailVerifiedAt = null,
        }) {
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
            stmt.insertUser.run(
                user.id,
                user.email,
                user.passwordHash,
                user.plan,
                user.subscriptionStatus,
                user.paypalSubscriptionId,
                user.emailVerifiedAt,
                user.createdAt,
                user.updatedAt
            );
            return user;
        },

        findUserByEmail(email) {
            return rowToUser(stmt.userByEmail.get(String(email).toLowerCase().trim()));
        },

        findUserById(id) {
            return rowToUser(stmt.userById.get(id));
        },

        updateUser(id, fields = {}) {
            const allowed = [
                "plan",
                "passwordHash",
                "subscriptionStatus",
                "paypalSubscriptionId",
                "emailVerifiedAt",
            ];
            const sets = [];
            const values = [];
            for (const key of allowed) {
                if (key in fields) {
                    const column =
                        key === "passwordHash"
                            ? "password_hash"
                            : key === "paypalSubscriptionId"
                            ? "paypal_subscription_id"
                            : key === "emailVerifiedAt"
                                ? "email_verified_at"
                                : key;
                    sets.push(`${column} = ?`);
                    values.push(fields[key] ?? null);
                }
            }
            if (sets.length) {
                sets.push("updated_at = ?");
                values.push(nowIso());
                db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
            }
            return store.findUserById(id);
        },

        // ---- Sessions ----
        createSession({ tokenHash, userId, expiresAt }) {
            stmt.insertSession.run(tokenHash, userId, nowIso(), expiresAt);
            return { tokenHash, userId, createdAt: nowIso(), expiresAt };
        },

        findSessionByTokenHash(tokenHash) {
            return stmt.sessionByHash.get(tokenHash) || null;
        },

        deleteSessionByTokenHash(tokenHash) {
            stmt.deleteSession.run(tokenHash);
        },

        deleteSessionsForUser(userId) {
            stmt.deleteSessionsForUser.run(userId);
        },

        deleteExpiredSessions(nowIsoValue) {
            stmt.deleteExpiredSessions.run(nowIsoValue);
        },

        // ---- Email Verification Tokens ----
        createEmailVerificationToken({ userId, tokenHash, expiresAt }) {
            const token = {
                id: crypto.randomUUID(),
                userId,
                tokenHash,
                expiresAt,
                createdAt: nowIso(),
                usedAt: null,
            };
            stmt.insertEmailVerificationToken.run(
                token.id,
                token.userId,
                token.tokenHash,
                token.expiresAt,
                token.createdAt
            );
            return token;
        },

        findEmailVerificationTokenByHash(tokenHash) {
            return stmt.findEmailVerificationTokenByHash.get(tokenHash) || null;
        },

        findEmailVerificationTokensByUserId(userId) {
            return stmt.findEmailVerificationTokensByUserId.all(userId) || [];
        },

        markEmailVerificationTokenUsed(tokenId, usedAt) {
            stmt.markEmailVerificationTokenUsed.run(usedAt, tokenId);
        },

        deleteEmailVerificationTokensForUser(userId) {
            stmt.deleteEmailVerificationTokensForUser.run(userId);
        },

        // ---- Password reset tokens ----
        createPasswordResetToken({ userId, tokenHash, expiresAt }) {
            const token = {
                id: crypto.randomUUID(),
                userId,
                tokenHash,
                expiresAt,
                createdAt: nowIso(),
                usedAt: null,
            };
            stmt.insertPasswordResetToken.run(token.id, token.userId, token.tokenHash, token.expiresAt, token.createdAt);
            return token;
        },

        findPasswordResetTokenByHash(tokenHash) {
            return stmt.findPasswordResetTokenByHash.get(tokenHash) || null;
        },

        markPasswordResetTokenUsed(tokenId, usedAt) {
            stmt.markPasswordResetTokenUsed.run(usedAt, tokenId);
        },

        deletePasswordResetTokensForUser(userId) {
            stmt.deletePasswordResetTokensForUser.run(userId);
        },

        // ---- Usage ----
        getDailyUsage(userId, date) {
            const row = stmt.usageRow.get(userId, date);
            return row ? Number(row.count) : 0;
        },

        incrementDailyUsage(userId, date, limit) {
            const row = stmt.usageRow.get(userId, date);
            const used = row ? Number(row.count) : 0;
            if (used >= limit) {
                return { allowed: false, used };
            }
            stmt.upsertUsage.run(userId, date);
            return { allowed: true, used: used + 1 };
        },

        // ---- DEV-ONLY anonymous usage (see DEV_ANON_USAGE in server.js) ----
        getDevAnonUsage(deviceId, date) {
            const row = stmt.devAnonUsageRow.get(deviceId, date);
            return row ? Number(row.count) : 0;
        },

        incrementDevAnonUsage(deviceId, date, limit) {
            const row = stmt.devAnonUsageRow.get(deviceId, date);
            const used = row ? Number(row.count) : 0;
            if (used >= limit) {
                return { allowed: false, used };
            }
            stmt.upsertDevAnonUsage.run(deviceId, date);
            return { allowed: true, used: used + 1 };
        },

        // ---- Rate limiting (abuse protection) ----
        pruneRateEvents(beforeMs) {
            stmt.pruneRateEvents.run(beforeMs);
        },

        countRateEvents(key, sinceMs) {
            const row = stmt.countRateEvents.get(key, sinceMs);
            return row ? Number(row.c) : 0;
        },

        addRateEvent(key, ts) {
            stmt.addRateEvent.run(key, ts);
        },

        // ---- Misc ----
        ping() {
            try {
                db.prepare("SELECT 1 AS ok").get();
                return true;
            } catch {
                return false;
            }
        },

        close() {
            db.close();
        },
    };

    return store;
}

module.exports = { createSqliteStore };

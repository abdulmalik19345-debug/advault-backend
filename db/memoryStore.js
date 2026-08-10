// db/memoryStore.js
// ============================================================================
// DEVELOPMENT ONLY — in-memory store.
//
// DO NOT USE THIS IN PRODUCTION.
//
// This store implements the same interface as sqliteStore but keeps every
// record in process memory. Consequences:
//   - ALL data is lost when the server process stops or restarts.
//   - Sessions are invalidated and the daily quota resets on every restart.
//   - It is single-process only and unsuitable for horizontal scaling.
//
// It exists so the API can be exercised quickly in development without a
// database file. Select it explicitly with DB_ENGINE=memory. The default is
// the persistent SQLite store.
// ============================================================================

const crypto = require("node:crypto");

function nowIso() {
    return new Date().toISOString();
}

function createMemoryStore() {
    console.warn(
        "[AdVault Spy] DEVELOPMENT ONLY: using the in-memory store. " +
        "All users, sessions, and usage reset on server restart. " +
        "Set DB_ENGINE=sqlite for a persistent database."
    );

    const users = new Map();
    const usersByEmail = new Map();
    const sessions = new Map();
    const usageDaily = new Map(); // key: `${userId}|${date}` -> count
    const usageDevAnon = new Map(); // DEV-ONLY: key: `${deviceId}|${date}` -> count
    const rateEvents = [];        // [{ key, ts }]
    const emailVerificationTokens = new Map(); // key: tokenId -> token, also index by tokenHash and userId
    const passwordResetTokens = new Map(); // key: tokenId -> token

    const store = {
        label: "memory",
        isMemory: true,

        // ---- Users ----
        createUser({ email, passwordHash, plan = "FREE", subscriptionStatus = "NONE", paypalSubscriptionId = null, emailVerifiedAt = null }) {
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
            users.set(user.id, user);
            usersByEmail.set(user.email, user);
            return { ...user };
        },

        findUserByEmail(email) {
            const user = usersByEmail.get(String(email).toLowerCase().trim());
            return user ? { ...user } : null;
        },

        findUserById(id) {
            const user = users.get(id);
            return user ? { ...user } : null;
        },

        updateUser(id, fields = {}) {
            const user = users.get(id);
            if (!user) return null;
            const allowed = ["plan", "passwordHash", "subscriptionStatus", "paypalSubscriptionId", "emailVerifiedAt"];
            for (const key of allowed) {
                if (key in fields) user[key] = fields[key] ?? null;
            }
            user.updatedAt = nowIso();
            return { ...user };
        },

        // ---- Sessions ----
        createSession({ tokenHash, userId, expiresAt }) {
            const session = { tokenHash, userId, createdAt: nowIso(), expiresAt };
            sessions.set(tokenHash, session);
            return { ...session };
        },

        findSessionByTokenHash(tokenHash) {
            const session = sessions.get(tokenHash);
            return session ? { ...session } : null;
        },

        deleteSessionByTokenHash(tokenHash) {
            sessions.delete(tokenHash);
        },

        deleteSessionsForUser(userId) {
            for (const [hash, session] of sessions) {
                if (session.userId === userId) sessions.delete(hash);
            }
        },

        deleteExpiredSessions(nowIsoValue) {
            for (const [hash, session] of sessions) {
                if (session.expiresAt < nowIsoValue) sessions.delete(hash);
            }
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
            emailVerificationTokens.set(token.id, token);
            return { ...token };
        },

        findEmailVerificationTokenByHash(tokenHash) {
            for (const token of emailVerificationTokens.values()) {
                if (token.tokenHash === tokenHash) return { ...token };
            }
            return null;
        },

        findEmailVerificationTokensByUserId(userId) {
            const tokens = [];
            for (const token of emailVerificationTokens.values()) {
                if (token.userId === userId && token.usedAt === null) {
                    tokens.push({ ...token });
                }
            }
            return tokens;
        },

        markEmailVerificationTokenUsed(tokenId, usedAt) {
            const token = emailVerificationTokens.get(tokenId);
            if (token) {
                token.usedAt = usedAt;
            }
        },

        deleteEmailVerificationTokensForUser(userId) {
            for (const [id, token] of emailVerificationTokens.entries()) {
                if (token.userId === userId) {
                    emailVerificationTokens.delete(id);
                }
            }
        },

        // ---- Password reset tokens ----
        createPasswordResetToken({ userId, tokenHash, expiresAt }) {
            const token = { id: crypto.randomUUID(), userId, tokenHash, expiresAt, createdAt: nowIso(), usedAt: null };
            passwordResetTokens.set(token.id, token);
            return { ...token };
        },

        findPasswordResetTokenByHash(tokenHash) {
            for (const token of passwordResetTokens.values()) {
                if (token.tokenHash === tokenHash) return { ...token };
            }
            return null;
        },

        markPasswordResetTokenUsed(tokenId, usedAt) {
            const token = passwordResetTokens.get(tokenId);
            if (token) token.usedAt = usedAt;
        },

        deletePasswordResetTokensForUser(userId) {
            for (const [id, token] of passwordResetTokens.entries()) {
                if (token.userId === userId) passwordResetTokens.delete(id);
            }
        },

        // ---- Usage ----
        getDailyUsage(userId, date) {
            return usageDaily.get(`${userId}|${date}`) || 0;
        },

        incrementDailyUsage(userId, date, limit) {
            const key = `${userId}|${date}`;
            const used = usageDaily.get(key) || 0;
            if (used >= limit) {
                return { allowed: false, used };
            }
            usageDaily.set(key, used + 1);
            return { allowed: true, used: used + 1 };
        },

        // ---- DEV-ONLY anonymous usage (see DEV_ANON_USAGE in server.js) ----
        getDevAnonUsage(deviceId, date) {
            return usageDevAnon.get(`${deviceId}|${date}`) || 0;
        },

        incrementDevAnonUsage(deviceId, date, limit) {
            const key = `${deviceId}|${date}`;
            const used = usageDevAnon.get(key) || 0;
            if (used >= limit) {
                return { allowed: false, used };
            }
            usageDevAnon.set(key, used + 1);
            return { allowed: true, used: used + 1 };
        },

        // ---- Rate limiting (abuse protection) ----
        pruneRateEvents(beforeMs) {
            for (let i = rateEvents.length - 1; i >= 0; i--) {
                if (rateEvents[i].ts < beforeMs) rateEvents.splice(i, 1);
            }
        },

        countRateEvents(key, sinceMs) {
            return rateEvents.filter((e) => e.key === key && e.ts >= sinceMs).length;
        },

        addRateEvent(key, ts) {
            rateEvents.push({ key, ts });
        },

        // ---- Misc ----
        ping() {
            return true;
        },

        close() {
            // Nothing to close for an in-memory store.
        },
    };

    return store;
}

module.exports = { createMemoryStore };

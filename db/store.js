// db/store.js
// ============================================================================
// AdVault Spy storage abstraction.
//
// The server never talks to a storage engine directly. Every store
// implementation below must expose the same interface so the backend can be
// pointed at a persistent database without changing application code.
//
// STORE INTERFACE (implemented by every store):
//
//   USERS
//   createUser({ email, passwordHash, plan?, subscriptionStatus?, paypalSubscriptionId? })
//       -> user
//   findUserByEmail(email)                       -> user | null
//   findUserById(id)                             -> user | null
//   updateUser(id, { plan?, subscriptionStatus?, paypalSubscriptionId?, emailVerifiedAt? })
//       -> user
//
//   SESSIONS
//   createSession({ tokenHash, userId, expiresAt }) -> session
//   findSessionByTokenHash(tokenHash)            -> session | null
//   deleteSessionByTokenHash(tokenHash)          -> void
//   deleteSessionsForUser(userId)                -> void
//   deleteExpiredSessions(nowIso)                -> void
//
//   USAGE
//   getDailyUsage(userId, date)                  -> number
//   incrementDailyUsage(userId, date, limit)
//       -> { allowed: boolean, used: number }    (atomic, respects limit)
//
//   USAGE — DEV-ONLY anonymous extension counter (see DEV_ANON_USAGE in server.js)
//   getDevAnonUsage(deviceId, date)              -> number
//   incrementDevAnonUsage(deviceId, date, limit)
//       -> { allowed: boolean, used: number }    (atomic, respects limit)
//
//   RATE LIMITING (abuse protection)
//   pruneRateEvents(beforeMs)                    -> void
//   countRateEvents(key, sinceMs)                -> number
//   addRateEvent(key, ts)                        -> void
//
//   MISC
//   ping()                                       -> boolean
//   close()                                      -> void
//
// A user object always has this shape:
//   {
//     id, email, passwordHash,
//     plan, subscriptionStatus, paypalSubscriptionId,
//     createdAt, updatedAt
//   }
// ============================================================================

const path = require("node:path");

function createStore({ engine, file, url }) {
    const resolvedEngine = String(engine || "sqlite").toLowerCase();

    if (resolvedEngine === "memory") {
        const { createMemoryStore } = require("./memoryStore");
        return createMemoryStore();
    }

    if (resolvedEngine === "postgres") {
        const { createPostgresStore } = require("./postgresStore");
        return createPostgresStore({ connectionString: url });
    }

    const { createSqliteStore } = require("./sqliteStore");
    const resolvedFile =
        file || path.join(__dirname, "..", "data", "advault.sqlite");
    return createSqliteStore(resolvedFile);
}

module.exports = { createStore };

"use strict";

// Integration tests for the PostgreSQL store (production database).
//
// These tests run ONLY when a real DATABASE_URL is set (e.g. a Supabase
// PostgreSQL connection string); otherwise they skip cleanly. This keeps
// `npm test` green in local development where no remote database exists.
//
// To run them:
//   $env:DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
//   npm test

const test = require("node:test");
const assert = require("node:assert/strict");

const DATABASE_URL = process.env.DATABASE_URL || "";

const hasDatabase = typeof DATABASE_URL === "string" && DATABASE_URL.length > 0;

const { createStore } = require("../db/store");

test(
    "postgres store: full account, session, verification, usage flow",
    { skip: !hasDatabase },
    async () => {
        const store = createStore({ engine: "postgres", url: DATABASE_URL });

        try {
            // ---- Users ----
            const email = `pg-test-${Date.now()}@example.com`;
            const passwordHash = "scrypt$16384$8$1$salt$hash0000000000000000000000000000000000000000000000000000000000000000";
            const user = await store.createUser({
                email,
                passwordHash,
                emailVerifiedAt: null,
            });
            assert.ok(user.id, "user.id generated");
            assert.equal(user.plan, "FREE");
            assert.equal(user.subscriptionStatus, "NONE");
            assert.equal(user.emailVerifiedAt, null);

            const byEmail = await store.findUserByEmail(email);
            assert.ok(byEmail);
            assert.equal(byEmail.id, user.id);
            assert.equal(byEmail.passwordHash, passwordHash);

            const byId = await store.findUserById(user.id);
            assert.equal(byId.email, email);

            // ---- updateUser preserves emailVerifiedAt ----
            const verifiedAt = "2026-08-10T12:00:00.000Z";
            const updated = await store.updateUser(user.id, {
                emailVerifiedAt: verifiedAt,
            });
            assert.equal(updated.emailVerifiedAt, verifiedAt);
            assert.equal(
                (await store.findUserById(user.id)).emailVerifiedAt,
                verifiedAt
            );

            // ---- Sessions ----
            const tokenHash = "abc123tokenhash";
            const expiresAt = new Date(Date.now() + 3600_000).toISOString();
            await store.createSession({ tokenHash, userId: user.id, expiresAt });
            const session = await store.findSessionByTokenHash(tokenHash);
            assert.ok(session);
            assert.equal(session.userId, user.id);
            assert.equal(session.expiresAt, expiresAt);

            // ---- Usage ----
            const today = "2026-08-10";
            assert.equal(await store.getDailyUsage(user.id, today), 0);
            let inc = await store.incrementDailyUsage(user.id, today, 2);
            assert.equal(inc.allowed, true);
            assert.equal(inc.used, 1);
            inc = await store.incrementDailyUsage(user.id, today, 2);
            assert.equal(inc.used, 2);
            inc = await store.incrementDailyUsage(user.id, today, 2);
            assert.equal(inc.allowed, false, "third increment blocked at limit");
            assert.equal(inc.used, 2);

            // ---- Email verification tokens ----
            const vtHash = "deadbeef";
            await store.createEmailVerificationToken({
                userId: user.id,
                tokenHash: vtHash,
                expiresAt,
            });
            const vt = await store.findEmailVerificationTokenByHash(vtHash);
            assert.ok(vt);
            assert.equal(vt.userId, user.id);
            assert.equal(vt.usedAt, null);
            await store.markEmailVerificationTokenUsed(vt.id, "2026-08-10T13:00:00.000Z");
            assert.equal(
                (await store.findEmailVerificationTokenByHash(vtHash)).usedAt,
                "2026-08-10T13:00:00.000Z"
            );
            await store.deleteEmailVerificationTokensForUser(user.id);
            assert.equal(
                await store.findEmailVerificationTokenByHash(vtHash),
                null
            );

            // ---- Rate limiting ----
            await store.addRateEvent("test:key", 111);
            await store.addRateEvent("test:key", 222);
            assert.equal(await store.countRateEvents("test:key", 100), 2);
            assert.equal(await store.countRateEvents("test:key", 200), 1);
            await store.pruneRateEvents(200);
            assert.equal(await store.countRateEvents("test:key", 100), 1);

            // ---- Session invalidation ----
            await store.deleteSessionByTokenHash(tokenHash);
            assert.equal(await store.findSessionByTokenHash(tokenHash), null);
        } finally {
            // Clean up the test user (cascades to sessions/usage/verification rows).
            const { Pool } = require("pg");
            const pool = new Pool({ connectionString: DATABASE_URL });
            try {
                await pool.query("DELETE FROM rate_events WHERE key LIKE $1", [
                    "test:%",
                ]);
                await pool.query("DELETE FROM users WHERE email = $1", [
                    email,
                ]);
            } finally {
                await pool.end();
            }
            await store.close();
        }
    }
);

test(
    "postgres store: ping works and /health-style status is safe",
    { skip: !hasDatabase },
    async () => {
        const store = createStore({ engine: "postgres", url: DATABASE_URL });
        try {
            assert.equal(await store.ping(), true);
            // The ping result must never contain the connection string or secrets.
            const status = String(await store.ping());
            assert.ok(!status.includes(DATABASE_URL));
            assert.ok(!status.includes("password"));
        } finally {
            await store.close();
        }
    }
);

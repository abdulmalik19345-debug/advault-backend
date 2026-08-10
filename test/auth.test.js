"use strict";

// Integration tests for the email verification flow (register → verify → login,
// plus resend-verification and its rate limiting).
//
// Uses an in-memory store and console email mode so no database file or third
// party service is touched. Run with: npm test

// Environment MUST be configured before server.js is required.
process.env.DB_ENGINE = "memory";
process.env.EMAIL_MODE = "console";
process.env.SESSION_SECRET = "test-session-secret-automated-tests";
process.env.PASSWORD_PEPPER = "test-pepper-automated-tests";
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.EMAIL_VERIFICATION_BASE_URL = "";
process.env.DEV_ANON_USAGE = "0";

const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../server.js");

let server;
let baseUrl;

test.before(async () => {
    await new Promise((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (err) => {
            if (err) return reject(err);
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

test.after(() => {
    if (server) server.close();
});

function apiRequest(path, options = {}) {
    const headers = Object.assign(
        { "Content-Type": "application/json" },
        options.headers || {}
    );
    return fetch(baseUrl + path, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    }).then((res) =>
        res
            .json()
            .catch(() => ({}))
            .then((data) => ({ status: res.status, data }))
    );
}

// Capture console.log output produced by the server while a request runs, so
// the one-time verification token (printed in console email mode) can be read.
async function withCapturedLogs(fn) {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
        const result = await fn();
        return { result, text: logs.join("\n") };
    } finally {
        console.log = originalLog;
    }
}

function extractToken(logText) {
    const match = logText.match(/verify-email\?token=([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

const PASSWORD = "supersecret123";

test("register creates an unverified account (no session token)", async () => {
    const { result, text } = await withCapturedLogs(() =>
        apiRequest("/auth/register", {
            method: "POST",
            body: { email: "new@example.com", password: PASSWORD },
        })
    );
    assert.equal(result.status, 201);
    assert.equal(result.data.requiresEmailVerification, true);
    assert.equal(result.data.user.email, "new@example.com");
    assert.equal(result.data.token, undefined);
    assert.ok(extractToken(text), "console email mode should log a token URL");
});

test("register rejects a duplicate email with 409", async () => {
    const res = await apiRequest("/auth/register", {
        method: "POST",
        body: { email: "new@example.com", password: PASSWORD },
    });
    assert.equal(res.status, 409);
});

test("register rejects invalid email and short password", async () => {
    const badEmail = await apiRequest("/auth/register", {
        method: "POST",
        body: { email: "not-an-email", password: PASSWORD },
    });
    assert.equal(badEmail.status, 400);

    const shortPassword = await apiRequest("/auth/register", {
        method: "POST",
        body: { email: "short@example.com", password: "short" },
    });
    assert.equal(shortPassword.status, 400);
});

test("login is blocked until the email is verified", async () => {
    const res = await apiRequest("/auth/login", {
        method: "POST",
        body: { email: "new@example.com", password: PASSWORD },
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.error, "EMAIL_NOT_VERIFIED");
});

test("full flow: verify email then log in", async () => {
    const { text } = await withCapturedLogs(() =>
        apiRequest("/auth/register", {
            method: "POST",
            body: { email: "flow@example.com", password: PASSWORD },
        })
    );
    const token = extractToken(text);
    assert.ok(token, "expected a verification token in the email log");

    const verify = await apiRequest(
        `/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(verify.status, 200);
    assert.equal(verify.data.ok, true);

    const login = await apiRequest("/auth/login", {
        method: "POST",
        body: { email: "flow@example.com", password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.ok(login.data.token);
    assert.equal(login.data.user.email, "flow@example.com");
    assert.ok(login.data.user.emailVerifiedAt);
    assert.equal(login.data.user.plan, "FREE");
    assert.equal(login.data.entitlement.isUnlimited, false);
});

test("verified user can read /auth/me", async () => {
    const login = await apiRequest("/auth/login", {
        method: "POST",
        body: { email: "flow@example.com", password: PASSWORD },
    });
    assert.equal(login.status, 200);

    const me = await apiRequest("/auth/me", {
        headers: { Authorization: `Bearer ${login.data.token}` },
    });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, "flow@example.com");
    assert.equal(me.data.entitlement.plan, "FREE");
});

test("verify-email rejects an unknown token", async () => {
    const res = await apiRequest("/auth/verify-email?token=does-not-exist");
    assert.equal(res.status, 400);
    assert.equal(res.data.error, "INVALID_TOKEN");
});

test("verify-email rejects a token that was already consumed", async () => {
    const { text } = await withCapturedLogs(() =>
        apiRequest("/auth/register", {
            method: "POST",
            body: { email: "reuse@example.com", password: PASSWORD },
        })
    );
    const token = extractToken(text);

    const first = await apiRequest(
        `/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(first.status, 200);

    const second = await apiRequest(
        `/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(second.status, 400);
    assert.ok(
        second.data.error === "TOKEN_USED" ||
            second.data.error === "INVALID_TOKEN",
        `expected a consumed-token error, got ${second.data.error}`
    );
});

test("resend-verification issues a working token for an unverified user", async () => {
    const { result, text } = await withCapturedLogs(() =>
        apiRequest("/auth/resend-verification", {
            method: "POST",
            body: { email: "new@example.com" },
        })
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);

    const token = extractToken(text);
    assert.ok(token);

    const verify = await apiRequest(
        `/auth/verify-email?token=${encodeURIComponent(token)}`
    );
    assert.equal(verify.status, 200);
    assert.equal(verify.data.ok, true);
});

test("resend-verification for an already-verified account does not resend", async () => {
    const res = await apiRequest("/auth/resend-verification", {
        method: "POST",
        body: { email: "flow@example.com" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.match(res.data.message, /already verified/i);
});

test("resend-verification for an unknown email does not leak existence", async () => {
    const res = await apiRequest("/auth/resend-verification", {
        method: "POST",
        body: { email: "ghost@example.com" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
});

test("resend-verification is rate limited", async () => {
    await withCapturedLogs(() =>
        apiRequest("/auth/register", {
            method: "POST",
            body: { email: "ratelimit@example.com", password: PASSWORD },
        })
    );

    for (let i = 0; i < 3; i++) {
        const res = await apiRequest("/auth/resend-verification", {
            method: "POST",
            body: { email: "ratelimit@example.com" },
        });
        assert.equal(res.status, 200, `resend attempt ${i + 1} should succeed`);
    }

    const blocked = await apiRequest("/auth/resend-verification", {
        method: "POST",
        body: { email: "ratelimit@example.com" },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, "RESEND_RATE_LIMITED");
});

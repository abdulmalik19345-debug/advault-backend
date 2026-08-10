"use strict";

// Unit tests for lib/email.js — token generation, URL building, config
// resolution, and both console + Resend delivery modes.
//
// Uses Node's built-in test runner (node --test). Run with: npm test

const test = require("node:test");
const assert = require("node:assert/strict");

const email = require("../lib/email");

// Run fn with a temporary set of env vars, restoring the previous values
// (or removing them) afterwards.
function withEnv(env, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(env)) {
        saved[key] = process.env[key];
        if (value === undefined || value === null) delete process.env[key];
        else process.env[key] = value;
    }
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined || value === null) delete process.env[key];
                else process.env[key] = value;
            }
        });
}

test("generateVerificationToken produces a long URL-safe token", () => {
    const token = email.generateVerificationToken();
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 40, "token should be at least 40 chars");
    assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test("hashVerificationToken is a stable sha256 hex digest", () => {
    const h1 = email.hashVerificationToken("abc");
    const h2 = email.hashVerificationToken("abc");
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
});

test("buildVerificationUrl appends the token to the verify endpoint", () => {
    const url = email.buildVerificationUrl("https://advaulte.com", "tok-123");
    assert.equal(url, "https://advaulte.com/auth/verify-email?token=tok-123");
});

test("buildPasswordResetUrl points to the landing page with a reset token", () => {
    assert.equal(
        email.buildPasswordResetUrl("https://app.example.com", "abc123"),
        "https://app.example.com/?reset_token=abc123"
    );
});

test("createVerificationExpiry returns a future ISO timestamp", () => {
    const expiry = email.createVerificationExpiry(24);
    assert.ok(new Date(expiry).getTime() > Date.now());
});

test("getEmailConfig applies defaults when no env vars are set", () =>
    withEnv(
        {
            EMAIL_MODE: undefined,
            EMAIL_FROM: undefined,
            EMAIL_VERIFICATION_BASE_URL: undefined,
            APP_BASE_URL: undefined,
            EMAIL_VERIFICATION_EXPIRY_HOURS: undefined,
            RESEND_API_KEY: undefined,
        },
        () => {
            const config = email.getEmailConfig();
            assert.equal(config.mode, "console");
            assert.equal(config.verificationBaseUrl, "http://localhost:3000");
            assert.equal(config.from, "AdVault Spy <noreply@advaulte.com>");
            assert.equal(config.expiryHours, 24);
            assert.equal(config.resendApiKey, "");
        }
    ));

test("getEmailConfig uses APP_BASE_URL for verification links", () =>
    withEnv(
        {
            APP_BASE_URL: "https://app.example.com",
            EMAIL_VERIFICATION_BASE_URL: undefined,
        },
        () => {
            assert.equal(
                email.getEmailConfig().verificationBaseUrl,
                "https://app.example.com"
            );
        }
    ));

test("getEmailConfig lets EMAIL_VERIFICATION_BASE_URL override APP_BASE_URL", () =>
    withEnv(
        {
            APP_BASE_URL: "https://app.example.com",
            EMAIL_VERIFICATION_BASE_URL: "https://override.example.com",
        },
        () => {
            assert.equal(
                email.getEmailConfig().verificationBaseUrl,
                "https://override.example.com"
            );
        }
    ));

test("sendEmail in console mode logs the message and returns ok", async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
        const result = await email.sendEmail({
            to: "a@example.com",
            subject: "Verify your AdVault Spy email",
            html: "<b>hi</b>",
            text: "https://app.example.com/auth/verify-email?token=abc",
        });
        assert.deepEqual(result, { ok: true, mode: "console" });
    } finally {
        console.log = originalLog;
    }
    assert.ok(logs.join("\n").includes("verify-email?token=abc"));
});

test("sendEmail in resend mode posts to the Resend API", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return new Response(JSON.stringify({ id: "re_9e2d3f" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    let result;
    try {
        result = await withEnv(
            {
                EMAIL_MODE: "resend",
                RESEND_API_KEY: "re_test_key",
                EMAIL_FROM: "AdVault Spy <noreply@advaulte.com>",
            },
            () =>
                email.sendEmail({
                    to: "a@example.com",
                    subject: "Verify your AdVault Spy email",
                    html: "<b>hi</b>",
                    text: "plain",
                })
        );
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(result.ok, true);
    assert.equal(result.id, "re_9e2d3f");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer re_test_key");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.from, "AdVault Spy <noreply@advaulte.com>");
    assert.deepEqual(body.to, ["a@example.com"]);
    assert.equal(body.subject, "Verify your AdVault Spy email");
});

test("sendEmail in resend mode throws when RESEND_API_KEY is missing", () =>
    assert.rejects(
        () =>
            withEnv(
                { EMAIL_MODE: "resend", RESEND_API_KEY: undefined },
                () =>
                    email.sendEmail({
                        to: "a@example.com",
                        subject: "S",
                        html: "h",
                        text: "t",
                    })
            ),
        /RESEND_API_KEY/
    ));

test("sendEmail in resend mode surfaces API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ message: "Invalid API key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    try {
        await assert.rejects(
            () =>
                withEnv(
                    { EMAIL_MODE: "resend", RESEND_API_KEY: "re_bad" },
                    () =>
                        email.sendEmail({
                            to: "a@example.com",
                            subject: "S",
                            html: "h",
                            text: "t",
                        })
                ),
            /Resend API error \(401\): Invalid API key/
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("sendEmail throws for unimplemented modes", () =>
    assert.rejects(
        () =>
            withEnv(
                { EMAIL_MODE: "sendgrid" },
                () =>
                    email.sendEmail({
                        to: "a@example.com",
                        subject: "S",
                        html: "h",
                        text: "t",
                    })
            ),
        /not implemented/
    ));

-- db/migrations/001_supabase_schema.sql
-- ============================================================================
-- AdVault Spy — Supabase PostgreSQL schema (production database).
--
-- This mirrors the schema the backend creates automatically at startup (see
-- db/postgresStore.js). You do NOT need to run it by hand — the backend applies
-- it on first boot. It is provided as a reference and for setting the database
-- up manually in the Supabase SQL editor if you prefer.
--
-- Run this in: Supabase Dashboard → SQL Editor → New query.
-- ============================================================================

-- Users / accounts. password_hash is the scrypt output from lib/password.js
-- (format: scrypt$N$r$p$salt$hash). It is NEVER a plaintext password.
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

-- Server-side sessions. Only the HMAC-SHA256 hash of the bearer token is
-- stored (lib/sessions.js). expires_at is an ISO-8601 UTC string.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Daily usage counters for FREE users (server-authoritative).
CREATE TABLE IF NOT EXISTS usage_daily (
    user_id TEXT NOT NULL,
    date    TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date),
    CONSTRAINT fk_usage_daily_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- DEV-ONLY anonymous extension usage counter (DEV_ANON_USAGE). No FK.
CREATE TABLE IF NOT EXISTS usage_dev_anon (
    device_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, date)
);

-- Email verification tokens. Only the SHA-256 hash of the raw token is stored
-- (lib/email.js). used_at is set on successful verification (single-use).
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

-- Rate limiting / abuse protection events (login attempts, resend limits, bursts).
CREATE TABLE IF NOT EXISTS rate_events (
    key TEXT NOT NULL,
    ts  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events_key_ts ON rate_events(key, ts);

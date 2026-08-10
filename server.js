// server.js - AdVault Spy backend API
// Node.js + Express + OpenAI. Analyzes ad data (text + video) and
// returns viral hooks, improved copy, marketing angles, and insights.
//
// Endpoints:
//   POST /auth/register      -> create account + session
//   POST /auth/login         -> log in + session
//   GET  /auth/me            -> current user, entitlement, usage (auth)
//   POST /auth/logout        -> invalidate session (auth)
//   GET  /auth/verify-email  -> verify an email with a one-time token
//   POST /auth/resend-verification -> resend the verification email
//   POST /auth/forgot-password -> request a password reset email
//   POST /auth/reset-password -> consume a reset token and set a new password
//   POST /usage/consume      -> consume one qualifying use (auth)
//   POST /analyze            -> analyze ad data (auth)
//   POST /generate-hooks     -> generate hooks (auth)
//   GET  /health             -> simple health check
//   POST /create-checkout-session -> Stripe checkout (pre-existing, public)
//
// Run: npm start  (or: node server.js)
//
// The app is also exported so automated tests can mount it without binding a
// port (the server only listens when run directly: `node server.js`).
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("node:path");
const crypto = require("node:crypto");
const OpenAI = require("openai");
const Stripe = require("stripe");

const { createStore } = require("./db/store");
const { hashPassword, verifyPassword } = require("./lib/password");
const {
    generateSessionToken,
    hashSessionToken,
    createSessionExpiry,
} = require("./lib/sessions");
const { getUserEntitlement, FREE_DAILY_LIMIT } = require("./lib/entitlement");
const {
    getUsageSnapshot,
    consumeUsage,
    assertUsageAvailable,
    allowBurst,
    getTodayKey,
    LOGIN_ATTEMPTS_PER_EMAIL,
    LOGIN_ATTEMPTS_PER_IP,
    LOGIN_WINDOW_MS,
} = require("./lib/quota");
const { createRequireAuth } = require("./middleware/auth");
const {
    generateVerificationToken,
    hashVerificationToken,
    createVerificationExpiry,
    sendVerificationEmail,
    sendPasswordResetEmail,
} = require("./lib/email");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// SECRETS (must come from the environment — never hardcoded)
// ============================================================================
// SESSION_SECRET is used to key session tokens. If missing we fall back to an
// ephemeral random secret so the server still boots for local development, but
// every session is invalidated on restart. Production MUST set it.
const SESSION_SECRET =
    process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
    console.warn(
        "[AdVault Spy] WARNING: SESSION_SECRET is not set. Using an ephemeral " +
        "secret — all sessions will be invalidated when the server restarts. " +
        "Set SESSION_SECRET in .env for production."
    );
}

// Optional extra secret mixed into password hashing. Defaults to the session
// secret so a database leak is not enough to crack passwords.
const PASSWORD_PEPPER =
    process.env.PASSWORD_PEPPER || SESSION_SECRET;

// ============================================================================
// DATABASE
// ============================================================================
// Production (e.g. Render) MUST use the remote Supabase PostgreSQL database.
// Engine selection order:
//   1. Explicit DB_ENGINE env var wins (postgres | sqlite | memory).
//   2. Otherwise postgres when DATABASE_URL is present.
//   3. Otherwise the legacy SQLite default (local development only).
// DB_ENGINE=memory selects the clearly-labeled DEVELOPMENT ONLY in-memory
// store (data is lost on restart).
const DB_ENGINE = (
    process.env.DB_ENGINE ||
    (process.env.DATABASE_URL ? "postgres" : "sqlite")
).toLowerCase();
const DATABASE_FILE =
    process.env.DATABASE_FILE ||
    path.join(__dirname, "data", "advault.sqlite");
const DATABASE_URL = process.env.DATABASE_URL || "";

if (DB_ENGINE === "postgres" && !DATABASE_URL) {
    console.error(
        "[AdVault Spy] Fatal: DB_ENGINE=postgres requires DATABASE_URL " +
        "(the Supabase PostgreSQL connection string)."
    );
    process.exit(1);
}

if (
    process.env.NODE_ENV === "production" &&
    (DB_ENGINE === "sqlite" || DB_ENGINE === "memory")
) {
    console.warn(
        `[AdVault Spy] WARNING: NODE_ENV=production but DB_ENGINE=${DB_ENGINE}. ` +
        "This is NOT a production database. Set DB_ENGINE=postgres and " +
        "DATABASE_URL to your Supabase PostgreSQL connection string."
    );
}

const store = createStore({
    engine: DB_ENGINE,
    file: DATABASE_FILE,
    url: DATABASE_URL,
});

// Storage is verified asynchronously at startup (see boot() below) because the
// PostgreSQL store connects lazily; sqlite/memory respond synchronously.

// ============================================================================
// STRIPE (pre-existing; used only by /create-checkout-session)
// ============================================================================
// Requires STRIPE_SECRET_KEY in the environment.
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// ============================================================================
// CORS
// ============================================================================
// The Chrome extension has host permissions that let it call the API without
// CORS, so this matters mainly for the deployed landing page. We allow:
//   - the exact origins listed in ALLOWED_ORIGINS (comma-separated), and
//   - chrome-extension:// origins (extension pages).
// No unrestricted wildcard for authenticated endpoints.
// Default includes the local dev origin so the served landing page (same
// origin) is not rejected when it sends an explicit Origin header.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

// Same-origin requests should never require the user to manually add the
// Render URL to ALLOWED_ORIGINS. This also keeps /landing/index.html and /
// working when the site is served directly by this backend.
app.use(
    cors((req, callback) => {
        const requestOrigin = req.headers.origin;
        const requestHost = req.get("host");
        const sameOrigin = requestOrigin && requestHost
            ? requestOrigin === `${req.protocol}://${requestHost}`
            : false;

        if (!requestOrigin || sameOrigin || requestOrigin.startsWith("chrome-extension://") || ALLOWED_ORIGINS.includes(requestOrigin)) {
            return callback(null, {
                methods: ["GET", "POST", "OPTIONS"],
                allowedHeaders: ["Content-Type", "Authorization"],
                maxAge: 86400,
            });
        }

        const err = new Error("Not allowed by CORS");
        err.status = 403;
        return callback(err);
    })
);

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ============================================================================
// AUTHENTICATION
// ============================================================================
const requireAuth = createRequireAuth({ store, secret: SESSION_SECRET });

// ============================================================================
// TEMPORARY DEVELOPMENT-ONLY: ANONYMOUS EXTENSION USAGE
// ============================================================================
// The Chrome extension no longer authenticates users — registration, login,
// account management and checkout live on the landing page. Until that
// landing-page auth/subscription flow is wired to this backend, the extension
// still needs to enforce the Free usage model (2 scans/day) WITHOUT inventing
// a fake logged-in user.
//
// When DEV_ANON_USAGE=1 (development only), requests WITHOUT a Bearer token
// are treated as an anonymous FREE-plan client keyed by a stable device id the
// extension supplies in the X-AdVault-Device-Id header. Usage is still counted
// server-side (authoritative), but NO user account or session is created — the
// client is never made to look authenticated.
//
// SECURITY: this mode is OFF by default and must remain OFF in production.
// The landing page will use the real /auth endpoints. None of the existing
// authenticated endpoints, sessions, or entitlement logic are weakened;
// authenticated requests still take the normal path below.
// ============================================================================
const DEV_ANON_USAGE =
    String(process.env.DEV_ANON_USAGE || "").toLowerCase() === "1";

// Anonymous pseudo-user used ONLY for the dev-only usage counter. It is never
// persisted, has no password, and always resolves to the FREE plan so the
// existing quota logic applies unchanged.
function devAnonUser(deviceId) {
    return {
        id: `dev-anon:${deviceId}`,
        email: `${deviceId}@dev-anon.advault.local`,
        passwordHash: null,
        plan: "FREE",
        subscriptionStatus: "NONE",
        paypalSubscriptionId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

// Identity for the usage endpoints: an authenticated user when a Bearer token
// is present (normal path), otherwise a dev-only anonymous FREE user when
// DEV_ANON_USAGE is enabled. Never accepts any client-asserted identity.
async function requireUsageIdentity(req, res, next) {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) {
        return requireAuth(req, res, next);
    }
    if (DEV_ANON_USAGE) {
        const deviceId = String(req.headers["x-advault-device-id"] || "").trim();
        if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
            return res.status(401).json({
                error: "A valid X-AdVault-Device-Id header is required for anonymous usage.",
            });
        }
        req.user = devAnonUser(deviceId);
        req.isAnonDev = true;
        return next();
    }
    return res.status(401).json({ error: "Authentication required." });
}

// ---- DEV-ONLY anonymous usage (server-authoritative daily counter) ----
// Snapshot of an anonymous device's usage. Same shape as getUsageSnapshot.
async function getDevAnonUsageSnapshot(deviceId) {
    const date = getTodayKey();
    const used = await store.getDevAnonUsage(deviceId, date);
    return {
        unlimited: false,
        used,
        limit: FREE_DAILY_LIMIT,
        remaining: Math.max(0, FREE_DAILY_LIMIT - used),
        resetDate: date,
    };
}

async function assertDevAnonUsageAvailable(deviceId) {
    const usage = await getDevAnonUsageSnapshot(deviceId);
    return { allowed: usage.remaining > 0, reason: "available", usage };
}

async function consumeDevAnonUsage(deviceId) {
    const date = getTodayKey();
    const result = await store.incrementDevAnonUsage(deviceId, date, FREE_DAILY_LIMIT);
    const usage = {
        unlimited: false,
        used: result.used,
        limit: FREE_DAILY_LIMIT,
        remaining: Math.max(0, FREE_DAILY_LIMIT - result.used),
        resetDate: date,
    };
    return { allowed: result.allowed, reason: result.allowed ? "counted" : "daily_limit", usage };
}

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        paypalSubscriptionId: user.paypalSubscriptionId,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

async function createSessionForUser(user) {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token, SESSION_SECRET);
    const expiresAt = createSessionExpiry();
    await store.createSession({ tokenHash, userId: user.id, expiresAt });
    return { token, expiresAt };
}

function normalizeEmail(value) {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

function validatePassword(value) {
    return typeof value === "string" && value.length >= 8;
}

// ---- Root route serves the landing page ----
// The API base is injected server-side so the frontend always targets the
// origin/port the backend actually listens on. This prevents the classic
// "hardcoded localhost:3000" mismatch when PORT is overridden (e.g. 3100).
// NOTE: this route must be registered BEFORE express.static, otherwise the
// static middleware serves landing/index.html for "/" and the rewrite below
// never runs.
app.get("/", (req, res) => {
    const htmlPath = path.join(__dirname, "landing", "index.html");
    // Derive the API base from the incoming request (Host + protocol) so the
    // served landing page always talks to the origin it was served from. A
    // hardcoded localhost breaks any real deployment (browsers would call the
    // visitor's own machine). trust proxy is enabled, so req.protocol reflects
    // X-Forwarded-Proto when behind a reverse proxy.
    const host = req.get("host") || `localhost:${PORT}`;
    const apiBase = `${req.protocol}://${host}`;
    try {
        const fs = require("node:fs");
        let html = fs.readFileSync(htmlPath, "utf8");
        // Rewrite the data-api-base attribute on the served HTML so the
        // browser always uses the live backend origin.
        html = html.replace(
            /(data-api-base=")[^"]*(")/,
            `$1${apiBase}$2`
        );
        res.type("html").send(html);
    } catch (readErr) {
        // Fall back to the file as-is (defaults in script.js still apply).
        res.sendFile(htmlPath);
    }
});

// ---- Static landing page ----
// Serve the remaining landing page assets from the same origin as the API so
// the frontend and backend share the same origin (no file:// CORS issue).
app.use(express.static(path.join(__dirname, "landing")));

/**
 * POST /auth/register
 * Body: { email, password }
 * Returns: { requiresEmailVerification: true, user: { email } }
 *
 * New users always start as FREE / NONE / UNVERIFIED. The client cannot submit a plan —
 * the backend owns the plan. Email verification is required before the account
 * can be used to sign in.
 */
app.post("/auth/register", async (req, res, next) => {
    try {
        const { email, password } = req.body || {};

        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail) {
            return res
                .status(400)
                .json({ error: "A valid email address is required." });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({
                error: "Password must be at least 8 characters.",
            });
        }

        const existing = await store.findUserByEmail(normalizedEmail);
        if (existing) {
            return res.status(409).json({
                error: "An account with this email already exists. Please log in.",
            });
        }

        const passwordHash = hashPassword(password, PASSWORD_PEPPER);
        const user = await store.createUser({
            email: normalizedEmail,
            passwordHash,
            emailVerifiedAt: null,
        });

        // Generate verification token
        const emailConfig = require("./lib/email").getEmailConfig();
        const rawToken = generateVerificationToken();
        const tokenHash = hashVerificationToken(rawToken);
        const expiresAt = createVerificationExpiry(emailConfig.expiryHours);
        await store.createEmailVerificationToken({
            userId: user.id,
            tokenHash,
            expiresAt,
        });

        // Send verification email
        await sendVerificationEmail({
            email: normalizedEmail,
            token: rawToken,
            expiryHours: emailConfig.expiryHours,
            baseUrl: emailConfig.verificationBaseUrl,
        });

        // Return response indicating verification is required (no session token)
        return res.status(201).json({
            requiresEmailVerification: true,
            user: { email: normalizedEmail },
        });
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns: { token, user, entitlement, usage }
 */
app.post("/auth/login", async (req, res, next) => {
    try {
        const { email, password } = req.body || {};
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail || typeof password !== "string" || !password) {
            return res
                .status(400)
                .json({ error: "Email and password are required." });
        }

        // Brute-force protection (per email and per IP).
        const ip = req.ip || "unknown";
        if (
            !(await allowBurst(
                store,
                `login:${normalizedEmail}`,
                LOGIN_ATTEMPTS_PER_EMAIL,
                LOGIN_WINDOW_MS
            ))
        ) {
            return res.status(429).json({
                error: "Too many login attempts. Please try again later.",
            });
        }
        if (
            !(await allowBurst(
                store,
                `loginip:${ip}`,
                LOGIN_ATTEMPTS_PER_IP,
                LOGIN_WINDOW_MS
            ))
        ) {
            return res.status(429).json({
                error: "Too many login attempts from this network. Please try again later.",
            });
        }

        const user = await store.findUserByEmail(normalizedEmail);
        if (!user || !verifyPassword(password, user.passwordHash, PASSWORD_PEPPER)) {
            return res
                .status(401)
                .json({ error: "Invalid email or password." });
        }

        // Check email verification
        if (!user.emailVerifiedAt) {
            return res.status(403).json({
                error: "EMAIL_NOT_VERIFIED",
                message: "Please verify your email before signing in.",
            });
        }

        const { token } = await createSessionForUser(user);
        const entitlement = getUserEntitlement(user);
        const usage = await getUsageSnapshot(store, user, entitlement);

        return res.json({
            token,
            user: publicUser(user),
            entitlement,
            usage,
        });
    } catch (err) {
        return next(err);
    }
});

/**
 * GET /auth/me
 * Returns: { user, entitlement, usage }
 */
app.get("/auth/me", requireAuth, async (req, res, next) => {
    try {
        const entitlement = getUserEntitlement(req.user);
        const usage = await getUsageSnapshot(store, req.user, entitlement);
        return res.json({
            user: publicUser(req.user),
            entitlement,
            usage,
        });
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /auth/logout
 * Invalidates the current session.
 * Returns: { ok: true }
 */
app.post("/auth/logout", requireAuth, async (req, res, next) => {
    try {
        await store.deleteSessionByTokenHash(req.sessionTokenHash);
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
});

/**
 * GET /auth/verify-email?token=<token>
 * Verifies the user's email address using a one-time token.
 * Returns: { ok: true, message: "Email verified successfully." }
 */
app.get("/auth/verify-email", async (req, res, next) => {
    try {
        const { token } = req.query;
        if (!token || typeof token !== "string") {
            return res.status(400).json({
                error: "INVALID_TOKEN",
                message: "This verification link is invalid.",
            });
        }

        const tokenHash = hashVerificationToken(token);
        const verificationToken = await store.findEmailVerificationTokenByHash(tokenHash);

        if (!verificationToken) {
            return res.status(400).json({
                error: "INVALID_TOKEN",
                message: "This verification link is invalid.",
            });
        }

        // Check expiration
        if (new Date(verificationToken.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({
                error: "TOKEN_EXPIRED",
                message: "This verification link has expired. Request a new verification email.",
            });
        }

        // Check if already used
        if (verificationToken.usedAt) {
            return res.status(400).json({
                error: "TOKEN_USED",
                message: "Your email has already been verified. You can log in.",
            });
        }

        // Mark token as used
        const usedAt = new Date().toISOString();
        await store.markEmailVerificationTokenUsed(verificationToken.id, usedAt);

        // Find and update user
        const user = await store.findUserById(verificationToken.userId);
        if (!user) {
            return res.status(404).json({
                error: "USER_NOT_FOUND",
                message: "The associated account was not found.",
            });
        }

        // Invalidate other active verification tokens for this user
        await store.deleteEmailVerificationTokensForUser(user.id);

        // Mark user as verified
        await store.updateUser(user.id, { emailVerifiedAt: usedAt });

        return res.json({
            ok: true,
            message: "Email verified successfully.",
        });
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /auth/resend-verification
 * Body: { email }
 * Sends a new verification email to the user.
 * Returns: { ok: true, message: "Verification email sent." }
 */
app.post("/auth/resend-verification", async (req, res, next) => {
    try {
        const { email } = req.body || {};
        const normalizedEmail = normalizeEmail(email);

        if (!normalizedEmail) {
            return res
                .status(400)
                .json({ error: "A valid email address is required." });
        }

        const user = await store.findUserByEmail(normalizedEmail);
        // Always return success to avoid account enumeration
        const successResponse = {
            ok: true,
            message: "If an unverified account exists for this email, a verification email has been sent.",
        };

        if (!user) {
            return res.json(successResponse);
        }

        // If already verified, no need to resend
        if (user.emailVerifiedAt) {
            return res.json({
                ok: true,
                message: "This account is already verified. You can log in.",
            });
        }

        // Rate limit: max 3 resend requests per hour per account
        const resendKey = `resend:${user.id}`;
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const recentResends = await store.countRateEvents(resendKey, oneHourAgo);
        if (recentResends >= 3) {
            return res.status(429).json({
                error: "RESEND_RATE_LIMITED",
                message: "Too many verification emails sent. Please wait before requesting another.",
            });
        }

        // Also rate limit by IP
        const ip = req.ip || "unknown";
        const ipResendKey = `resendip:${ip}`;
        const recentIpResends = await store.countRateEvents(ipResendKey, oneHourAgo);
        if (recentIpResends >= 5) {
            return res.status(429).json({
                error: "RESEND_RATE_LIMITED",
                message: "Too many verification emails sent from this network. Please wait before requesting another.",
            });
        }

        // Invalidate existing unused tokens for this user
        await store.deleteEmailVerificationTokensForUser(user.id);

        // Generate new verification token
        const emailConfig = require("./lib/email").getEmailConfig();
        const rawToken = generateVerificationToken();
        const tokenHash = hashVerificationToken(rawToken);
        const expiresAt = createVerificationExpiry(emailConfig.expiryHours);
        await store.createEmailVerificationToken({
            userId: user.id,
            tokenHash,
            expiresAt,
        });

        // Send verification email
        await sendVerificationEmail({
            email: normalizedEmail,
            token: rawToken,
            expiryHours: emailConfig.expiryHours,
            baseUrl: emailConfig.verificationBaseUrl,
        });

        // Record rate limit events
        await store.addRateEvent(resendKey, Date.now());
        await store.addRateEvent(ipResendKey, Date.now());

        return res.json(successResponse);
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Always returns the same success response to avoid account enumeration.
 */
app.post("/auth/forgot-password", async (req, res, next) => {
    try {
        const { email } = req.body || {};
        const normalizedEmail = normalizeEmail(email);
        const successResponse = {
            ok: true,
            message: "If an account exists for that email, a password reset link has been sent.",
        };

        if (!normalizedEmail) return res.json(successResponse);

        const user = await store.findUserByEmail(normalizedEmail);
        if (!user || !user.emailVerifiedAt) return res.json(successResponse);

        const resetKey = `password-reset:${user.id}`;
        const ip = req.ip || "unknown";
        const ipResetKey = `password-reset-ip:${ip}`;
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if ((await store.countRateEvents(resetKey, oneHourAgo)) >= 3 ||
            (await store.countRateEvents(ipResetKey, oneHourAgo)) >= 5) {
            return res.json(successResponse);
        }

        await store.deletePasswordResetTokensForUser(user.id);
        const emailConfig = require("./lib/email").getEmailConfig();
        const rawToken = generateVerificationToken();
        const tokenHash = hashVerificationToken(rawToken);
        const expiresAt = createVerificationExpiry(emailConfig.expiryHours);
        await store.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt });

        await sendPasswordResetEmail({
            email: normalizedEmail,
            token: rawToken,
            expiryHours: emailConfig.expiryHours,
            baseUrl: emailConfig.verificationBaseUrl,
        });

        await store.addRateEvent(resetKey, Date.now());
        await store.addRateEvent(ipResetKey, Date.now());
        return res.json(successResponse);
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /auth/reset-password
 * Body: { token, password }
 * Consumes a single-use password reset token and invalidates all sessions.
 */
app.post("/auth/reset-password", async (req, res, next) => {
    try {
        const { token, password } = req.body || {};
        if (typeof token !== "string" || !token) {
            return res.status(400).json({ error: "INVALID_TOKEN", message: "This password reset link is invalid." });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ error: "INVALID_PASSWORD", message: "Password must be at least 8 characters." });
        }

        const tokenHash = hashVerificationToken(token);
        const resetToken = await store.findPasswordResetTokenByHash(tokenHash);
        if (!resetToken) {
            return res.status(400).json({ error: "INVALID_TOKEN", message: "This password reset link is invalid or has already been used." });
        }
        if (resetToken.usedAt) {
            return res.status(400).json({ error: "TOKEN_USED", message: "This password reset link has already been used. Request a new one." });
        }
        if (new Date(resetToken.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({ error: "TOKEN_EXPIRED", message: "This password reset link has expired. Request a new one." });
        }

        const user = await store.findUserById(resetToken.userId);
        if (!user) {
            return res.status(404).json({ error: "USER_NOT_FOUND", message: "The associated account was not found." });
        }

        const now = new Date().toISOString();
        const passwordHash = hashPassword(password, PASSWORD_PEPPER);
        await store.updateUser(user.id, { passwordHash });
        await store.markPasswordResetTokenUsed(resetToken.id, now);
        await store.deletePasswordResetTokensForUser(user.id);
        await store.deleteSessionsForUser(user.id);

        return res.json({ ok: true, message: "Password reset successfully. You can now log in." });
    } catch (err) {
        return next(err);
    }
});

/**
 * GET /usage/snapshot
 * Returns the current usage snapshot WITHOUT consuming. Works for authenticated
 * users (normal path) and, in DEV_ANON_USAGE mode, for the anonymous extension
 * device id (development only).
 * Returns: { usage, entitlement }
 */
app.get("/usage/snapshot", requireUsageIdentity, async (req, res, next) => {
    try {
        const entitlement = getUserEntitlement(req.user);
        const usage = req.isAnonDev
            ? await getDevAnonUsageSnapshot(req.user.id)
            : await getUsageSnapshot(store, req.user, entitlement);
        return res.json({ entitlement, usage });
    } catch (err) {
        return next(err);
    }
});

/**
 * POST /usage/consume
 * Consumes one qualifying use for the authenticated user, or for the anonymous
 * extension device id in DEV_ANON_USAGE mode (server-authoritative).
 * Returns: { ok, usage, entitlement }
 */
app.post("/usage/consume", requireUsageIdentity, async (req, res, next) => {
    try {
        const entitlement = getUserEntitlement(req.user);
        const result = req.isAnonDev
            ? await consumeDevAnonUsage(req.user.id)
            : await consumeUsage(store, req.user, entitlement);

        if (!result.allowed) {
            const status = result.reason === "rate_limited" ? 429 : 403;
            return res.status(status).json({
                error:
                    result.reason === "rate_limited"
                        ? "Too many requests. Please slow down and try again."
                        : "You've used your 2 free scans. Upgrade to Pro for unlimited access.",
                usage: result.usage,
                entitlement,
            });
        }

        return res.json({
            ok: true,
            usage: result.usage,
            entitlement,
        });
    } catch (err) {
        return next(err);
    }
});

// ============================================================================
// OPENAI
// ============================================================================
// `timeout` (ms) protects both /analyze and /generate-hooks from hanging.
// Requires OPENAI_API_KEY in the environment.
const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 5000,
    })
    : null;

// ---- Hook Generator prompt ----
// Returns hook suggestions grouped by marketing angle (2 per category).
const HOOKS_PROMPT = `You are a world-class direct-response copywriter who writes scroll-stopping, high-converting hooks for short-form video ads (TikTok, Reels, Shorts).

Given an ad's text, generate high-converting ad hooks. Return ONLY valid JSON with this EXACT structure (no markdown, no extra text):
{
  "curiosity": ["hook", "hook"],
  "social_proof": ["hook", "hook"],
  "problem": ["hook", "hook"],
  "before_after": ["hook", "hook"],
  "urgency": ["hook", "hook"],
  "profit": ["hook", "hook"]
}

Rules for every hook:
- Short (under 12 words).
- Scroll-stopping.
- Emotion-driven.
- Specific (not generic).
- Each category must have EXACTLY 2 hooks.

Categories:
- curiosity: makes the viewer NEED to know more.
- social_proof: leverages numbers, popularity, or testimonials.
- problem: names a painful problem the viewer has.
- before_after: shows a transformation or contrast.
- urgency: creates scarcity or time pressure.
- profit: highlights money, savings, or ROI.`;

// Map category keys to friendly display labels.
const HOOK_CATEGORY_LABELS = {
    curiosity: "Curiosity",
    social_proof: "Social Proof",
    problem: "Problem-Solve",
    before_after: "Before / After",
    urgency: "Urgency",
    profit: "Money / Profit",
};

// ---- Optimized prompt (cheap + effective) ----
// Instructs the model to return ONLY a JSON object matching the schema.
const SYSTEM_PROMPT = `You are a world-class direct-response marketing copywriter who writes short, punchy, high-converting ad copy for TikTok and short-form video ads.

Given an ad's text and video URL, analyze it and return a JSON object with EXACTLY this structure (no markdown, no extra text):
{
  "hooks": ["hook1", "hook2", "hook3"],
  "improved_copy": "rewritten ad copy",
  "angles": ["angle1", "angle2"],
  "why_it_works": "brief explanation"
}

Rules:
- hooks: 3 attention-grabbing, scroll-stopping opening lines (max 12 words each).
- improved_copy: rewrite the ad copy to be concise, urgent, and benefit-driven (2-4 sentences).
- angles: 2 distinct new marketing angles/positionings not already used.
- why_it_works: 2-3 sentences explaining the psychological/marketing reason the original ad works.
- Keep everything concise, direct-response, and usable. No fluff.`;

/**
 * POST /analyze
 * Body: { text: string, video: string }
 * Returns: { text, video, analysis: { hooks, improved_copy, angles, why_it_works }, entitlement, usage }
 */
app.post("/analyze", requireUsageIdentity, async (req, res, next) => {
    try {
        const { text } = req.body || {};

        // ---- Input validation ----
        if (typeof text !== "string" || text.trim().length === 0) {
            return res.status(400).json({
                error: "Invalid input: 'text' is required and must be a non-empty string.",
            });
        }
        // `video` is optional — some extracted ads have no video URL. It is
        // still sent to the model when present so the analysis can consider it.
        const video =
            req.body && typeof req.body.video === "string" ? req.body.video : "";

        // ---- Entitlement gate (does not consume; prevents bypassing the cap) ----
        const entitlement = getUserEntitlement(req.user);
        const gate = req.isAnonDev
            ? await assertDevAnonUsageAvailable(req.user.id)
            : await assertUsageAvailable(store, req.user, entitlement);
        if (!gate.allowed) {
            return res.status(403).json({
                error:
                    "You've used your 2 free scans. Upgrade to Pro for unlimited access.",
                usage: gate.usage,
                entitlement,
            });
        }

        const userMessage =
            `Ad text:\n"""${text.trim()}"""\n\n` +
            (video && video.trim()
                ? `Video URL:\n${video.trim()}`
                : "No video URL was detected.");

        // ---- Guard: OpenAI not configured ----
        if (!openai) {
            console.error("[AdVault Spy] /analyze OpenAI call failed: OPENAI_API_KEY is not set.");
            return res.status(500).json({
                error: "OPENAI_API_KEY is not set. Configure it in your .env.",
            });
        }

        // ---- Call OpenAI with structured JSON output ----
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.8,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage },
            ],
        });

        const raw = completion.choices[0]?.message?.content || "{}";

        // ---- Parse & normalize the JSON response ----
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return res.status(502).json({
                error: "OpenAI returned an unparseable response.",
                raw,
            });
        }

        const analysis = {
            hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
            improved_copy: typeof parsed.improved_copy === "string" ? parsed.improved_copy : "",
            angles: Array.isArray(parsed.angles) ? parsed.angles : [],
            why_it_works: typeof parsed.why_it_works === "string" ? parsed.why_it_works : "",
        };

        const usage = await getUsageSnapshot(store, req.user, entitlement);

        return res.json({
            text: text.trim(),
            video: video.trim(),
            analysis,
            entitlement,
            usage,
        });
    } catch (err) {
        console.error("[AdVault Spy] /analyze OpenAI call failed:", {
            message: err.message,
            status: err.status,
            code: err.code,
            stack: err.stack,
        });
        const status = err.status || 500;
        return res.status(status).json({
            error: status === 401 || status === 403
                ? "Invalid OpenAI API key. Check your .env."
                : "Analysis failed. Please try again.",
            detail: err.message,
        });
    }
});

/**
 * POST /generate-hooks
 * Body: { text: string, video?: string }
 * Returns: { text, hooks: { category, label, items: [] }, entitlement, usage }
 */
app.post("/generate-hooks", requireUsageIdentity, async (req, res, next) => {
    try {
        const { text } = req.body || {};

        // ---- Input validation ----
        if (typeof text !== "string" || text.trim().length === 0) {
            return res.status(400).json({
                error: "Invalid input: 'text' is required and must be a non-empty string.",
            });
        }

        // ---- Entitlement gate (does not consume; prevents bypassing the cap) ----
        const entitlement = getUserEntitlement(req.user);
        const gate = req.isAnonDev
            ? await assertDevAnonUsageAvailable(req.user.id)
            : await assertUsageAvailable(store, req.user, entitlement);
        if (!gate.allowed) {
            return res.status(403).json({
                error:
                    "You've used your 2 free scans. Upgrade to Pro for unlimited access.",
                usage: gate.usage,
                entitlement,
            });
        }

        const userMessage = `Generate high-converting ad hooks for this ad:\n\n"${text.trim()}"`;

        // ---- Guard: OpenAI not configured ----
        if (!openai) {
            console.error("[AdVault Spy] /generate-hooks OpenAI call failed: OPENAI_API_KEY is not set.");
            return res.status(500).json({
                error: "OPENAI_API_KEY is not set. Configure it in your .env.",
            });
        }

        // ---- Call OpenAI with structured JSON output ----
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.9,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: HOOKS_PROMPT },
                { role: "user", content: userMessage },
            ],
        });

        const raw = completion.choices[0]?.message?.content || "{}";

        // ---- Parse & normalize the JSON response ----
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return res.status(502).json({
                error: "OpenAI returned an unparseable response.",
                raw,
            });
        }

        // Normalize into a stable shape grouped by category.
        const categories = [
            "curiosity",
            "social_proof",
            "problem",
            "before_after",
            "urgency",
            "profit",
        ];

        const hooks = categories
            .filter((key) => Array.isArray(parsed[key]) && parsed[key].length)
            .map((key) => ({
                category: key,
                label: HOOK_CATEGORY_LABELS[key] || key,
                items: parsed[key].slice(0, 2),
            }));

        const usage = await getUsageSnapshot(store, req.user, entitlement);

        return res.json({
            text: text.trim(),
            hooks,
            entitlement,
            usage,
        });
    } catch (err) {
        console.error("[AdVault Spy] /generate-hooks OpenAI call failed:", {
            message: err.message,
            status: err.status,
            code: err.code,
            stack: err.stack,
        });
        const status = err.status || 500;
        return res.status(status).json({
            error: status === 401 || status === 403
                ? "Invalid OpenAI API key. Check your .env."
                : "Hook generation failed. Please try again.",
            detail: err.message,
        });
    }
});

/**
 * POST /create-checkout-session
 * Body: { price?: string, success_url?: string, cancel_url?: string }
 * Returns: { url: session.url }
 *
 * PRE-EXISTING (Stripe). Creates a Stripe Checkout session (subscription mode).
 * PayPal is not implemented yet.
 */
app.post("/create-checkout-session", async (req, res, next) => {
    try {
        // Stripe is not configured until STRIPE_SECRET_KEY is set.
        if (!stripe) {
            return res.status(500).json({
                error: "STRIPE_SECRET_KEY is not set. Configure it in your .env.",
            });
        }

        const { price, success_url, cancel_url } = req.body || {};

        const priceId = price || process.env.STRIPE_PRICE_ID;
        if (!priceId) {
            return res.status(400).json({
                error: "A 'price' (Stripe Price ID) is required in the body or STRIPE_PRICE_ID env var.",
            });
        }

        const successUrl =
            success_url || process.env.STRIPE_SUCCESS_URL || "https://your-site.com/success";
        const cancelUrl =
            cancel_url || process.env.STRIPE_CANCEL_URL || "https://your-site.com/cancel";

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "subscription",
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: successUrl,
            cancel_url: cancelUrl,
        });

        return res.json({ url: session.url });
    } catch (err) {
        console.error("[AdVault Spy] /create-checkout-session error:", err.message);
        return res.status(500).json({
            error: "Failed to create checkout session. Please try again.",
            detail: err.message,
        });
    }
});

// ---- Health check ----
// Reports backend + database status. NEVER exposes credentials, the connection
// string, secrets, or API keys.
app.get("/health", async (_req, res) => {
    let db = "unknown";
    try {
        const alive = await store.ping();
        db = alive ? "ok" : "error";
    } catch {
        db = "error";
    }
    res.json({
        ok: db === "ok",
        service: "advault-spy-backend",
        status: "up",
        db,
    });
});

// ---- JSON 404 handler (unknown routes) ----
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});

// ---- JSON error handler (malformed bodies, unexpected errors, CORS) ----
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error("[AdVault Spy] Unhandled error:", {
        message: err.message,
        stack: err.stack,
    });
    const status = err.status || 500;
    res.status(status).json({
        error: status === 400 ? "Invalid JSON body." : "Internal server error.",
        detail: err.message,
    });
});

// ============================================================================
// MAINTENANCE
// ============================================================================
// Periodically remove expired sessions and old rate-limit events.
// Wrapped so both synchronous (sqlite/memory) and asynchronous (postgres)
// store calls have their failures handled.
setInterval(() => {
    try {
        Promise.all([
            store.deleteExpiredSessions(new Date().toISOString()),
            store.pruneRateEvents(Date.now() - 24 * 60 * 60 * 1000),
        ]).catch((err) => {
            console.error("[AdVault Spy] Maintenance sweep failed:", err.message);
        });
    } catch (err) {
        console.error("[AdVault Spy] Maintenance sweep failed:", err.message);
    }
}, 60 * 60 * 1000).unref();

// ============================================================================
// START
// ============================================================================
// Only bind the port when this file is executed directly. When the app is
// required by a test harness (require.main !== module) it is exported without
// listening so the test can mount it on its own ephemeral port.
if (require.main === module) {
    async function boot() {
        // Verify the database responds BEFORE accepting traffic so a misconfigured
        // Supabase connection fails fast instead of serving 500s. The check is
        // async because the PostgreSQL store connects lazily.
        try {
            const alive = await store.ping();
            if (!alive) {
                console.error("[AdVault Spy] Fatal: database is not responding.");
                process.exit(1);
            }
        } catch (err) {
            console.error(
                "[AdVault Spy] Fatal: database is not responding:",
                err.message
            );
            process.exit(1);
        }

        console.log(
            `[AdVault Spy] Storage: ${store.label}${store.isMemory ? " (DEVELOPMENT ONLY)" : ""}`
        );

        const server = app.listen(PORT, () => {
            console.log(`[AdVault Spy] API running on http://localhost:${PORT}`);
            console.log(`[AdVault Spy] Environment: ${process.env.NODE_ENV || "development"}`);
        });

        function shutdown() {
            console.log("\n[AdVault Spy] Shutting down…");
            server.close(() => {
                // The PostgreSQL store closes its connection pool asynchronously;
                // sqlite/memory close synchronously.
                const closed = store.close();
                if (closed && typeof closed.then === "function") {
                    closed.then(() => process.exit(0)).catch(() => process.exit(0));
                } else {
                    process.exit(0);
                }
            });
        }

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    boot();
}

module.exports = app;

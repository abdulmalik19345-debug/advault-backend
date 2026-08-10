// lib/quota.js
// ============================================================================
// Server-authoritative usage counting and abuse protection.
//
// The server is the single source of truth for usage. A user cannot gain more
// free uses by reinstalling the extension, clearing Chrome storage, opening a
// new popup, or changing browser state — the count lives in the store keyed by
// the authenticated user's id.
//
// "Server calendar day" = the calendar day in the server's local timezone.
// ============================================================================

function getTodayKey(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// Abuse protection for unlimited plans: cap burst requests per user.
const BURST_MAX = 12; // requests
const BURST_WINDOW_MS = 10_000; // per 10 seconds

// Abuse protection for login: cap attempts per email and per IP.
const LOGIN_ATTEMPTS_PER_EMAIL = 10; // per 15 minutes
const LOGIN_ATTEMPTS_PER_IP = 30; // per 15 minutes
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * Current usage snapshot for a user — never mutates anything.
 */
async function getUsageSnapshot(store, user, entitlement) {
    if (entitlement.isUnlimited) {
        return {
            unlimited: true,
            used: null,
            limit: null,
            remaining: null,
            resetDate: null,
        };
    }
    const date = getTodayKey();
    const used = await store.getDailyUsage(user.id, date);
    const limit = entitlement.freeDailyLimit;
    return {
        unlimited: false,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetDate: date,
    };
}

/**
 * Consume one qualifying use.
 *  - FREE: atomically increments the daily counter up to the daily limit.
 *  - PRO/AGENCY: unlimited, but subject to burst abuse protection.
 * Returns { allowed, reason, usage }.
 */
async function consumeUsage(store, user, entitlement) {
    if (entitlement.isUnlimited) {
        const allowed = await allowBurst(
            store,
            `burst:${user.id}`,
            BURST_MAX,
            BURST_WINDOW_MS
        );
        if (!allowed) {
            return {
                allowed: false,
                reason: "rate_limited",
                usage: {
                    unlimited: true,
                    used: null,
                    limit: null,
                    remaining: null,
                    resetDate: null,
                },
            };
        }
        return {
            allowed: true,
            reason: "unlimited",
            usage: {
                unlimited: true,
                used: null,
                limit: null,
                remaining: null,
                resetDate: null,
            },
        };
    }

    const date = getTodayKey();
    const result = await store.incrementDailyUsage(
        user.id,
        date,
        entitlement.freeDailyLimit
    );
    const usage = {
        unlimited: false,
        used: result.used,
        limit: entitlement.freeDailyLimit,
        remaining: Math.max(0, entitlement.freeDailyLimit - result.used),
        resetDate: date,
    };
    if (!result.allowed) {
        return { allowed: false, reason: "daily_limit", usage };
    }
    return { allowed: true, reason: "counted", usage };
}

/**
 * Check whether a user may perform a feature action right now WITHOUT
 * consuming a use (used by /analyze and /generate-hooks so FREE users cannot
 * bypass the daily cap through the AI endpoints).
 * Returns { allowed, reason, usage }.
 */
async function assertUsageAvailable(store, user, entitlement) {
    const usage = await getUsageSnapshot(store, user, entitlement);
    if (!entitlement.isUnlimited && usage.remaining <= 0) {
        return { allowed: false, reason: "daily_limit", usage };
    }
    return { allowed: true, reason: "available", usage };
}

/**
 * Sliding-window rate limiter backed by the store.
 */
async function allowBurst(store, key, max, windowMs) {
    const now = Date.now();
    const since = now - windowMs;
    const count = await store.countRateEvents(key, since);
    if (count >= max) return false;
    await store.addRateEvent(key, now);
    return true;
}

module.exports = {
    getTodayKey,
    getUsageSnapshot,
    consumeUsage,
    assertUsageAvailable,
    allowBurst,
    LOGIN_ATTEMPTS_PER_EMAIL,
    LOGIN_ATTEMPTS_PER_IP,
    LOGIN_WINDOW_MS,
};

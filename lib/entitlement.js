// lib/entitlement.js
// ============================================================================
// Centralized entitlement logic.
//
// The backend owns the plan. The client can never submit plan = PRO and have
// it trusted — plan is a server-side field on the user record, only changed by
// the backend (and later by PayPal subscription activation).
//
// getUserEntitlement(user) returns the user's current plan and feature access.
// ============================================================================

const FREE_DAILY_LIMIT = 2;
const VALID_PLANS = ["FREE", "PRO", "AGENCY"];

function normalizePlan(value) {
    const v = String(value || "FREE").trim().toUpperCase();
    return VALID_PLANS.includes(v) ? v : "FREE";
}

function getUserEntitlement(user) {
    const plan = normalizePlan(user.plan);
    const subscriptionStatus = String(
        user.subscriptionStatus || "NONE"
    )
        .trim()
        .toUpperCase();

    // PRO and AGENCY get unlimited normal usage (subject to server abuse
    // protection). FREE gets a fixed number of qualifying uses per server
    // calendar day.
    const isUnlimited = plan === "PRO" || plan === "AGENCY";

    return {
        userId: user.id,
        plan,
        subscriptionStatus,
        isUnlimited,
        freeDailyLimit: FREE_DAILY_LIMIT,
        features: {
            scanPage: true,
            analyzeAi: true,
            generateHooks: true,
            exportProspects: true,
            unlimitedScans: isUnlimited,
        },
    };
}

module.exports = { getUserEntitlement, FREE_DAILY_LIMIT, normalizePlan };

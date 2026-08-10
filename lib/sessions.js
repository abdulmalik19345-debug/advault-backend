// lib/sessions.js
// ============================================================================
// Server-side session tokens.
//
// Sessions are opaque random tokens. The raw token is handed to the client
// once (at login/register) and is stored by the client. The server only ever
// persists a keyed hash of the token (HMAC-SHA256 with SESSION_SECRET), so a
// database leak does not expose live session tokens.
//
// The identity of the authenticated user is therefore determined entirely by
// the server: client-supplied identity (storage/localStorage/URL params) is
// never trusted — only the token, matched to a server-side session record.
// ============================================================================

const crypto = require("node:crypto");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateSessionToken() {
    return crypto.randomBytes(32).toString("base64url");
}

function hashSessionToken(token, secret) {
    return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function createSessionExpiry(now = Date.now()) {
    return new Date(now + SESSION_TTL_MS).toISOString();
}

module.exports = {
    SESSION_TTL_MS,
    generateSessionToken,
    hashSessionToken,
    createSessionExpiry,
};

// lib/password.js
// ============================================================================
// Password hashing using Node's built-in scrypt KDF.
//
// scrypt is a strong, memory-hard password hashing function available in the
// Node ecosystem (node:crypto) with zero extra dependencies. Passwords are
// NEVER stored in plaintext.
//
// A stored hash has the format:
//   scrypt$N$r$p$salt$hash
//
// A secret "pepper" (from the environment) is mixed into the input so that a
// database leak alone is not enough to crack passwords.
// ============================================================================

const crypto = require("node:crypto");

const SCRYPT_N = 16384; // CPU/memory cost (Node default)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

function hashPassword(password, pepper = "") {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto
        .scryptSync(
            pepper + password,
            salt,
            KEY_LENGTH,
            { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
        )
        .toString("hex");
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

function verifyPassword(password, stored, pepper = "") {
    if (typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, n, r, p, salt, expectedHex] = parts;
    let actual;
    try {
        actual = crypto
            .scryptSync(pepper + password, salt, KEY_LENGTH, {
                N: Number(n),
                r: Number(r),
                p: Number(p),
            })
            .toString("hex");
    } catch {
        return false;
    }

    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expectedHex, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };

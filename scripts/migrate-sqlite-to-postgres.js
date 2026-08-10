// scripts/migrate-sqlite-to-postgres.js
// ============================================================================
// One-off data migration: local SQLite file -> Supabase PostgreSQL.
//
// Preserves (exactly as stored):
//   - user ids, emails, password hashes (scrypt, never plaintext)
//   - plans / subscription entitlements
//   - email verification state and verification tokens
//   - sessions, daily usage counters, dev-anon usage counters
//   - all timestamps
//
// The SQLite database is opened read-only. Nothing is deleted from SQLite.
// Inserts are idempotent (ON CONFLICT DO NOTHING), so re-running the script is
// safe. It never prints emails, password hashes, tokens, or connection secrets.
//
// Usage (run from the project root):
//   node scripts/migrate-sqlite-to-postgres.js
//
// Environment:
//   DATABASE_URL   (required) Supabase PostgreSQL connection string
//   DATABASE_FILE  (optional) path to the SQLite file, defaults to ./data/advault.sqlite
// ============================================================================

require("dotenv").config();
const path = require("node:path");
const fs = require("node:fs");

const { DatabaseSync } = require("node:sqlite");
const { createPostgresStore, SCHEMA_SQL } = require("../db/postgresStore");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_FILE = process.env.DATABASE_FILE
    ? path.resolve(process.env.DATABASE_FILE)
    : path.join(__dirname, "..", "data", "advault.sqlite");

if (!DATABASE_URL) {
    console.error(
        "[migrate] Fatal: DATABASE_URL is required (Supabase PostgreSQL connection string)."
    );
    process.exit(1);
}
if (!fs.existsSync(DATABASE_FILE)) {
    console.error(`[migrate] Fatal: SQLite file not found: ${DATABASE_FILE}`);
    process.exit(1);
}

// Table order matters: users first (FK targets), then dependents.
const TABLES = [
    "users",
    "sessions",
    "usage_daily",
    "usage_dev_anon",
    "email_verification_tokens",
    "rate_events",
];

async function main() {
    const pg = createPostgresStore({ connectionString: DATABASE_URL });
    console.log("[migrate] Applying schema to PostgreSQL…");
    await pg.query(SCHEMA_SQL);

    const sqlite = new DatabaseSync(DATABASE_FILE, { readOnly: true });

    const summary = {};
    try {
        for (const table of TABLES) {
            const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
            if (rows.length === 0) {
                summary[table] = 0;
                continue;
            }

            const cols = Object.keys(rows[0]);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
            const insertSql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
                               VALUES (${placeholders})
                               ON CONFLICT DO NOTHING`;

            let inserted = 0;
            for (const row of rows) {
                const result = await pg.query(
                    insertSql,
                    cols.map((c) => row[c])
                );
                inserted += result.rowCount || 0;
            }
            summary[table] = inserted;
            console.log(
                `[migrate] ${table}: ${inserted}/${rows.length} rows inserted (rest already present)`
            );
        }
    } finally {
        sqlite.close();
        await pg.close();
    }

    console.log("\n[migrate] Done. Rows inserted per table:");
    for (const table of TABLES) {
        console.log(`  - ${table}: ${summary[table] || 0}`);
    }
    console.log(
        "\n[migrate] Note: rate_events are transient abuse-protection records and may be safely ignored."
    );
}

main().catch((err) => {
    console.error("[migrate] Migration failed:", err.message);
    process.exit(1);
});

"use strict";

// Verifies that the SQLite store persists emailVerifiedAt through updateUser —
// the field the /auth/verify-email endpoint relies on. Regression test for a
// bug where the column was silently dropped.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStore } = require("../db/store");

test("sqlite store persists emailVerifiedAt through updateUser", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advault-test-"));
    const file = path.join(dir, "test.sqlite");
    const store = createStore({ engine: "sqlite", file });
    try {
        const user = store.createUser({
            email: "verify@example.com",
            passwordHash: "hash",
        });
        assert.equal(user.emailVerifiedAt, null);

        const updatedAt = "2026-08-10T12:00:00.000Z";
        const updated = store.updateUser(user.id, {
            emailVerifiedAt: updatedAt,
        });
        assert.equal(updated.emailVerifiedAt, updatedAt);

        // Read back through a fresh lookup to ensure it really hit the DB.
        const reloaded = store.findUserById(user.id);
        assert.equal(reloaded.emailVerifiedAt, updatedAt);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("memory store also persists emailVerifiedAt through updateUser", () => {
    const store = createStore({ engine: "memory" });
    const user = store.createUser({ email: "m@example.com", passwordHash: "h" });
    const updated = store.updateUser(user.id, {
        emailVerifiedAt: "2026-08-10T00:00:00.000Z",
    });
    assert.equal(updated.emailVerifiedAt, "2026-08-10T00:00:00.000Z");
    assert.equal(
        store.findUserById(user.id).emailVerifiedAt,
        "2026-08-10T00:00:00.000Z"
    );
});

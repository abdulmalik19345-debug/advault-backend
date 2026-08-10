# AdVault Spy Landing Page Authentication Flow — Fixes

## Goals
Make the landing-page authentication flow production-ready: register, login, session restore, logout, navbar, modal, Open Extension.

## Steps
- [x] 1. server.js: inject the actual API base (origin/port) into the served landing page so the frontend always targets the running backend (fixes hardcoded port-3000 mismatch).
- [x] 2. landing/index.html: remove duplicate `id="authModalTitle"`; keep a single accessible title.
- [x] 3. landing/script.js: make `apiBase` resolve to `window.location.origin` as a fallback when `data-api-base` is missing.
- [x] 4. landing/styles.css: ensure the modal never creates horizontal overflow on mobile and only the active auth form is visible.
- [x] 5. Verify syntax with `node --check landing/script.js`.
- [x] 6. Start server and test register/login/session/logout/Open-Extension/navbar/modal.

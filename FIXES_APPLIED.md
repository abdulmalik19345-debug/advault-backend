# AdVault Spy authentication fixes

Applied fixes:
- Removed the hardcoded localhost API dependency from the landing page.
- Landing page now uses the backend origin when opened directly from Render.
- Same-origin requests are accepted by the backend CORS policy.
- Implemented POST /auth/forgot-password.
- Implemented POST /auth/reset-password.
- Added one-time, expiring password-reset tokens for SQLite, PostgreSQL, and memory stores.
- Added password-reset email rendering through the existing console/Resend email abstraction.
- Resetting a password invalidates all existing sessions for that account.
- Added frontend forgot-password and reset-password modals.
- Reset links open the landing page and automatically show the new-password form.
- Added automated tests for the reset flow.

Deployment note:
- Do NOT upload .env or local database files from the development machine.
- Keep production secrets in Render Environment Variables.

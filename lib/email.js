// lib/email.js
// ============================================================================
// Email service abstraction for AdVault Spy.
// Supports development console mode and the Resend production provider.
// All credentials remain server-side — never exposed to frontend.
// ============================================================================

const crypto = require("node:crypto");

// Resend REST API — used directly over global fetch (Node >= 22.5) so no
// third-party SDK dependency is needed.
const RESEND_API_URL = "https://api.resend.com/emails";

function getEmailConfig() {
    return {
        mode: (process.env.EMAIL_MODE || "console").toLowerCase(),
        from: process.env.EMAIL_FROM || "AdVault Spy <noreply@advaulte.com>",
        // EMAIL_VERIFICATION_BASE_URL takes precedence over the more generic
        // APP_BASE_URL so both work; APP_BASE_URL is the recommended one.
        verificationBaseUrl:
            process.env.EMAIL_VERIFICATION_BASE_URL ||
            process.env.APP_BASE_URL ||
            "http://localhost:3000",
        expiryHours: sanitizeExpiryHours(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS),
        resendApiKey: process.env.RESEND_API_KEY || "",
    };
}

function sanitizeExpiryHours(value) {
    const hours = Number(value);
    return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

function generateVerificationToken() {
    return crypto.randomBytes(32).toString("base64url");
}

function hashVerificationToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function createVerificationExpiry(hours = 24) {
    const h = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 24;
    return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

function buildVerificationUrl(baseUrl, token) {
    const url = new URL("/auth/verify-email", baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
}

function buildPasswordResetUrl(baseUrl, token) {
    const url = new URL("/", baseUrl);
    url.searchParams.set("reset_token", token);
    return url.toString();
}

function renderVerificationEmailHtml({ verificationUrl, expiryHours, email }) {
    const escapedEmail = escapeHtml(email);
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verify your AdVault Spy email</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f7fb;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <tr>
      <td style="background:#ffffff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- Logo/Name -->
        <div style="text-align:center;margin-bottom:32px;">
          <div style="display:inline-flex;align-items:center;gap:12px;">
            <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(145deg,#bac5ff,#7d90fa);color:#11152a;display:grid;place-items:center;font-weight:800;font-size:18px;">A</div>
            <span style="font-size:22px;font-weight:700;color:#090a0c;letter-spacing:-0.5px;">AdVault <span style="color:#7d90fa;">Spy</span></span>
          </div>
        </div>

        <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#090a0c;text-align:center;">Verify your email address</h1>
        <p style="margin:0 0 24px;font-size:16px;color:#5f6672;text-align:center;line-height:1.6;">
          Thanks for creating your AdVault Spy account, <strong>${escapedEmail}</strong>.
        </p>

        <!-- CTA Button -->
        <div style="text-align:center;margin:32px 0;">
          <a href="${verificationUrl}" style="display:inline-block;padding:14px 32px;background:#a1b1fd;color:#111426;font-weight:700;font-size:15px;border-radius:10px;text-decoration:none;box-shadow:0 8px 24px rgba(111,129,255,0.3);">
            Verify Email
          </a>
        </div>

        <p style="margin:0 0 8px;font-size:14px;color:#8b919d;text-align:center;">
          This link expires in ${expiryHours} hours.
        </p>

        <!-- Fallback URL -->
        <div style="margin-top:32px;padding:16px;background:#f5f7fb;border-radius:8px;border:1px solid #e5e8ef;">
          <p style="margin:0 0 8px;font-size:12px;color:#8b919d;text-align:center;">If the button doesn't work, copy this link:</p>
          <p style="margin:0;font-size:12px;color:#a1b1fd;text-align:center;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
            <a href="${verificationUrl}" style="color:#a1b1fd;text-decoration:underline;">${escapeHtml(verificationUrl)}</a>
          </p>
        </div>

        <hr style="margin:32px 0;border:none;border-top:1px solid #e5e8ef;">

        <p style="margin:0;font-size:13px;color:#8b919d;text-align:center;line-height:1.5;">
          If you didn't create this account, you can safely ignore this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding-top:24px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#8b919d;letter-spacing:0.5px;">
          © ${new Date().getFullYear()} AdVault Spy. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderVerificationEmailText({ verificationUrl, expiryHours, email }) {
    return `Verify your AdVault Spy email

Thanks for creating your AdVault Spy account, ${email}.

Click the link below to verify your email address:

${verificationUrl}

This link expires in ${expiryHours} hours.

If you didn't create this account, you can safely ignore this email.

© ${new Date().getFullYear()} AdVault Spy. All rights reserved.`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, "\"")
        .replace(/'/g, "&#039;");
}

function renderPasswordResetEmailHtml({ resetUrl, expiryHours, email }) {
    const escapedEmail = escapeHtml(email);
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reset your AdVault Spy password</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f7fb;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <tr><td style="background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08);">
      <div style="text-align:center;margin-bottom:32px;"><div style="display:inline-flex;align-items:center;gap:12px;"><div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(145deg,#bac5ff,#7d90fa);color:#11152a;display:grid;place-items:center;font-weight:800;font-size:18px;">A</div><span style="font-size:22px;font-weight:700;color:#090a0c;">AdVault <span style="color:#7d90fa;">Spy</span></span></div></div>
      <h1 style="margin:0 0 16px;font-size:26px;color:#090a0c;text-align:center;">Reset your password</h1>
      <p style="margin:0 0 24px;font-size:16px;color:#5f6672;text-align:center;line-height:1.6;">We received a request to reset the password for <strong>${escapedEmail}</strong>.</p>
      <div style="text-align:center;margin:32px 0;"><a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#a1b1fd;color:#111426;font-weight:700;font-size:15px;border-radius:10px;text-decoration:none;">Reset Password</a></div>
      <p style="margin:0 0 8px;font-size:14px;color:#8b919d;text-align:center;">This link expires in ${expiryHours} hours and can only be used once.</p>
      <div style="margin-top:32px;padding:16px;background:#f5f7fb;border-radius:8px;border:1px solid #e5e8ef;"><p style="margin:0 0 8px;font-size:12px;color:#8b919d;text-align:center;">If the button doesn't work, copy this link:</p><p style="margin:0;font-size:12px;color:#a1b1fd;text-align:center;word-break:break-all;"><a href="${resetUrl}" style="color:#a1b1fd;">${escapeHtml(resetUrl)}</a></p></div>
      <hr style="margin:32px 0;border:none;border-top:1px solid #e5e8ef;">
      <p style="margin:0;font-size:13px;color:#8b919d;text-align:center;line-height:1.5;">If you didn't request this, you can safely ignore this email.</p>
    </td></tr>
  </table>
</body></html>`;
}

function renderPasswordResetEmailText({ resetUrl, expiryHours, email }) {
    return `Reset your AdVault Spy password\n\nWe received a request to reset the password for ${email}.\n\nOpen this link to choose a new password:\n\n${resetUrl}\n\nThis link expires in ${expiryHours} hours and can only be used once.\n\nIf you didn't request this, you can safely ignore this email.`;
}

async function sendPasswordResetEmail({ email, token, expiryHours, baseUrl }) {
    const resetUrl = buildPasswordResetUrl(baseUrl, token);
    const subject = "Reset your AdVault Spy password";
    const html = renderPasswordResetEmailHtml({ resetUrl, expiryHours, email });
    const text = renderPasswordResetEmailText({ resetUrl, expiryHours, email });
    return sendEmail({ to: email, subject, html, text });
}

async function sendResendEmail(config, { to, subject, html, text }) {
    if (!config.resendApiKey) {
        throw new Error(
            'EMAIL_MODE="resend" requires RESEND_API_KEY to be set. Add it to your .env.'
        );
    }

    let response;
    try {
        response = await fetch(RESEND_API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${config.resendApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: config.from,
                to: [to],
                subject,
                html,
                text,
            }),
        });
    } catch (err) {
        throw new Error(
            `Resend request failed: ${err.message}. Check your network connection and RESEND_API_KEY.`
        );
    }

    let body = {};
    try {
        body = await response.json();
    } catch (err) {
        body = {};
    }

    if (!response.ok) {
        const detail = (body && body.message) || `HTTP ${response.status}`;
        throw new Error(`Resend API error (${response.status}): ${detail}`);
    }

    return { ok: true, id: (body && body.id) || null, mode: "resend" };
}

async function sendEmail({ to, subject, html, text }) {
    const config = getEmailConfig();

    if (config.mode === "console") {
        // Development mode: log to console with clear marking
        const divider = "=".repeat(70);
        console.log("\n" + divider);
        console.log("DEVELOPMENT ONLY — EMAIL VERIFICATION URL");
        console.log(divider);
        console.log(`To: ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`From: ${config.from}`);
        console.log("-".repeat(70));
        console.log(text);
        console.log("-".repeat(70));
        console.log("HTML version available — check server logs for full content.");
        console.log(divider + "\n");
        return { ok: true, mode: "console" };
    }

    if (config.mode === "resend") {
        return sendResendEmail(config, { to, subject, html, text });
    }

    throw new Error(`EMAIL_MODE="${config.mode}" is not implemented. Configure a production email provider.`);
}

async function sendVerificationEmail({ email, token, expiryHours, baseUrl }) {
    const verificationUrl = buildVerificationUrl(baseUrl, token);
    const subject = "Verify your AdVault Spy email";
    const html = renderVerificationEmailHtml({ verificationUrl, expiryHours, email });
    const text = renderVerificationEmailText({ verificationUrl, expiryHours, email });

    return sendEmail({ to: email, subject, html, text });
}

module.exports = {
    getEmailConfig,
    generateVerificationToken,
    hashVerificationToken,
    createVerificationExpiry,
    buildVerificationUrl,
    buildPasswordResetUrl,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendEmail,
};

// server.js - AdVault Spy backend API
// Node.js + Express + OpenAI. Analyzes ad data (text + video) and
// returns viral hooks, improved copy, marketing angles, and insights.
//
// Endpoints:
//   POST /analyze   -> analyze ad data
//   GET  /health    -> simple health check
//
// Run: npm start  (or: node server.js)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Stripe client (used by /create-checkout-session) ----
// Requires STRIPE_SECRET_KEY in the environment.
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

// ---- CORS (allow extension popup / any origin) ----
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Root route (public status check) ----
app.get("/", (_req, res) => {
    res.send("AdVault API Running");
});

// ---- Simple in-memory API key + rate limiting (no database) ----
const requests = {};

// Secret key expected in the "x-api-key" header.
const API_KEY = process.env.API_KEY || "my-secret-key";

// Max requests per IP per day.
const RATE_LIMIT = 5;

app.use((req, res, next) => {
    // Checkout is initiated from the frontend and does not require the API key.
    if (req.path === "/create-checkout-session") {
        return next();
    }

    const apiKey = req.headers["x-api-key"];

    // Reject missing/invalid API key.
    if (apiKey !== API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const ip = req.ip;

    if (!requests[ip]) requests[ip] = 0;

    if (requests[ip] > RATE_LIMIT) {
        return res.status(429).json({ error: "Limit reached" });
    }

    requests[ip]++;
    next();
});

// ---- OpenAI client ----
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
 * Returns: { text, video, analysis: { hooks, improved_copy, angles, why_it_works } }
 */
app.post("/analyze", async (req, res) => {
    try {
        const { text, video } = req.body || {};

        // ---- Input validation ----
        if (typeof text !== "string" || text.trim().length === 0) {
            return res.status(400).json({
                error: "Invalid input: 'text' is required and must be a non-empty string.",
            });
        }
        if (typeof video !== "string" || video.trim().length === 0) {
            return res.status(400).json({
                error: "Invalid input: 'video' is required and must be a non-empty string.",
            });
        }

        const userMessage = `Ad text:\n"""${text.trim()}"""\n\nVideo URL:\n${video.trim()}`;

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

        return res.json({
            text: text.trim(),
            video: video.trim(),
            analysis,
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
 * Returns: { text, hooks: { category, label, items: [] } }
 */
app.post("/generate-hooks", async (req, res) => {
    try {
        const { text } = req.body || {};

        // ---- Input validation ----
        if (typeof text !== "string" || text.trim().length === 0) {
            return res.status(400).json({
                error: "Invalid input: 'text' is required and must be a non-empty string.",
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

        return res.json({ text: text.trim(), hooks });
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
 * Creates a Stripe Checkout session (subscription mode) and returns the
 * hosted checkout URL. Price and redirect URLs fall back to environment
 * variables when not provided in the body.
 */
app.post("/create-checkout-session", async (req, res) => {
    try {
        // Stripe is not configured until STRIPE_SECRET_KEY is set.
        if (!stripe) {
            return res.status(500).json({
                error: "STRIPE_SECRET_KEY is not set. Configure it in your .env.",
            });
        }

        const { price, success_url, cancel_url } = req.body || {};

        // Resolve the price ID: body > env. Create a Stripe Price in the
        // dashboard (Products > Add product > Recurring) and put its ID here.
        const priceId = price || process.env.STRIPE_PRICE_ID;
        if (!priceId) {
            return res.status(400).json({
                error: "A 'price' (Stripe Price ID) is required in the body or STRIPE_PRICE_ID env var.",
            });
        }

        // Hosted checkout redirects (fall back to env or local defaults).
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
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "advault-spy-backend", status: "up" });
});

// ---- JSON 404 handler (unknown routes) ----
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});

// ---- JSON error handler (malformed bodies, unexpected errors) ----
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

// ---- Start ----
app.listen(PORT, () => {
    console.log(`[AdVault Spy] API running on http://localhost:${PORT}`);
});

(() => {
    "use strict";


    /* =========================================================
       API
    ========================================================== */

    // Base URL of the AdVault Spy backend. Defaults to the local
    // development server; point this at your deployed backend in
    // production (e.g. "https://advault-backend.onrender.com").
    const API_BASE_URL =
        "http://localhost:3000";

    const API_URL =
        `${API_BASE_URL}/analyze`;

    const HOOKS_API_URL =
        `${API_BASE_URL}/generate-hooks`;

    const USAGE_CONSUME_URL =
        `${API_BASE_URL}/usage/consume`;

    const USAGE_SNAPSHOT_URL =
        `${API_BASE_URL}/usage/snapshot`;

    // TEMPORARY DEVELOPMENT MECHANISM: anonymous device id.
    // The extension no longer logs users in (authentication moved to the
    // AdVault website). To let the backend enforce the Free usage model
    // (2 scans/day) without a fake login, the extension generates a stable
    // random device id and sends it in the X-AdVault-Device-Id header. The
    // backend only honors this in its DEV_ANON_USAGE development mode.
    // Replace this with the landing-page account/subscription flow in
    // production.
    const DEVICE_ID_KEY =
        "advaultDeviceId";


    /* =========================================================
       LANDING PAGE URL
    ========================================================== */

    // The AdVault website handles registration, login, account management,
    // pricing and (future) PayPal checkout. The extension only opens it when
    // the user explicitly clicks "Upgrade to Pro" or "Visit AdVault".
    //
    // Change this ONE value to point the extension at your deployed landing
    // page, e.g. "https://advaulte.com". For local development the bundled
    // page ships with the extension:
    //   chrome.runtime.getURL("landing/index.html")
    const ADVAULT_LANDING_URL =
        chrome.runtime.getURL(
            "landing/index.html"
        );


    /* =========================================================
       ELEMENTS
    ========================================================== */

    const usagePlan =
        document.getElementById("usagePlan");

    const scanBtn =
        document.getElementById("scanBtn");

    const scanBtnLabel =
        document.getElementById("scanBtnLabel");

    const scanIcon =
        document.getElementById("scanIcon");

    const status =
        document.getElementById("status");

    const statusIcon =
        document.getElementById("statusIcon");

    const statusText =
        document.getElementById("statusText");

    const results =
        document.getElementById("results");

    const emptyState =
        document.getElementById("emptyState");

    const adList =
        document.getElementById("adList");

    const adCount =
        document.getElementById("adCount");

    const summaryAds =
        document.getElementById("summaryAds");

    const summaryDomain =
        document.getElementById("summaryDomain");

    const pageTitle =
        document.getElementById("pageTitle");

    const pageUrl =
        document.getElementById("pageUrl");

    const pageType =
        document.getElementById("pageType");

    const aiPanel =
        document.getElementById("aiPanel");

    const aiClose =
        document.getElementById("aiClose");

    const aiTarget =
        document.getElementById("aiTarget");

    const aiHooks =
        document.getElementById("aiHooks");

    const aiCopy =
        document.getElementById("aiCopy");

    const aiAngles =
        document.getElementById("aiAngles");

    const aiWhy =
        document.getElementById("aiWhy");

    const hooksPanel =
        document.getElementById("hooksPanel");

    const hooksClose =
        document.getElementById("hooksClose");

    const hooksTarget =
        document.getElementById("hooksTarget");

    const hooksList =
        document.getElementById("hooksList");

    const copyAllHooks =
        document.getElementById("copyAllHooks");

    const toast =
        document.getElementById("toast");

    const prospectSection =
        document.getElementById("prospectSection");

    const findProspectsBtn =
        document.getElementById("findProspectsBtn");

    const exportProspectsBtn =
        document.getElementById("exportProspectsBtn");

    const prospectCount =
        document.getElementById("prospectCount");

    const prospectList =
        document.getElementById("prospectList");

    const prospectStatus =
        document.getElementById("prospectStatus");

    const upgradeProBtn =
        document.getElementById("upgradeProBtn");

    const visitAdVaultBtn =
        document.getElementById("visitAdVaultBtn");

    const usageCount =
        document.getElementById("usageCount");

    const usageBlock =
        document.getElementById("usageBlock");

    const usageUpgradeBtn =
        document.getElementById("usageUpgradeBtn");


    /* =========================================================
       STATE
    ========================================================== */

    let currentAds = [];

    let selectedAd = null;

    let generatedHooks = [];

    let currentProspects = [];

    let scanInProgress = false;

    // Cached usage state. The server remains the source of truth; these are
    // refreshed from the backend and never trusted locally. No user identity
    // is stored — the extension does not authenticate.
    let deviceId = null;

    let entitlementState = null;

    let usageState = null;


    /* =========================================================
       INITIALIZE
    ========================================================== */

    document.addEventListener(
        "DOMContentLoaded",
        initialize
    );


    async function initialize() {

        // Open the normal AdVault Spy interface immediately. No login, no
        // session restore, no redirect — the scanner UI just appears.
        await ensureDeviceId();

        await loadCurrentPageInfo();

        // Pull the authoritative usage snapshot (dev-only anonymous mode).
        // If the backend is unreachable we keep the default FREE quota and
        // the server still enforces the limit on the next consume call.
        await refreshUsageSnapshot();

        // TEMPORARY DEVELOPMENT FALLBACK: no snapshot yet (backend unreachable)
        // — default to the full FREE quota locally. The server remains
        // authoritative on the next consume call. The extension never
        // pretends an unauthenticated user is logged in.
        if (!usageState) {

            usageState = {
                unlimited: false,
                used: 0,
                limit: 2,
                remaining: 2,
                resetDate: null
            };

        }

        renderPlanState();

    }


        /* =========================================================
       DEVICE ID + USAGE
    ========================================================== */

    // TEMPORARY DEVELOPMENT MECHANISM: generate a stable anonymous device id
    // used only for the dev-only usage counter. It is never tied to a user
    // account and never makes the extension look authenticated. Replaced by
    // the landing-page account/subscription flow in production.
    async function ensureDeviceId() {

        if (deviceId) {

            return deviceId;

        }

        try {

            const data =
                await chrome.storage.local.get(
                    DEVICE_ID_KEY
                );

            if (data[DEVICE_ID_KEY]) {

                deviceId =
                    data[DEVICE_ID_KEY];

                return deviceId;

            }

        } catch (error) {

            console.error(
                "Device id restore error:",
                error
            );

        }

        const generated =
            "dev-" + crypto.randomUUID();

        deviceId =
            generated;

        try {

            await chrome.storage.local.set({
                [DEVICE_ID_KEY]: generated
            });

        } catch (error) {

            console.error(
                "Device id persist error:",
                error
            );

        }

        return deviceId;

    }


    function authHeaders() {

        const headers = {
            "Content-Type":
                "application/json"
        };

        if (deviceId) {

            // Development-only anonymous usage header (see DEV_ANON_USAGE on
            // the backend). Never sent as a Bearer token — no auth involved.
            headers["X-AdVault-Device-Id"] =
                deviceId;

        }

        return headers;

    }


    async function apiGet(
        url
    ) {

        return fetch(
            url,
            {
                method: "GET",
                headers: authHeaders()
            }
        );

    }


    async function apiPost(
        url,
        body
    ) {

        return fetch(
            url,
            {
                method: "POST",
                headers: authHeaders(),
                body:
                    JSON.stringify(
                        body || {}
                    )
            }
        );

    }


    // Pull the authoritative usage snapshot without consuming a use. Returns
    // { ok, data } and never throws to the caller.
    async function refreshUsageSnapshot() {

        try {

            const response =
                await apiGet(
                    USAGE_SNAPSHOT_URL
                );

            if (!response.ok) {

                return {
                    ok: false,
                    status:
                        response.status
                };

            }

            const data =
                await response.json();

            if (data.entitlement) {

                entitlementState =
                    data.entitlement;

            }

            if (data.usage) {

                usageState =
                    data.usage;

            }

            return {
                ok: true,
                data
            };

        } catch (error) {

            console.error(
                "Usage snapshot error:",
                error
            );

            return {
                ok: false,
                network: true
            };

        }

    }


    // Consume one qualifying use on the server (called after a successful
    // scan). Returns { ok, data } — never throws to the caller for expected
    // limit / rate responses.
    async function consumeServerUsage() {

        try {

            const response =
                await apiPost(
                    USAGE_CONSUME_URL
                );

            const data =
                await response.json().catch(
                    () => ({})
                );

            // Update the cached usage/entitlement from every response (including
            // 403 daily-limit responses) so the UI reflects the real remaining
            // uses, not a stale snapshot.
            if (data.entitlement) {

                entitlementState =
                    data.entitlement;

            }

            if (data.usage) {

                usageState =
                    data.usage;

            }

            if (!response.ok) {

                return {
                    ok: false,
                    status:
                        response.status,
                    data
                };

            }

            return {
                ok: true,
                data
            };

        } catch (error) {

            console.error(
                "Usage consume error:",
                error
            );

            return {
                ok: false,
                network: true
            };

        }

    }


    // Local server-authoritative usage check used by the scan gate. If the
    // backend has not been reached yet (no snapshot), falls back to the full
    // FREE quota so the scanner still opens — the server enforces on the next
    // consume call.
    function getRemainingUses() {

        const entitlement =
            entitlementState ||
            {};

        if (entitlement.isUnlimited) {

            return Infinity;

        }

        const usage =
            usageState ||
            {};

        if (usage.remaining == null) {

            return 2;

        }

        return Number(
            usage.remaining
        );

    }


    /* =========================================================
       PLAN STATE
    ========================================================== */

    function renderPlanState() {

        const entitlement =
            entitlementState ||
            {};

        const plan =
            String(
                entitlement.plan ||
                "FREE"
            ).toUpperCase();

        const usage =
            usageState ||
            {};

        const unlimited =
            Boolean(
                entitlement.isUnlimited
            );

        let label =
            "Unlimited access";

        let remaining =
            null;

        if (!unlimited) {

            remaining =
                Number(
                    usage.remaining ?? 0
                );

            label =
                remaining === 1
                    ? "1 use remaining today"
                    : `${remaining} uses remaining today`;

        }

        if (usagePlan) {

            usagePlan.textContent =
                `${plan} PLAN`;

        }

        if (usageCount) {

            usageCount.textContent =
                label;

            usageCount.classList.toggle(
                "low",
                !unlimited && remaining === 1
            );

            usageCount.classList.toggle(
                "none",
                !unlimited && remaining === 0
            );

        }

        const exhausted =
            !unlimited &&
            remaining === 0;

        if (usageBlock) {

            usageBlock.classList.toggle(
                "hidden",
                !exhausted
            );

        }

        if (scanBtn) {

            scanBtn.disabled =
                exhausted;

        }

    }


    /* =========================================================
       CURRENT TAB
    ========================================================== */

    async function getActiveTab() {

        const tabs =
            await chrome.tabs.query({
                active: true,
                currentWindow: true
            });

        return tabs && tabs.length
            ? tabs[0]
            : null;
    }


    /* =========================================================
       PAGE INFORMATION
    ========================================================== */

    async function loadCurrentPageInfo() {

        try {

            const tab =
                await getActiveTab();

            if (!tab) {
                return;
            }

            const title =
                tab.title ||
                "Current webpage";

            const url =
                tab.url ||
                "";

            pageTitle.textContent =
                title;

            pageUrl.textContent =
                getDomain(url);

            pageType.textContent =
                getPageType(url);

            summaryDomain.textContent =
                getDomain(url);

        } catch (error) {

            console.error(
                "Page info error:",
                error
            );

        }

    }


    function getDomain(url) {

        try {

            if (!url) {
                return "Current page";
            }

            const parsed =
                new URL(url);

            return parsed.hostname
                .replace(/^www\./, "");

        } catch {

            return "Current page";

        }

    }


    function getPageType(url) {

        if (!url) {
            return "WEB";
        }

        const lower =
            url.toLowerCase();

        if (
            lower.includes("facebook.com")
        ) {
            return "FACEBOOK";
        }

        if (
            lower.includes("instagram.com")
        ) {
            return "INSTAGRAM";
        }

        if (
            lower.includes("youtube.com")
        ) {
            return "YOUTUBE";
        }

        if (
            lower.includes("tiktok.com")
        ) {
            return "TIKTOK";
        }

        if (
            lower.includes("amazon.")
        ) {
            return "AMAZON";
        }

        if (
            lower.includes("linkedin.com")
        ) {
            return "LINKEDIN";
        }

        if (
            lower.includes("x.com") ||
            lower.includes("twitter.com")
        ) {
            return "X";
        }

        return "WEB";

    }


    /* =========================================================
       STATUS
    ========================================================== */

    function showStatus(
        message,
        icon = "ℹ️"
    ) {

        status.classList.remove(
            "hidden"
        );

        statusIcon.textContent =
            icon;

        statusText.textContent =
            message;

    }


    function hideStatus() {

        status.classList.add(
            "hidden"
        );

    }


    /* =========================================================
       CONTENT SCRIPT
    ========================================================== */

    async function ensureContentScript(
        tabId
    ) {

        try {

            await chrome.tabs.sendMessage(
                tabId,
                {
                    type: "PING"
                }
            );

            return true;

        } catch {

            try {

                await chrome.scripting.executeScript({
                    target: {
                        tabId
                    },

                    files: [
                        "content.js"
                    ]
                });

                return true;

            } catch (error) {

                console.error(
                    "Could not inject content script:",
                    error
                );

                return false;

            }

        }

    }


    /* =========================================================
       SCAN
    ========================================================== */

    scanBtn.addEventListener(
        "click",
        scanPage
    );

    if (findProspectsBtn) {
        findProspectsBtn.addEventListener(
            "click",
            findProspectsFromScan
        );
    }

    if (exportProspectsBtn) {
        exportProspectsBtn.addEventListener(
            "click",
            exportProspectsCSV
        );
    }


    async function scanPage() {

        if (scanInProgress) {

            return;

        }

        scanInProgress =
            true;

        scanBtn.disabled = true;

        scanBtnLabel.textContent =
            "Scanning page...";

        scanIcon.textContent =
            "⏳";

        hideStatus();

        try {

            // Gate on the server-authoritative remaining usage.
            if (
                getRemainingUses() <= 0
            ) {

                renderPlanState();

                showStatus(
                    "You've used your 2 free scans. Upgrade to Pro for unlimited access.",
                    "🔒"
                );

                return;

            }

            const tab =
                await getActiveTab();

            if (!tab || !tab.id) {

                showStatus(
                    "Could not access the current tab.",
                    "⚠️"
                );

                return;
            }


            /* Chrome internal pages */

            if (
                tab.url &&
                (
                    tab.url.startsWith(
                        "chrome://"
                    ) ||
                    tab.url.startsWith(
                        "edge://"
                    ) ||
                    tab.url.startsWith(
                        "about:"
                    ) ||
                    tab.url.startsWith(
                        "chrome-extension://"
                    )
                )
            ) {

                showStatus(
                    "Chrome system pages cannot be scanned.",
                    "⚠️"
                );

                return;

            }


            const ready =
                await ensureContentScript(
                    tab.id
                );

            if (!ready) {

                showStatus(
                    "AdVault could not access this webpage.",
                    "⚠️"
                );

                return;

            }


            const response =
                await chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: "SCAN_ADS"
                    }
                );


            if (
                !response ||
                !response.ok
            ) {

                throw new Error(
                    "Scan failed"
                );

            }


            // Consume one qualifying use on the server (authoritative). If the
            // server rejects the use (daily limit reached), block the results
            // and surface the upgrade CTA.
            const consumeResult =
                await consumeServerUsage();

            if (
                !consumeResult.ok &&
                consumeResult.status === 403
            ) {

                renderPlanState();

                showStatus(
                    "You've used your 2 free scans. Upgrade to Pro for unlimited access.",
                    "🔒"
                );

                return;

            }

            renderPlanState();


            currentAds =
                normalizeAds(
                    response.ads || [],
                    tab
                );


            renderAds(
                currentAds
            );

            // Prospecting is derived from the same page scan.
            if (prospectSection) {
                prospectSection.classList.remove("hidden");
                prospectList.innerHTML = "";
                prospectCount.textContent = "0";
                exportProspectsBtn?.classList.add("hidden");
                showProspectStatus(
                    currentAds.length
                        ? "Scan complete. Find businesses on this page that may benefit from AdVault Spy."
                        : "No ads were detected. You can still look for public businesses on this page.",
                    "ℹ️"
                );
            }


            if (currentAds.length) {

                showStatus(
                    `${currentAds.length} pieces of promotional content detected.`,
                    "✅"
                );

            } else {

                showStatus(
                    "No obvious advertisements detected on this page.",
                    "ℹ️"
                );

            }


        } catch (error) {

            console.error(
                "Scan error:",
                error
            );

            showStatus(
                "Unable to scan this page. Try refreshing the webpage.",
                "⚠️"
            );

        } finally {

            scanInProgress =
                false;

            scanBtnLabel.textContent =
                "Scan Page";

            scanIcon.textContent =
                "🔍";

            // Always restore the correct button state. When the daily limit was
            // reached, renderPlanState keeps the button disabled.
            renderPlanState();

        }

    }



    /* =========================================================
       PROSPECTING FROM THE SCANNED PAGE
    ========================================================== */

    // Restore the original two-span layout when the loading state ends.
    const FIND_PROSPECTS_DEFAULT_HTML =
        '<span>Find Prospects</span><span>→</span>';

    async function findProspectsFromScan() {
        if (!findProspectsBtn) return;

        findProspectsBtn.disabled = true;
        findProspectsBtn.innerHTML = '<span>⏳ Finding prospects…</span><span aria-hidden="true">…</span>';
        showProspectStatus("Reading public business information from the page…", "⏳");

        try {
            const tab = await getActiveTab();

            if (!tab?.id) {
                throw new Error("No active page.");
            }

            const ready = await ensureContentScript(tab.id);
            if (!ready) {
                throw new Error("AdVault could not access this page. Refresh it and try again.");
            }

            const response = await chrome.tabs.sendMessage(
                tab.id,
                { type: "EXTRACT_PROSPECTS_FROM_SCAN" }
            );

            if (!response?.ok) {
                throw new Error(response?.error || "Could not extract prospects.");
            }

            currentProspects = scoreProspects(
                response.prospects || [],
                currentAds,
                tab
            );

            renderProspects(currentProspects);

            showProspectStatus(
                currentProspects.length
                    ? `${currentProspects.length} public prospects found from this scanned page.`
                    : "No clear business prospects were found on this page. Try a business directory, Google Maps results, or another page containing listings.",
                currentProspects.length ? "✅" : "ℹ️"
            );

            if (currentProspects.length) {
                exportProspectsBtn?.classList.remove("hidden");
            }
        } catch (error) {
            console.error("Prospecting error:", error);
            showProspectStatus(error.message || "Unable to find prospects.", "⚠️");
        } finally {
            findProspectsBtn.disabled = false;
            findProspectsBtn.innerHTML = FIND_PROSPECTS_DEFAULT_HTML;
        }
    }

    function showProspectStatus(message, icon = "ℹ️") {
        if (!prospectStatus) return;
        prospectStatus.textContent = `${icon} ${message}`;
        prospectStatus.classList.remove("hidden");
    }

    function getHostname(value) {
        try {
            return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
        } catch (_) {
            return "";
        }
    }

    function normalizeBusinessName(value) {
        return cleanText(value || "", 180)
            .toLowerCase()
            .replace(/[^a-z0-9]+/gi, " ")
            .replace(/\b(inc|llc|ltd|limited|pvt|private|co|company)\b/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function namesMatch(a, b) {
        const x = normalizeBusinessName(a);
        const y = normalizeBusinessName(b);
        if (!x || !y) return false;
        if (x === y) return true;
        if (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x))) return true;

        const xs = new Set(x.split(" ").filter(w => w.length > 2));
        const ys = new Set(y.split(" ").filter(w => w.length > 2));
        const overlap = [...xs].filter(w => ys.has(w)).length;
        return overlap >= 2 && overlap / Math.max(xs.size, ys.size) >= 0.5;
    }

    function findAdvertisingEvidence(prospect, ads) {
        const websiteHost = getHostname(prospect.website);
        const prospectName = prospect.name || "";

        return (ads || []).filter(ad => {
            const advertiser = ad.advertiser || ad.brand || "";
            const adHost = getHostname(ad.url || "");

            const nameMatch = advertiser && namesMatch(prospectName, advertiser);
            const titleMatch = ad.title && namesMatch(prospectName, ad.title);
            const domainMatch = websiteHost && adHost && (
                websiteHost === adHost ||
                websiteHost.endsWith("." + adHost) ||
                adHost.endsWith("." + websiteHost)
            );

            return Boolean(nameMatch || titleMatch || domainMatch);
        });
    }

    function scoreProspects(prospects, ads, tab) {
        return prospects.map(prospect => {
            const evidence = findAdvertisingEvidence(prospect, ads);
            const reasons = [];
            const signals = [...(prospect.signals || [])];

            let score = 30;

            if (prospect.website) {
                score += 12;
                reasons.push("public website found");
            }

            if (prospect.phone || prospect.email) {
                score += 8;
                reasons.push("public contact information found");
            }

            if (prospect.category) {
                score += 5;
                reasons.push("business category identified");
            }

            if (prospect.rating) {
                score += 3;
            }

            if (prospect.reviewCount) {
                score += Math.min(5, Math.round(Math.log10(prospect.reviewCount + 1)));
            }

            if (evidence.length) {
                score += 25;
                reasons.push(
                    evidence.length === 1
                        ? "advertising evidence matches this business"
                        : `${evidence.length} advertising signals match this business`
                );
                signals.push("matched advertising evidence");
            }

            const pageAdCount = Array.isArray(ads) ? ads.length : 0;
            if (pageAdCount > 0 && !evidence.length) {
                reasons.push("promotional content exists on the page, but it is not attributed to this business");
            }

            if (!prospect.website && !prospect.phone && !prospect.email) {
                score -= 5;
                reasons.push("limited public contact data");
            }

            score = Math.max(0, Math.min(100, score));

            const tier =
                score >= 80 ? "HOT" :
                score >= 60 ? "GOOD" :
                "POSSIBLE";

            const adNames = evidence
                .map(ad => ad.advertiser || ad.brand || ad.title)
                .filter(Boolean)
                .slice(0, 2);

            const pitch = evidence.length
                ? `Hi ${prospect.name}, I found your business while researching your advertising presence. I noticed signals around your current promotion and thought AdVault Spy could help you spot weaker hooks, compare creative angles and generate stronger ad variations.`
                : `Hi ${prospect.name}, I came across your business while researching local companies in your category. AdVault Spy helps teams analyze advertising creative, identify weak hooks and turn those findings into stronger ad variations.`;

            return {
                ...prospect,
                score,
                tier,
                matchedAd: evidence.length > 0,
                advertisingEvidence: evidence.map(ad => ({
                    advertiser: ad.advertiser || ad.brand || "",
                    title: ad.title || "",
                    url: ad.url || ""
                })),
                advertisingSignalCount: evidence.length,
                matchedAdvertisers: adNames,
                signals: [...new Set(signals)],
                reason: reasons.length
                    ? reasons.join(" • ")
                    : "Public business listing found on the scanned page.",
                pitch
            };
        })
        .sort((a, b) => b.score - a.score)
        .map((item, index) => ({ ...item, rank: index + 1 }));
    }

    function renderProspects(prospects) {
        if (!prospectList || !prospectCount) return;

        prospectCount.textContent = prospects.length;
        prospectList.innerHTML = "";

        prospects.forEach(prospect => {
            const card = document.createElement("article");
            card.className = "prospect-card";

            const websiteHtml = prospect.website
                ? `<a href="${escapeAttribute(safeUrl(prospect.website))}" target="_blank" rel="noopener">Website ↗</a>`
                : "";

            const sourceHtml = prospect.url
                ? `<a href="${escapeAttribute(safeUrl(prospect.url))}" target="_blank" rel="noopener">Source ↗</a>`
                : "";

            const ratingHtml = prospect.rating
                ? `⭐ ${escapeHtml(String(prospect.rating))}${prospect.reviewCount ? ` (${escapeHtml(String(prospect.reviewCount))} reviews)` : ""}`
                : "";

            const adEvidenceHtml = prospect.matchedAd
                ? `<span class="prospect-signal hot">📣 ${prospect.advertisingSignalCount} ad signal${prospect.advertisingSignalCount === 1 ? "" : "s"}</span>`
                : `<span class="prospect-signal">🔎 ${prospect.signals?.length || 1} page signal${(prospect.signals?.length || 1) === 1 ? "" : "s"}</span>`;

            card.innerHTML = `
                <div class="prospect-card-top">
                    <div>
                        <div class="prospect-name">${escapeHtml(prospect.name)}</div>
                        <div class="prospect-meta">
                            ${escapeHtml(prospect.category || "Business prospect")}
                            ${prospect.address ? ` · ${escapeHtml(prospect.address.slice(0, 150))}` : ""}
                        </div>
                    </div>
                    <div class="prospect-score">${prospect.score}/100</div>
                </div>

                <div class="prospect-meta prospect-facts">
                    ${ratingHtml}
                    ${prospect.phone ? `${ratingHtml ? " · " : ""}☎ ${escapeHtml(prospect.phone)}` : ""}
                    ${prospect.email ? `${ratingHtml || prospect.phone ? " · " : ""}✉ ${escapeHtml(prospect.email)}` : ""}
                </div>

                <div class="prospect-signals">
                    <span class="prospect-tier ${String(prospect.tier).toLowerCase()}">${escapeHtml(prospect.tier)} PROSPECT</span>
                    ${adEvidenceHtml}
                </div>

                <div class="prospect-reason">
                    <strong>Why:</strong> ${escapeHtml(prospect.reason)}
                </div>

                <div class="prospect-copy">
                    <strong>Suggested pitch:</strong> ${escapeHtml(prospect.pitch)}
                </div>

                <div class="prospect-links">
                    ${websiteHtml}
                    ${sourceHtml}
                    <a href="#" data-copy-prospect="${escapeAttribute(String(prospect.rank))}">Copy pitch</a>
                </div>
            `;

            const copy = card.querySelector("[data-copy-prospect]");
            copy?.addEventListener("click", async event => {
                event.preventDefault();
                await navigator.clipboard.writeText(prospect.pitch);
                showToast("Pitch copied");
            });

            prospectList.appendChild(card);
        });
    }

    function exportProspectsCSV() {
        if (!currentProspects.length) return;

        const headers = [
            "Rank", "Company", "Score", "Tier", "Category",
            "Address", "Phone", "Email", "Website",
            "Rating", "Review Count", "Advertising Signals",
            "Matched Advertisers", "Signals", "Source", "Reason", "Suggested Pitch"
        ];

        const rows = currentProspects.map(p => [
            p.rank,
            p.name,
            p.score,
            p.tier,
            p.category,
            p.address,
            p.phone,
            p.email,
            p.website,
            p.rating ?? "",
            p.reviewCount ?? "",
            p.advertisingSignalCount || 0,
            (p.matchedAdvertisers || []).join("; "),
            (p.signals || []).join("; "),
            p.url,
            p.reason,
            p.pitch
        ]);

        // BOM so Excel decodes non-ASCII characters (accented names, etc.).
        const csv = "\uFEFF" + [
            headers,
            ...rows
        ].map(row =>
            row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")
        ).join("\r\n");

        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `advault-prospects-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Prospects exported");
    }

    /* =========================================================
       NORMALIZE ADS
    ========================================================== */

    function normalizeAds(
        ads,
        tab
    ) {

        return ads.map(
            (ad, index) => {

                const item =
                    ad || {};

                return {

                    id:
                        item.id ||
                        `ad-${index}`,

                    title:
                        cleanText(
                            item.title ||
                            item.headline ||
                            "Detected promotional content"
                        ),

                    network:
                        cleanText(
                            item.network ||
                            item.platform ||
                            getPageType(
                                tab.url
                            )
                        ),

                    type:
                        cleanText(
                            item.type ||
                            "content"
                        ),

                    text:
                        cleanText(
                            item.text ||
                            item.description ||
                            item.copy ||
                            ""
                        ),

                    image:
                        item.image ||
                        item.imageUrl ||
                        item.thumbnail ||
                        "",

                    video:
                        item.video ||
                        item.videoUrl ||
                        "",

                    url:
                        item.url ||
                        item.link ||
                        tab.url ||
                        "",

                    advertiser:
                        cleanText(
                            item.advertiser ||
                            item.brand ||
                            ""
                        )

                };

            }
        );

    }


    /* =========================================================
       RENDER ADS
    ========================================================== */

    function renderAds(
        ads
    ) {

        adList.innerHTML = "";

        adCount.textContent =
            ads.length;

        summaryAds.textContent =
            ads.length;

        if (!ads.length) {

            results.classList.add(
                "hidden"
            );

            emptyState.classList.remove(
                "hidden"
            );

            return;

        }


        emptyState.classList.add(
            "hidden"
        );

        results.classList.remove(
            "hidden"
        );


        ads.forEach(
            (ad, index) => {

                const card =
                    createAdCard(
                        ad,
                        index
                    );

                adList.appendChild(
                    card
                );

            }
        );

    }


    /* =========================================================
       CREATE AD CARD
    ========================================================== */

    function createAdCard(
        ad,
        index
    ) {

        const card =
            document.createElement(
                "article"
            );

        card.className =
            "ad-card";


        const title =
            ad.title ||
            "Detected promotional content";


        const copy =
            ad.text ||
            "";


        const type =
            ad.type ||
            "content";


        const network =
            ad.network ||
            "WEB";


        const advertiser =
            ad.advertiser ||
            "";


        card.innerHTML = `

            <div class="ad-top">

                <div class="ad-heading">

                    <div class="ad-title">
                        ${escapeHtml(title)}
                    </div>

                    <div class="ad-subtitle">
                        ${escapeHtml(
                            advertiser ||
                            "Promotional content detected"
                        )}
                    </div>

                </div>

                <div class="ad-type">
                    ${escapeHtml(type)}
                </div>

            </div>


            ${
                ad.image
                ? `
                    <div class="ad-image-wrap">
                        <img
                            class="ad-image"
                            src="${escapeAttribute(ad.image)}"
                            alt="Detected creative"
                        >
                    </div>
                `
                : ""
            }


            <div
                class="ad-copy ${
                    copy
                        ? ""
                        : "empty"
                }"
            >
                ${
                    copy
                        ? escapeHtml(
                            truncate(
                                copy,
                                320
                            )
                        )
                        : "No readable ad copy found."
                }
            </div>


            <div class="ad-meta">

                <span class="meta-chip">
                    <strong>Network:</strong>
                    ${escapeHtml(network)}
                </span>

                <span class="meta-chip">
                    <strong>Type:</strong>
                    ${escapeHtml(type)}
                </span>

                ${
                    advertiser
                    ? `
                        <span class="meta-chip">
                            <strong>Brand:</strong>
                            ${escapeHtml(
                                advertiser
                            )}
                        </span>
                    `
                    : ""
                }

            </div>


            <div class="ad-actions">

                <button
                    class="action-button analyze-button"
                    data-action="analyze"
                    data-index="${index}"
                >
                    ✨ Analyze AI
                </button>

                <button
                    class="action-button hooks-button"
                    data-action="hooks"
                    data-index="${index}"
                >
                    🪝 Hooks
                </button>

                <button
                    class="action-button copy-button"
                    data-action="copy"
                    data-index="${index}"
                >
                    📋 Copy
                </button>

            </div>


            <div
                id="output-${index}"
                class="ad-output"
            ></div>

        `;


        return card;

    }


    /* =========================================================
       AD ACTIONS
    ========================================================== */

    adList.addEventListener(
        "click",
        async (event) => {

            const button =
                event.target.closest(
                    "button[data-action]"
                );

            if (!button) {
                return;
            }


            const index =
                Number(
                    button.dataset.index
                );

            const action =
                button.dataset.action;


            const ad =
                currentAds[index];


            if (!ad) {
                return;
            }


            if (action === "copy") {

                await copyAd(
                    ad
                );

                return;

            }


            if (action === "analyze") {

                await analyzeAd(
                    ad,
                    index
                );

                return;

            }


            if (action === "hooks") {

                await generateHooks(
                    ad,
                    index
                );

            }

        }
    );


    /* =========================================================
       COPY AD
    ========================================================== */

    async function copyAd(
        ad
    ) {

        const text =
            ad.text ||
            ad.title ||
            "";


        if (!text) {

            showToast(
                "Nothing to copy"
            );

            return;

        }


        try {

            await navigator.clipboard.writeText(
                text
            );

            showToast(
                "Ad copy copied"
            );

        } catch {

            showToast(
                "Copy failed"
            );

        }

    }


    /* =========================================================
       ANALYZE AI
    ========================================================== */

    async function analyzeAd(
        ad,
        index
    ) {

        selectedAd =
            ad;


        openAiPanel(
            ad
        );


        const output =
            document.getElementById(
                `output-${index}`
            );


        if (output) {

            output.classList.add(
                "visible"
            );

            output.innerHTML =
                `<span class="loading-dots">Analyzing with AI</span>`;

        }


        try {

            const response =
                await apiPost(
                    API_URL,
                    {
                        text:
                            buildAdText(
                                ad
                            ),
                        video:
                            ad.video ||
                            ad.url ||
                            ""
                    }
                );


            if (response.status === 401) {

                // No authentication in the extension. A 401 means the backend
                // is not running in DEV_ANON_USAGE mode — fall back to the
                // local demo so the tool still responds.
                showStatus(
                    "Analysis service is unavailable.",
                    "⚠️"
                );

                throw new Error(
                    "Unauthorized"
                );

            }


            if (response.status === 403) {

                renderPlanState();

                showStatus(
                    "You've reached today's 2 free uses. Upgrade to Pro for unlimited access.",
                    "🔒"
                );

                throw new Error(
                    "Usage limit reached"
                );

            }


            if (!response.ok) {

                throw new Error(
                    `HTTP ${response.status}`
                );

            }


            const data =
                await response.json();


            if (data.entitlement) {

                entitlementState =
                    data.entitlement;

            }

            if (data.usage) {

                usageState =
                    data.usage;

            }


            const analysis =
                data.analysis ||
                data;


            renderAiAnalysis(
                analysis
            );


            if (output) {

                output.innerHTML =
                    `
                    <div class="output-title">
                        AI analysis ready
                    </div>
                    Hooks, copy angles and
                    reasoning are available above.
                    `;

            }


        } catch (error) {

            console.error(
                "AI analysis error:",
                error
            );


            renderDemoAnalysis(
                ad
            );


            if (output) {

                output.innerHTML =
                    `
                    <div class="output-title">
                        Demo analysis
                    </div>
                    Backend unavailable.
                    Showing a local fallback.
                    `;

            }

        }

    }


    /* =========================================================
       OPEN AI PANEL
    ========================================================== */

    function openAiPanel(
        ad
    ) {

        aiPanel.classList.remove(
            "hidden"
        );


        aiTarget.textContent =
            buildTargetDescription(
                ad
            );


        aiHooks.innerHTML =
            `<div class="panel-loading">
                Waiting for analysis...
            </div>`;

        aiCopy.textContent =
            "Waiting for analysis...";

        aiAngles.innerHTML =
            "Waiting for analysis...";

        aiWhy.textContent =
            "Waiting for analysis...";

    }


    /* =========================================================
       RENDER AI ANALYSIS
    ========================================================== */

    function renderAiAnalysis(
        analysis
    ) {

        const hooks =
            Array.isArray(
                analysis.hooks
            )
                ? analysis.hooks
                : [];


        const angles =
            Array.isArray(
                analysis.angles
            )
                ? analysis.angles
                : [];


        aiHooks.innerHTML =
            hooks.length
                ? hooks.map(
                    hook =>
                        `
                        <div class="hook-item">
                            ${escapeHtml(
                                String(hook)
                            )}
                        </div>
                        `
                ).join("")
                : "No hooks returned.";


        aiCopy.textContent =
            analysis.improved_copy ||
            analysis.copy ||
            "No improved copy returned.";


        aiAngles.innerHTML =
            angles.length
                ? angles.map(
                    angle =>
                        `
                        <span class="angle-item">
                            ${escapeHtml(
                                String(angle)
                            )}
                        </span>
                        `
                ).join("")
                : "No marketing angles returned.";


        aiWhy.textContent =
            analysis.why_it_works ||
            analysis.why ||
            "No explanation returned.";

    }


    /* =========================================================
       DEMO ANALYSIS
    ========================================================== */

    function renderDemoAnalysis(
        ad
    ) {

        const text =
            ad.text ||
            ad.title ||
            "this advertisement";


        aiHooks.innerHTML = `
            <div class="hook-item">
                ${escapeHtml(
                    `Why is everyone choosing ${truncate(text, 45)}?`
                )}
            </div>

            <div class="hook-item">
                ${escapeHtml(
                    `The problem with ${truncate(text, 45)}...`
                )}
            </div>

            <div class="hook-item">
                ${escapeHtml(
                    `Before you buy, see this.`
                )}
            </div>
        `;


        aiCopy.textContent =
            `Discover a simpler way to understand and act on this offer.`;


        aiAngles.innerHTML = `
            <span class="angle-item">
                Curiosity
            </span>

            <span class="angle-item">
                Problem / Solution
            </span>

            <span class="angle-item">
                Benefit
            </span>
        `;


        aiWhy.textContent =
            "The creative appears to use a combination of curiosity, clear benefits and a direct action-oriented message.";

    }


    /* =========================================================
       HOOK GENERATOR
    ========================================================== */

    async function generateHooks(
        ad,
        index
    ) {

        selectedAd =
            ad;


        openHooksPanel(
            ad
        );


        const output =
            document.getElementById(
                `output-${index}`
            );


        if (output) {

            output.classList.add(
                "visible"
            );

            output.innerHTML =
                `<span class="loading-dots">Generating hooks</span>`;

        }


        try {

            const response =
                await apiPost(
                    HOOKS_API_URL,
                    {
                        text:
                            buildAdText(
                                ad
                            )
                    }
                );


            if (response.status === 401) {

                // No authentication in the extension. A 401 means the backend
                // is not running in DEV_ANON_USAGE mode — fall back to the
                // local demo so the tool still responds.
                showStatus(
                    "Analysis service is unavailable.",
                    "⚠️"
                );

                throw new Error(
                    "Unauthorized"
                );

            }


            if (response.status === 403) {

                renderPlanState();

                showStatus(
                    "You've reached today's 2 free uses. Upgrade to Pro for unlimited access.",
                    "🔒"
                );

                throw new Error(
                    "Usage limit reached"
                );

            }


            if (!response.ok) {

                throw new Error(
                    `HTTP ${response.status}`
                );

            }


            const data =
                await response.json();


            if (data.entitlement) {

                entitlementState =
                    data.entitlement;

            }

            if (data.usage) {

                usageState =
                    data.usage;

            }


            // The backend returns hooks grouped by category:
            // [{ category, label, items: ["...", "..."] }].
            const groups =
                Array.isArray(
                    data.hooks
                )
                    ? data.hooks
                    : [];

            generatedHooks =
                groups.flatMap(
                    group =>
                        Array.isArray(
                            group &&
                            group.items
                        )
                            ? group.items
                            : []
                );


            renderHooks(
                generatedHooks
            );


            if (output) {

                output.innerHTML =
                    `
                    <div class="output-title">
                        Hooks generated
                    </div>
                    ${generatedHooks.length}
                    hook variations available.
                    `;

            }


        } catch (error) {

            console.error(
                "Hook generation error:",
                error
            );


            generatedHooks =
                createDemoHooks(
                    ad
                );


            renderHooks(
                generatedHooks
            );


            if (output) {

                output.innerHTML =
                    `
                    <div class="output-title">
                        Demo hooks
                    </div>
                    Backend unavailable.
                    Showing local examples.
                    `;

            }

        }

    }


    /* =========================================================
       OPEN HOOK PANEL
    ========================================================== */

    function openHooksPanel(
        ad
    ) {

        hooksPanel.classList.remove(
            "hidden"
        );


        hooksTarget.textContent =
            buildTargetDescription(
                ad
            );


        hooksList.innerHTML =
            `
            <div class="panel-loading">
                <span class="loading-dots">
                    Generating hooks
                </span>
            </div>
            `;

    }


    /* =========================================================
       RENDER HOOKS
    ========================================================== */

    function renderHooks(
        hooks
    ) {

        if (!hooks.length) {

            hooksList.innerHTML =
                `
                <div class="panel-loading">
                    No hooks were returned.
                </div>
                `;

            return;

        }


        hooksList.innerHTML =
            hooks.map(
                (hook, index) =>
                    `
                    <div class="generated-hook">

                        <div>
                            ${escapeHtml(
                                String(hook)
                            )}
                        </div>

                        <button
                            class="generated-hook-copy"
                            data-hook-index="${index}"
                            title="Copy hook"
                        >
                            📋
                        </button>

                    </div>
                    `
            ).join("");

    }


    /* =========================================================
       DEMO HOOKS
    ========================================================== */

    function createDemoHooks(
        ad
    ) {

        const subject =
            truncate(
                ad.text ||
                ad.title ||
                "this product",
                50
            );


        return [

            `Stop scrolling — here's what you need to know about ${subject}.`,

            `Most people don't know this about ${subject}.`,

            `Before you try ${subject}, watch this.`,

            `Here's why people are paying attention to ${subject}.`,

            `The simple reason ${subject} is getting noticed.`

        ];

    }


    /* =========================================================
       HOOK COPY
    ========================================================== */

    hooksList.addEventListener(
        "click",
        async event => {

            const button =
                event.target.closest(
                    "[data-hook-index]"
                );

            if (!button) {
                return;
            }


            const index =
                Number(
                    button.dataset.hookIndex
                );


            const hook =
                generatedHooks[index];


            if (!hook) {
                return;
            }


            try {

                await navigator.clipboard.writeText(
                    String(hook)
                );

                showToast(
                    "Hook copied"
                );

            } catch {

                showToast(
                    "Copy failed"
                );

            }

        }
    );


    /* =========================================================
       COPY ALL HOOKS
    ========================================================== */

    copyAllHooks.addEventListener(
        "click",
        async () => {

            if (!generatedHooks.length) {

                showToast(
                    "No hooks available"
                );

                return;

            }


            try {

                await navigator.clipboard.writeText(
                    generatedHooks
                        .map(
                            (hook, index) =>
                                `${index + 1}. ${hook}`
                        )
                        .join("\n")
                );


                showToast(
                    "All hooks copied"
                );

            } catch {

                showToast(
                    "Copy failed"
                );

            }

        }
    );


    /* =========================================================
       CLOSE PANELS
    ========================================================== */

    aiClose.addEventListener(
        "click",
        () => {

            aiPanel.classList.add(
                "hidden"
            );

        }
    );


    hooksClose.addEventListener(
        "click",
        () => {

            hooksPanel.classList.add(
                "hidden"
            );

        }
    );


    aiPanel.addEventListener(
        "click",
        event => {

            if (
                event.target ===
                aiPanel
            ) {

                aiPanel.classList.add(
                    "hidden"
                );

            }

        }
    );


    hooksPanel.addEventListener(
        "click",
        event => {

            if (
                event.target ===
                hooksPanel
            ) {

                hooksPanel.classList.add(
                    "hidden"
                );

            }

        }
    );


    /* =========================================================
       NAVIGATION (Visit AdVault / Upgrade to Pro)
    ========================================================== */

    function openAdVaultPage(
        event,
        url
    ) {

        event.preventDefault();

        const isPlaceholder =
            !url ||
            url === "REPLACE_WITH_LANDING_PAGE_URL";

        if (isPlaceholder) {

            showToast(
                "Landing page URL has not been configured yet."
            );

            return;

        }

        chrome.tabs.create({
            url
        });

    }

    if (upgradeProBtn) {

        upgradeProBtn.addEventListener(
            "click",
            event => {

                openAdVaultPage(
                    event,
                    `${ADVAULT_LANDING_URL}#pricing`
                );

            }
        );

    }

    if (visitAdVaultBtn) {

        visitAdVaultBtn.addEventListener(
            "click",
            event => {

                openAdVaultPage(
                    event,
                    ADVAULT_LANDING_URL
                );

            }
        );

    }

    if (usageUpgradeBtn) {

        usageUpgradeBtn.addEventListener(
            "click",
            event => {

                openAdVaultPage(
                    event,
                    `${ADVAULT_LANDING_URL}#pricing`
                );

            }
        );

    }


    /* =========================================================
       HELPERS
    ========================================================== */

    function buildAdText(
        ad
    ) {

        return [

            ad.title,
            ad.text,
            ad.advertiser

        ]
            .filter(Boolean)
            .join("\n");

    }


    function buildTargetDescription(
        ad
    ) {

        const network =
            ad.network ||
            "WEB";


        const type =
            ad.type ||
            "content";


        const title =
            ad.title ||
            "Selected content";


        return `${network} · ${type} · ${title}`;

    }


    function cleanText(
        value
    ) {

        return String(
            value || ""
        )
            .replace(/\s+/g, " ")
            .trim();

    }


    function truncate(
        text,
        maxLength
    ) {

        const value =
            String(
                text || ""
            );


        if (
            value.length <=
            maxLength
        ) {

            return value;

        }


        return (
            value.substring(
                0,
                maxLength
            ) + "..."
        );

    }


    function escapeHtml(
        value
    ) {

        return String(
            value || ""
        )
            .replace(
                /&/g,
                "&amp;"
            )
            .replace(
                /</g,
                "&lt;"
            )
            .replace(
                />/g,
                "&gt;"
            )
            .replace(
                /"/g,
                "&quot;"
            )
            .replace(
                /'/g,
                "&#039;"
            );

    }


    function escapeAttribute(
        value
    ) {

        return escapeHtml(
            value
        );

    }


    // Allow only safe URL schemes in user-controlled href attributes.
    // Anything else (e.g. javascript:, data:) is dropped to "#" to prevent
    // script injection through data scraped from scanned pages.
    function safeUrl(
        value
    ) {

        const url =
            String(
                value || ""
            ).trim();

        return /^(https?:\/\/|mailto:|tel:)/i.test(
            url
        )
            ? url
            : "#";

    }


    /* =========================================================
       TOAST
    ========================================================== */

    let toastTimer = null;


    function showToast(
        message
    ) {

        toast.textContent =
            message;

        toast.classList.remove(
            "hidden"
        );


        clearTimeout(
            toastTimer
        );


        toastTimer =
            setTimeout(
                () => {

                    toast.classList.add(
                        "hidden"
                    );

                },
                1800
            );

    }

})();
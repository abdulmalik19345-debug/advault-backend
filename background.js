// background.js - MV3 service worker.
// Handles extension lifecycle and can route messages if needed.
(() => {
    "use strict";

    // Log install/update events for debugging.
    chrome.runtime.onInstalled.addListener((details) => {
        console.log("[AdVault Spy] Installed:", details.reason);
    });

    // Optional central message router. For now we just forward everything.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.type === "LOG") {
            console.log("[AdVault Spy]", message.payload);
            sendResponse({ ok: true });
            return false;
        }
        return false;
    });
})();

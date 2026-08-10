(() => {
  "use strict";

  /*
   * ADVAULT SPY
   * Universal browser page scanner
   *
   * Goals:
   * - Extract meaningful webpage content
   * - Find likely advertisements
   * - Extract advertiser / CTA / destination / media
   * - Support dynamic websites
   * - Allow manual element selection
   */

  const MAX_ITEMS = 50;

  const COMMERCIAL_WORDS = [
    "shop",
    "buy",
    "order",
    "purchase",
    "get yours",
    "learn more",
    "sign up",
    "subscribe",
    "download",
    "install",
    "try now",
    "start now",
    "book now",
    "reserve",
    "claim",
    "save",
    "discount",
    "sale",
    "offer",
    "deal",
    "limited time",
    "free trial",
    "pricing",
    "checkout",
    "add to cart",
    "get started",
    "join now"
  ];

  const AD_WORDS = [
    "sponsored",
    "sponsored content",
    "advertisement",
    "advertising",
    "promoted",
    "paid partnership",
    "paid promotion",
    "ad"
  ];

  let observer = null;
  let selectionMode = false;
  let highlightElement = null;

  /* =========================================================
     HELPERS
  ========================================================= */

  function cleanText(value, max = 1000) {
    if (!value) return "";

    return String(value)
      .replace(/\s+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim()
      .slice(0, max);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    const style = window.getComputedStyle(el);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();

    return (
      rect.width > 20 &&
      rect.height > 20 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight * 1.5 &&
      rect.left <= window.innerWidth * 1.5
    );
  }

  function getRect(el) {
    const r = el.getBoundingClientRect();

    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  }

  function getElementText(el) {
    if (!el) return "";

    const pieces = [];

    if (el.innerText) {
      pieces.push(el.innerText);
    }

    if (el.getAttribute) {
      pieces.push(el.getAttribute("aria-label") || "");
      pieces.push(el.getAttribute("title") || "");
      pieces.push(el.getAttribute("alt") || "");
    }

    return cleanText(pieces.join(" "), 1500);
  }

  function getImages(container) {
    if (!container) return [];

    const images = Array.from(
      container.querySelectorAll("img")
    );

    return images
      .filter(isVisible)
      .slice(0, 10)
      .map(img => ({
        src: img.currentSrc || img.src || "",
        alt: cleanText(img.alt || "", 300),
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0
      }))
      .filter(img => img.src);
  }

  function getVideos(container) {
    if (!container) return [];

    const videos = Array.from(
      container.querySelectorAll("video")
    );

    return videos
      .filter(isVisible)
      .slice(0, 5)
      .map(video => ({
        src: video.currentSrc || video.src || "",
        poster: video.poster || "",
        width: video.videoWidth || video.width || 0,
        height: video.videoHeight || video.height || 0
      }));
  }

  function getLinks(container) {
    if (!container) return [];

    return Array.from(container.querySelectorAll("a"))
      .filter(a => isVisible(a))
      .slice(0, 30)
      .map(a => ({
        text: cleanText(a.innerText || a.getAttribute("aria-label") || "", 250),
        href: a.href || ""
      }))
      .filter(x => x.text || x.href);
  }

  function getButtons(container) {
    if (!container) return [];

    return Array.from(
      container.querySelectorAll(
        "button, [role='button'], input[type='submit']"
      )
    )
      .filter(isVisible)
      .slice(0, 20)
      .map(button =>
        cleanText(
          button.innerText ||
            button.getAttribute("aria-label") ||
            button.value ||
            "",
          200
        )
      )
      .filter(Boolean);
  }

  function findCTA(text, buttons, links) {
    const source = [
      ...(buttons || []),
      ...(links || []).map(x => x.text),
      text
    ].join(" ");

    const lower = source.toLowerCase();

    for (const word of COMMERCIAL_WORDS) {
      if (lower.includes(word)) {
        return word;
      }
    }

    return "";
  }

  function hasAdLabel(text) {
    const lower = text.toLowerCase();

    return AD_WORDS.some(word => {
      if (word === "ad") {
        return /\bad\b/.test(lower);
      }

      return lower.includes(word);
    });
  }

  function countCommercialSignals(text, buttons, links) {
    const lower = text.toLowerCase();

    let score = 0;

    for (const word of COMMERCIAL_WORDS) {
      if (lower.includes(word)) {
        score += 4;
      }
    }

    for (const button of buttons || []) {
      const b = button.toLowerCase();

      for (const word of COMMERCIAL_WORDS) {
        if (b.includes(word)) {
          score += 8;
        }
      }
    }

    for (const link of links || []) {
      const l = `${link.text} ${link.href}`.toLowerCase();

      for (const word of COMMERCIAL_WORDS) {
        if (l.includes(word)) {
          score += 3;
        }
      }
    }

    return score;
  }

  function getExternalDomains(links) {
    const currentHost = location.hostname;

    return (links || [])
      .map(link => {
        try {
          return new URL(link.href);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(url => url.hostname && url.hostname !== currentHost)
      .map(url => url.hostname)
      .slice(0, 10);
  }

  function detectAdvertiser(container, links) {
    const domain = getExternalDomains(links)[0];

    if (domain) {
      return domain.replace(/^www\./, "");
    }

    const heading =
      container.querySelector("h1, h2, h3, h4, strong");

    if (heading) {
      return cleanText(heading.innerText, 150);
    }

    return "";
  }

  function calculateAdConfidence({
    text,
    buttons,
    links,
    images,
    videos
  }) {
    let score = 0;

    if (hasAdLabel(text)) {
      score += 45;
    }

    score += Math.min(
      countCommercialSignals(text, buttons, links),
      30
    );

    if (images.length > 0) {
      score += 8;
    }

    if (videos.length > 0) {
      score += 8;
    }

    if (links.some(link => {
      try {
        return new URL(link.href).hostname !== location.hostname;
      } catch {
        return false;
      }
    })) {
      score += 8;
    }

    return Math.min(score, 100);
  }

  function getCandidateContainers() {
    const selectors = [
      "article",
      "[role='article']",
      "section",
      "aside",
      "li",
      "figure",
      "div"
    ];

    const all = [];

    selectors.forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (!isVisible(el)) return;

        const rect = el.getBoundingClientRect();

        if (rect.width < 120 || rect.height < 80) return;

        /*
         * Ignore enormous page wrappers.
         */
        if (
          rect.width > window.innerWidth * 0.98 &&
          rect.height > window.innerHeight * 1.5
        ) {
          return;
        }

        all.push(el);
      });
    });

    return all;
  }

  function buildAdCandidate(container, index) {
    const text = getElementText(container);

    if (!text && !container.querySelector("img,video")) {
      return null;
    }

    if (text.length < 5 && !container.querySelector("img,video")) {
      return null;
    }

    const images = getImages(container);
    const videos = getVideos(container);
    const links = getLinks(container);
    const buttons = getButtons(container);

    const confidence = calculateAdConfidence({
      text,
      buttons,
      links,
      images,
      videos
    });

    /*
     * Only consider reasonably strong commercial candidates.
     */
    if (confidence < 25) {
      return null;
    }

    const cta = findCTA(text, buttons, links);

    const destination =
      links.find(link => {
        try {
          return new URL(link.href).hostname !== location.hostname;
        } catch {
          return false;
        }
      })?.href ||
      links[0]?.href ||
      "";

    return {
      id: `ad-${Date.now()}-${index}`,

      title:
        cleanText(
          container.querySelector(
            "h1,h2,h3,h4,strong,[role='heading']"
          )?.innerText || "",
          150
        ) || "Detected Creative",

      advertiser: detectAdvertiser(container, links),

      text,

      cta,

      destination,

      images,

      videos,

      confidence,

      adLabel: hasAdLabel(text),

      type: videos.length
        ? "video"
        : images.length
        ? "image"
        : "text",

      rect: getRect(container),

      source: location.hostname
    };
  }

  /* =========================================================
     AD SCANNING
  ========================================================= */

  function scanAds() {
    const candidates = getCandidateContainers();

    const results = [];

    const seen = new Set();

    candidates.forEach((container, index) => {
      const candidate = buildAdCandidate(container, index);

      if (!candidate) return;

      /*
       * Avoid nested duplicate cards.
       */
      const key = [
        candidate.advertiser,
        candidate.text.slice(0, 180),
        candidate.destination
      ].join("|");

      if (seen.has(key)) return;

      seen.add(key);

      results.push(candidate);
    });

    /*
     * Strongest candidates first.
     */
    results.sort(
      (a, b) => b.confidence - a.confidence
    );

    return results.slice(0, MAX_ITEMS);
  }

  /* =========================================================
     PAGE SCRAPER
  ========================================================= */

  function scrapePage() {
    const bodyText = cleanText(
      document.body?.innerText || "",
      12000
    );

    const headings = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6")
    )
      .filter(isVisible)
      .map(el => cleanText(el.innerText, 300))
      .filter(Boolean)
      .slice(0, 100);

    const paragraphs = Array.from(
      document.querySelectorAll("p")
    )
      .filter(isVisible)
      .map(el => cleanText(el.innerText, 600))
      .filter(text => text.length > 20)
      .slice(0, 100);

    const links = getLinks(document.body);

    const images = getImages(document.body);

    const videos = getVideos(document.body);

    const buttons = getButtons(document.body);

    const metadata = {};

    document
      .querySelectorAll(
        "meta[name],meta[property]"
      )
      .forEach(meta => {
        const key =
          meta.getAttribute("name") ||
          meta.getAttribute("property");

        const value =
          meta.getAttribute("content");

        if (key && value) {
          metadata[key] = cleanText(value, 500);
        }
      });

    let structuredData = [];

    document
      .querySelectorAll(
        'script[type="application/ld+json"]'
      )
      .forEach(script => {
        try {
          structuredData.push(
            JSON.parse(script.textContent)
          );
        } catch {
          // Ignore invalid JSON-LD.
        }
      });

    return {
      url: location.href,
      domain: location.hostname,
      title: document.title,

      description:
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") || "",

      headings,

      paragraphs,

      text: bodyText,

      links,

      images,

      videos,

      buttons,

      metadata,

      structuredData
    };
  }

  /* =========================================================
     SELECT ANYTHING
  ========================================================= */

  function removeHighlight() {
    if (!highlightElement) return;

    highlightElement.style.outline =
      highlightElement.dataset.advaultOldOutline || "";

    highlightElement.style.cursor =
      highlightElement.dataset.advaultOldCursor || "";

    delete highlightElement.dataset.advaultOldOutline;
    delete highlightElement.dataset.advaultOldCursor;

    highlightElement = null;
  }

  function highlight(el) {
    if (highlightElement === el) return;

    removeHighlight();

    highlightElement = el;

    el.dataset.advaultOldOutline =
      el.style.outline || "";

    el.dataset.advaultOldCursor =
      el.style.cursor || "";

    el.style.outline =
      "3px solid #8b5cf6";

    el.style.cursor = "crosshair";
  }

  function startSelectionMode() {
    if (selectionMode) return;

    selectionMode = true;

    document.body.style.cursor = "crosshair";

    document.addEventListener(
      "mouseover",
      handleMouseOver,
      true
    );

    document.addEventListener(
      "click",
      handleSelectionClick,
      true
    );
  }

  function stopSelectionMode() {
    selectionMode = false;

    document.body.style.cursor = "";

    document.removeEventListener(
      "mouseover",
      handleMouseOver,
      true
    );

    document.removeEventListener(
      "click",
      handleSelectionClick,
      true
    );

    removeHighlight();
  }

  function handleMouseOver(event) {
    if (!selectionMode) return;

    const target = event.target;

    if (!(target instanceof Element)) return;

    highlight(target);
  }

  function handleSelectionClick(event) {
    if (!selectionMode) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const target = event.target;

    if (!(target instanceof Element)) {
      stopSelectionMode();
      return;
    }

    const text = getElementText(target);
    const images = getImages(target);
    const videos = getVideos(target);
    const links = getLinks(target);
    const buttons = getButtons(target);

    const result = {
      id: `selected-${Date.now()}`,

      title:
        cleanText(
          target.querySelector(
            "h1,h2,h3,h4,strong,[role='heading']"
          )?.innerText || "",
          150
        ) || "Selected Content",

      advertiser:
        detectAdvertiser(target, links),

      text,

      cta:
        findCTA(
          text,
          buttons,
          links
        ),

      destination:
        links[0]?.href || "",

      images,

      videos,

      confidence:
        calculateAdConfidence({
          text,
          buttons,
          links,
          images,
          videos
        }),

      type:
        videos.length
          ? "video"
          : images.length
          ? "image"
          : "text",

      rect: getRect(target),

      source: location.hostname
    };

    stopSelectionMode();

    chrome.runtime.sendMessage({
      type: "SELECTED_ELEMENT",
      item: result
    });
  }

  /* =========================================================
     MUTATION OBSERVER
  ========================================================= */

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver(() => {
      chrome.runtime.sendMessage({
        type: "PAGE_CHANGED"
      }).catch(() => {});
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }


  /* =========================================================
     PROSPECT EXTRACTION
     Finds public business entities on the current scanned page.
     This is intentionally separate from ad detection.
  ========================================================= */

  function extractProspects() {
    const results = [];
    const seen = new Set();

    const blockedNames = new Set([
      "directions", "website", "call", "share", "save", "more",
      "reviews", "photos", "menu", "order online", "book online"
    ]);

    function normalizeKey(value) {
      return cleanText(value || "", 180)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    }

    function looksLikeBusinessName(name) {
      const n = normalizeKey(name);
      if (!n || n.length < 2 || n.length > 140) return false;
      if (blockedNames.has(n)) return false;
      if (/^(search|google maps|map|results?|filters?|sort by|near me)$/i.test(n)) return false;
      return true;
    }

    function parseRating(text) {
      const m = String(text || "").match(/(?:^|\s)([1-5](?:\.[0-9])?)(?:\s*★|\s*stars?|\s*$)/i);
      return m ? Number(m[1]) : null;
    }

    function parseReviewCount(text) {
      const m = String(text || "").match(/([\d,.]+)\s*(?:reviews?|ratings?)/i);
      if (!m) return null;
      return Number(m[1].replace(/[,.]/g, "")) || null;
    }

    function parsePhone(text) {
      const m = String(text || "").match(/(?:\+?\d[\d\s().-]{7,}\d)/);
      return m ? cleanText(m[0], 80) : "";
    }

    function getExternalWebsite(root) {
      const links = Array.from(root?.querySelectorAll?.("a[href]") || []);
      return links.find(a => {
        if (!/^https?:/i.test(a.href)) return false;
        try {
          const u = new URL(a.href);
          return !/google\.[^/]+$/i.test(u.hostname) &&
                 !/google\.[^/]+\/maps/i.test(a.href) &&
                 !/maps\.google\./i.test(a.href);
        } catch (_) {
          return false;
        }
      })?.href || "";
    }

    function add(item) {
      const name = cleanText(item.name || "", 180);
      if (!looksLikeBusinessName(name)) return;

      const website = item.website || "";
      const url = item.url || location.href;
      const key = normalizeKey(website) || normalizeKey(name) + "|" + normalizeKey(item.address || "");

      if (seen.has(key)) return;
      seen.add(key);

      results.push({
        id: `prospect-${results.length}-${Date.now()}`,
        name,
        category: cleanText(item.category || "", 120),
        address: cleanText(item.address || "", 260),
        phone: cleanText(item.phone || "", 80),
        email: cleanText(item.email || "", 140),
        website,
        url,
        source: location.href,
        pageTitle: cleanText(document.title, 180),
        rating: Number.isFinite(item.rating) ? item.rating : null,
        reviewCount: Number.isFinite(item.reviewCount) ? item.reviewCount : null,
        signals: Array.isArray(item.signals) ? [...new Set(item.signals)] : []
      });
    }

    // 1. Structured business data.
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const parsed = JSON.parse(script.textContent);
        const nodes = Array.isArray(parsed)
          ? parsed
          : (parsed && Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);

        nodes.forEach(node => {
          if (!node || typeof node !== "object") return;
          const type = Array.isArray(node["@type"])
            ? node["@type"].join(",")
            : String(node["@type"] || "");

          if (!/localbusiness|restaurant|store|professionalservice|organization|business/i.test(type)) return;

          const same = Array.isArray(node.sameAs) ? node.sameAs[0] : node.sameAs;
          const address = typeof node.address === "string"
            ? node.address
            : [
                node.address?.streetAddress,
                node.address?.addressLocality,
                node.address?.addressRegion
              ].filter(Boolean).join(", ");

          add({
            name: node.name,
            category: type,
            address,
            phone: node.telephone,
            email: node.email,
            website: node.url || "",
            url: node.url || same || location.href,
            rating: Number(node.aggregateRating?.ratingValue) || null,
            reviewCount: Number(node.aggregateRating?.reviewCount) || null,
            signals: ["structured business data"]
          });
        });
      } catch (_) {}
    });

    // 2. Google Maps result cards. Prefer the result feed/card structure over
    // generic closest("div"), which can accidentally capture the whole page.
    const mapsCandidates = Array.from(document.querySelectorAll(
      '[role="feed"] [role="article"], [role="feed"] > div, [data-result-index]'
    )).filter(isVisible).slice(0, 120);

    mapsCandidates.forEach(card => {
      const links = Array.from(card.querySelectorAll("a[href]"));
      const placeLink = links.find(a => /\/maps\/place\//i.test(a.href));

      const heading =
        card.querySelector('[role="heading"]') ||
        card.querySelector("h1,h2,h3,h4,h5,h6") ||
        placeLink;

      const name = cleanText(
        heading?.getAttribute?.("aria-label") ||
        heading?.innerText ||
        placeLink?.getAttribute?.("aria-label") ||
        "",
        180
      );

      if (!looksLikeBusinessName(name)) return;

      const text = cleanText(card.innerText || "", 1400);
      const external = getExternalWebsite(card);

      add({
        name,
        address: text,
        phone: parsePhone(text),
        website: external,
        url: placeLink?.href || location.href,
        rating: parseRating(text),
        reviewCount: parseReviewCount(text),
        signals: ["Google Maps business listing"]
      });
    });

    // 3. Fallback for Maps layouts where result cards don't expose
    // [role="article"]. Only use place links and their nearest bounded container.
    if (!results.length) {
      const placeLinks = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'))
        .filter(isVisible)
        .slice(0, 120);

      placeLinks.forEach(a => {
        const name = cleanText(
          a.getAttribute("aria-label") ||
          a.querySelector('[role="heading"]')?.textContent ||
          a.innerText ||
          "",
          180
        );

        if (!looksLikeBusinessName(name)) return;

        let card = a.closest('[data-result-index], [role="article"]');
        if (!card) {
          let parent = a.parentElement;
          for (let i = 0; i < 5 && parent; i++, parent = parent.parentElement) {
            const text = cleanText(parent.innerText || "", 1400);
            if (text.length >= 20 && text.length <= 2200) {
              card = parent;
              break;
            }
          }
        }

        const text = cleanText(card?.innerText || a.innerText || "", 1400);
        add({
          name,
          address: text,
          phone: parsePhone(text),
          website: getExternalWebsite(card),
          url: a.href,
          rating: parseRating(text),
          reviewCount: parseReviewCount(text),
          signals: ["Google Maps place link"]
        });
      });
    }

    // 4. Generic public business/directory cards.
    const cards = Array.from(document.querySelectorAll(
      'article, [role="article"], [itemtype*="LocalBusiness"], [itemtype*="Organization"], .business-card, .listing, .result'
    )).filter(isVisible).slice(0, 150);

    cards.forEach(card => {
      const heading =
        card.querySelector("h1,h2,h3,h4,h5,h6,[role='heading'],[itemprop='name'],strong");

      const name = cleanText(heading?.innerText || heading?.textContent || "", 180);
      if (!looksLikeBusinessName(name)) return;

      const links = Array.from(card.querySelectorAll("a[href]"));
      const website = getExternalWebsite(card);
      const text = cleanText(card.innerText || "", 1200);

      add({
        name,
        category: cleanText(
          card.querySelector("[itemprop='category'], .category, .business-category")?.textContent || "",
          120
        ),
        address: cleanText(
          card.querySelector("[itemprop='address'], address, .address")?.textContent || text,
          260
        ),
        phone: parsePhone(text),
        website,
        url: links[0]?.href || location.href,
        rating: parseRating(text),
        reviewCount: parseReviewCount(text),
        signals: ["public business listing"]
      });
    });

    return results.slice(0, 100);
  }

  /* =========================================================
     MESSAGE HANDLER
  ========================================================= */

  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {

      if (message.type === "PING") {
        sendResponse({
          ok: true
        });

        return;
      }

      if (message.type === "SCAN_ADS") {
        try {
          const ads = scanAds();

          sendResponse({
            ok: true,
            ads
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error.message
          });
        }

        return true;
      }

      if (message.type === "SCRAPE_PAGE") {
        try {
          const data = scrapePage();

          sendResponse({
            ok: true,
            data
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error.message
          });
        }

        return true;
      }

      if (message.type === "EXTRACT_PROSPECTS_FROM_SCAN") {
        try {
          const prospects = extractProspects();
          sendResponse({
            ok: true,
            prospects,
            page: {
              url: location.href,
              title: document.title
            }
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error.message
          });
        }

        return true;
      }

      if (message.type === "SELECT_ANYTHING") {
        startSelectionMode();

        sendResponse({
          ok: true
        });

        return true;
      }

      if (message.type === "STOP_SELECTION") {
        stopSelectionMode();

        sendResponse({
          ok: true
        });

        return true;
      }
    }
  );

  /* =========================================================
     INITIALIZE
  ========================================================= */

  if (document.body) {
    startObserver();
  } else {
    window.addEventListener(
      "DOMContentLoaded",
      startObserver,
      { once: true }
    );
  }

})();
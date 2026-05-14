#!/usr/bin/env node
// Phase 14B mobile polish: about overlay + doc cards on a 390x844
// mobile viewport (iPhone 14 Pro size). Verifies:
//
//   - landing exposes the About button before any auth
//   - About button has a 44px+ tap target on mobile
//   - no horizontal overflow on the document at 390px wide
//   - clicking About opens the overlay
//   - overlay has 3 doc cards (how sudo works / trust model / privacy)
//      each with a title, a description, and an arrow
//   - close button is at least 40px tall + visible
//   - clicking a doc card navigates to the rendered HTML doc with the
//     sudo doc-shell, no raw markdown leaks
//   - zero CSP violations during the run
//
// Wired up as `npm run smoke:about-mobile`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first.\n" + e.message); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => console.log("ok:", label);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const cspViolations = [];
  await page.evaluateOnNewDocument(() => {
    /** @type {{ event: string; blockedURI: string; violatedDirective: string }[]} */
    const sink = [];
    Object.defineProperty(window, "__smokeCspViolations", { value: sink, writable: false });
    document.addEventListener("securitypolicyviolation", (e) => {
      sink.push({ event: "violation", blockedURI: e.blockedURI, violatedDirective: e.violatedDirective });
    });
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // 1. About button present pre-auth, with mobile tap target.
  const aboutMeta = await page.evaluate(() => {
    const btn = document.querySelector("[data-auth-action=\"about\"]");
    if (!(btn instanceof HTMLElement)) return null;
    const rect = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    return {
      visible: rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden",
      heightPx: rect.height,
      tag: btn.tagName,
      tabIndex: btn.tabIndex,
      text: (btn.textContent || "").trim()
    };
  });
  if (aboutMeta === null) { fail("1.about-present", "no [data-auth-action=about] element on landing"); }
  else if (!aboutMeta.visible) fail("1.about-visible", `about not visible: ${JSON.stringify(aboutMeta)}`);
  else if (aboutMeta.heightPx < 40) fail("1.about-tap", `about tap target only ${aboutMeta.heightPx}px (mobile min 44)`);
  else if (aboutMeta.text !== "about") fail("1.about-text", `about text was '${aboutMeta.text}'`);
  else ok(`1. about button visible (${aboutMeta.heightPx.toFixed(0)}px tall) before auth`);

  // 2. No horizontal overflow at 390px viewport.
  const overflow = await page.evaluate(() => {
    return {
      htmlScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth
    };
  });
  if (overflow.htmlScrollWidth > overflow.innerWidth + 1 || overflow.bodyScrollWidth > overflow.innerWidth + 1) {
    fail("2.overflow", `horizontal overflow at 390px: html=${overflow.htmlScrollWidth} body=${overflow.bodyScrollWidth}`);
  } else {
    ok(`2. no horizontal overflow at 390px (html=${overflow.htmlScrollWidth}, body=${overflow.bodyScrollWidth})`);
  }

  // 3. Click About → overlay opens.
  await page.evaluate(() => {
    const btn = document.querySelector("[data-auth-action=\"about\"]");
    if (btn instanceof HTMLElement) btn.click();
  });
  const opened = await page.waitForFunction(() => document.getElementById("about-overlay")?.open === true, { timeout: 4000 }).then(() => true, () => false);
  if (!opened) { fail("3.open", "about overlay did not open within 4s"); }
  else ok(`3. about overlay opens on click`);

  // 4. Doc cards present with title + desc + arrow.
  const cardInfo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".about-overlay__docs .doc-card")];
    return cards.map((c) => ({
      href: c.getAttribute("href"),
      title: c.querySelector(".doc-card__title")?.textContent?.trim() ?? "",
      desc: c.querySelector(".doc-card__desc")?.textContent?.trim() ?? "",
      hasArrow: c.querySelector(".doc-card__arrow") !== null
    }));
  });
  if (cardInfo.length !== 3) fail("4.card-count", `expected 3 doc cards, got ${cardInfo.length}`);
  else {
    const expectedHrefs = ["/docs/HOW_SUDO_WORKS.md", "/docs/TRUST_MODEL.md", "/docs/PRIVACY.md"];
    const allOk = cardInfo.every((c, idx) => {
      return c.href === expectedHrefs[idx] && c.title.length > 0 && c.desc.length > 0 && c.hasArrow;
    });
    if (!allOk) fail("4.card-shape", `card shape mismatch: ${JSON.stringify(cardInfo)}`);
    else ok(`4. about overlay has 3 doc cards with title/desc/arrow + correct hrefs`);
  }

  // 5. Close button has mobile-friendly tap target.
  const closeMeta = await page.evaluate(() => {
    const btn = document.getElementById("about-close");
    if (!(btn instanceof HTMLElement)) return null;
    const rect = btn.getBoundingClientRect();
    return { heightPx: rect.height, widthPx: rect.width };
  });
  if (closeMeta === null) fail("5.close-present", "about-close button not found");
  else if (closeMeta.heightPx < 36 || closeMeta.widthPx < 36) fail("5.close-tap", `close tap target ${closeMeta.widthPx}x${closeMeta.heightPx} too small`);
  else ok(`5. close button has ${closeMeta.widthPx.toFixed(0)}x${closeMeta.heightPx.toFixed(0)} tap target`);

  // 6. Overlay content scrolls inside the overlay, not the document.
  const scrollable = await page.evaluate(() => {
    const scroll = document.querySelector(".about-overlay__scroll");
    if (!(scroll instanceof HTMLElement)) return null;
    return {
      hasMoreContentThanViewport: scroll.scrollHeight > scroll.clientHeight,
      overflowY: getComputedStyle(scroll).overflowY
    };
  });
  if (scrollable === null) fail("6.scroll-present", ".about-overlay__scroll element missing");
  else if (scrollable.overflowY !== "auto" && scrollable.overflowY !== "scroll") fail("6.scroll-mode", `expected overflow-y auto/scroll, got ${scrollable.overflowY}`);
  else ok(`6. content scrolls inside overlay (overflow-y=${scrollable.overflowY})`);

  // 7. Navigate to a doc card. The link target opens in the same tab;
  //    we follow the href directly to verify the response shape.
  const r = await fetch(`${BASE}/docs/HOW_SUDO_WORKS.md`);
  const ct = r.headers.get("content-type") ?? "";
  const body = await r.text();
  if (r.status !== 200) fail("7.doc-status", `expected 200, got ${r.status}`);
  else if (!ct.includes("text/html")) fail("7.doc-ct", `expected text/html, got ${ct}`);
  else if (!/<article class="doc-shell"/.test(body)) fail("7.doc-shell", "doc-shell missing");
  else if (!/<h1>How sudo works<\/h1>/.test(body)) fail("7.doc-h1", "h1 not rendered from markdown");
  else if (/^#/m.test(body.split("doc-shell__body")[1] ?? "")) fail("7.doc-raw-md", "raw markdown leaked");
  else ok(`7. doc URL renders as styled HTML shell (no raw markdown)`);

  // 8. Render the doc inside a browser tab to confirm it actually
  //    displays + no CSP violations.
  await page.goto(`${BASE}/docs/HOW_SUDO_WORKS.md`, { waitUntil: "domcontentloaded" });
  const domShape = await page.evaluate(() => {
    return {
      hasShell: document.querySelector("article.doc-shell") !== null,
      hasBackLink: document.querySelector(".doc-shell__nav a") !== null,
      bodyText: document.body.innerText.slice(0, 400),
      h1: document.querySelector("h1")?.textContent ?? "",
      bgColor: getComputedStyle(document.body).backgroundColor
    };
  });
  if (!domShape.hasShell) fail("8.doc-dom-shell", "doc-shell not in DOM after navigation");
  else if (!domShape.hasBackLink) fail("8.doc-dom-back", "back link not in DOM");
  else if (!/sudo/i.test(domShape.h1) || !/works/i.test(domShape.h1)) fail("8.doc-dom-h1", `h1 wrong: '${domShape.h1}'`);
  else ok(`8. doc page renders in browser: h1="${domShape.h1}", bg=${domShape.bgColor}`);

  // 9. CSP violations during this run.
  const violations = await page.evaluate(() => (window.__smokeCspViolations || []).slice());
  if (Array.isArray(violations) && violations.length > 0) {
    fail("9.csp", `CSP violations: ${JSON.stringify(violations)}`);
  } else ok(`9. zero CSP violations across landing + about + doc page`);

  await browser.close();
  if (failures.length > 0) {
    console.error(`ABOUT-MOBILE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ABOUT-MOBILE SMOKE PASSED");
})().catch((err) => {
  console.error("ABOUT-MOBILE SMOKE ERRORED:", err);
  process.exit(1);
});

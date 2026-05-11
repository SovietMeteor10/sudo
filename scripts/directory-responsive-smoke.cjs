#!/usr/bin/env node
// Directory responsive smoke. Verifies the lookup/search rows in
// the left column behave well at narrow desktop widths:
//   - long handles truncate with ellipsis (no row wrap)
//   - follow / unfollow / block buttons swap to + / × glyphs at
//     widths <= 1100px while preserving the full label on title +
//     aria-label
//   - the search input reserves right padding so a browser-native
//     clear icon doesn't overlap the text
//
// Wired up as `npm run smoke:directory-responsive`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function waitFor(page, predicate, timeoutMs = 15000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(predicate)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // Sign up two accounts; use the second's long handle as the
  // directory search target. Truncation + button glyphs are tested
  // against that row.
  const ctxTarget = await browser.createBrowserContext();
  const pageTarget = await ctxTarget.newPage();
  await pageTarget.setViewport({ width: 1024, height: 820 });
  pageTarget.on("pageerror", (err) => console.log("TARGET-ERR>", err.message));
  await pageTarget.goto(BASE + "/", { waitUntil: "networkidle0" });
  // 32-char handle so truncation actually fires at the column's
  // available width (otherwise a 16-char handle fits without overflow).
  const targetHandle = `dirtargetwithlonghandle${Date.now().toString().slice(-9)}`.slice(0, 32);
  await pageTarget.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageTarget.type("#signup-handle", targetHandle);
  await pageTarget.type("#signup-password", PASSPHRASE);
  await pageTarget.type("#signup-password-confirm", PASSPHRASE);
  await pageTarget.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageTarget, () => document.body.dataset.authState === "signed-in")) {
    fail("0.target-signup", "target signup failed"); throw new Error();
  }
  ok(`0. target account created @${targetHandle}`);

  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  // Start at a narrow-desktop viewport (just above mobile, below
  // 1100px) so the compact-mode CSS is active.
  await pageA.setViewport({ width: 1000, height: 800 });
  pageA.on("pageerror", (err) => console.log("PAGEA-ERR>", err.message));
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handle = `dir${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handle);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "did not sign in"); throw new Error();
  }
  ok(`1. searcher account @${handle} (viewport 1000x800, compact mode active)`);

  // ===== Search input has right-side padding for native clear icon =====
  const inputPadRight = await pageA.evaluate(() => {
    const el = document.getElementById("lookup-input");
    if (el === null) return null;
    const cs = window.getComputedStyle(el);
    return Number.parseFloat(cs.paddingRight);
  });
  if (inputPadRight === null || inputPadRight < 16) {
    fail("2.input-padding", `lookup-input right-padding should reserve room for clear icon, got ${inputPadRight}`);
  } else {
    ok(`2. lookup-input reserves ${inputPadRight}px right-padding for native clear icon`);
  }

  // ===== Resolve the long-handle target via search =====
  await pageA.click("#lookup-input");
  await pageA.type("#lookup-input", `@${targetHandle}`);
  // Pressing Enter submits the lookup form, which resolves the
  // identity into `#lookup-result .lookup-card` (the resolved view
  // the spec targets). Typing alone would only populate the live
  // `#search-results` rows.
  await pageA.keyboard.press("Enter");
  if (!await waitFor(pageA, () => {
    const card = document.querySelector("#lookup-result .lookup-card");
    return card !== null && !card.classList.contains("lookup-card--error");
  }, 15000)) {
    fail("3.lookup-resolve", "lookup did not resolve the long-handle target"); throw new Error();
  }
  ok(`3. lookup resolved the long-handle target into a .lookup-card`);

  // ===== Handle truncates, full handle survives on title/aria =====
  const cardLayout = await pageA.evaluate(() => {
    const card = document.querySelector("#lookup-result .lookup-card");
    if (card === null) return null;
    const handleEl = card.querySelector(".lookup-card__handle");
    if (handleEl === null) return null;
    const followBtn = card.querySelector('[data-relationship-action="set-subscribe"]');
    return {
      handleText: (handleEl.textContent ?? "").trim(),
      handleClient: handleEl.clientWidth,
      handleScroll: handleEl.scrollWidth,
      hasFollowBtn: followBtn !== null,
      followTitle: followBtn?.getAttribute("title") ?? "",
      followAria: followBtn?.getAttribute("aria-label") ?? "",
      followComputedBefore: followBtn ? window.getComputedStyle(followBtn, "::before").content : "",
      // Visible text node count of the button (compact mode wraps
      // the label in a `.lookup-card__button-text` span and hides
      // it via display:none).
      followInnerTextVisible: followBtn ? (followBtn.offsetWidth > 0 && Array.from(followBtn.querySelectorAll(".lookup-card__button-text")).every((el) => window.getComputedStyle(el).display === "none")) : false
    };
  });
  if (!cardLayout) { fail("4.card-read", "could not read .lookup-card"); throw new Error(); }

  if (!cardLayout.handleText.includes(targetHandle)) {
    fail("4a.handle-text", `handle text missing the target handle: '${cardLayout.handleText}'`);
  } else {
    ok(`4a. handle textContent contains '${targetHandle}'`);
  }
  // The handle is long enough relative to column width that we
  // expect truncation in compact mode.
  if (cardLayout.handleScroll <= cardLayout.handleClient + 1) {
    fail("4b.handle-truncation", `expected handle truncation: scrollWidth=${cardLayout.handleScroll} clientWidth=${cardLayout.handleClient}`);
  } else {
    ok(`4b. long handle truncates (scrollWidth=${cardLayout.handleScroll}, clientWidth=${cardLayout.handleClient})`);
  }

  if (!cardLayout.hasFollowBtn) {
    fail("5.follow-btn", "no follow button found on the lookup card");
  } else {
    if (cardLayout.followTitle !== "follow") fail("5a.title", `expected title='follow', got '${cardLayout.followTitle}'`);
    else ok(`5a. follow button title='follow' preserved for screen-reader/hover`);
    if (cardLayout.followAria !== "follow") fail("5b.aria", `expected aria-label='follow', got '${cardLayout.followAria}'`);
    else ok(`5b. follow button aria-label='follow' preserved`);
    // The pseudo-element ::before content is the source of the
    // compact glyph. getComputedStyle returns it quoted (e.g. '"+"'
    // in CSS). We tolerate both quote-stripped and raw values.
    const stripped = cardLayout.followComputedBefore.replace(/^['"]|['"]$/g, "");
    if (stripped !== "+") {
      fail("5c.compact-glyph", `expected '+' glyph at compact width, got '${cardLayout.followComputedBefore}'`);
    } else {
      ok(`5c. follow button shows '+' glyph at compact width`);
    }
    if (!cardLayout.followInnerTextVisible) {
      fail("5d.text-hidden", "expected .lookup-card__button-text span to be display:none in compact mode");
    } else {
      ok(`5d. full button label hidden under compact CSS`);
    }
  }

  // ===== Wider viewport restores the full text label =====
  await pageA.setViewport({ width: 1280, height: 800 });
  await new Promise((r) => setTimeout(r, 250));
  const wideLayout = await pageA.evaluate(() => {
    const card = document.querySelector("#lookup-result .lookup-card");
    const followBtn = card?.querySelector('[data-relationship-action="set-subscribe"]');
    if (!followBtn) return null;
    const inner = followBtn.querySelector(".lookup-card__button-text");
    return {
      computedBefore: window.getComputedStyle(followBtn, "::before").content,
      innerVisible: inner instanceof HTMLElement && window.getComputedStyle(inner).display !== "none",
      innerText: inner ? (inner.textContent ?? "").trim() : ""
    };
  });
  if (!wideLayout) { fail("6.wide-read", "could not read wide layout"); }
  else {
    // At 1280px the compact media query (max-width: 1100px) is OFF,
    // so the pseudo-element should be `none` (no content) and the
    // text span should be visible.
    if (!wideLayout.innerVisible || wideLayout.innerText !== "follow") {
      fail("6.wide-label", `expected visible 'follow' text at wide width, got '${wideLayout.innerText}' visible=${wideLayout.innerVisible}`);
    } else {
      ok(`6. wide viewport restores the full 'follow' text label`);
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nDIRECTORY-RESPONSIVE SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nDIRECTORY-RESPONSIVE SMOKE PASSED");
})().catch((error) => { console.error("DIRECTORY-RESPONSIVE SMOKE ERROR", error); process.exit(2); });

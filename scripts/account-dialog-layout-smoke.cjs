#!/usr/bin/env node
// Account dialog layout smoke. Verifies the handle + fingerprint
// header sits inline (not stacked over the dialog title), long
// handles truncate visually but expose the full handle via title/
// aria-label, and the bio textarea remains full-width.
//
// Wired up as `npm run smoke:account-dialog-layout`.

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

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (err) => console.log("PAGE-ERR>", err.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // Use a long handle (close to the maxlength of 32) to exercise
  // truncation. 16ch is the CSS cap; "longhandle1234567" (17 chars)
  // is long enough that ellipsis must appear.
  const handle = `longhandle${Date.now().toString().slice(-7)}`;
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "did not sign in"); throw new Error();
  }
  ok(`1. signed up @${handle} (long handle)`);

  // Open the account dialog.
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-account")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("account-dialog")?.open === true, 5000)) {
    fail("2.dialog", "account dialog did not open"); throw new Error();
  }
  ok(`2. account dialog opened`);

  // ===== Title sits above an inline handle + fingerprint row =====
  const layout = await page.evaluate(() => {
    const title = document.getElementById("account-title");
    const card = document.querySelector(".account-card");
    const header = document.querySelector(".account-card__header");
    const handleEl = document.getElementById("account-card-handle");
    const fpEl = document.getElementById("account-card-fingerprint-grid");
    const bioEl = document.getElementById("account-bio");
    if (title === null || card === null || header === null || handleEl === null || fpEl === null || bioEl === null) {
      return { ok: false, reason: "missing element" };
    }
    const titleRect = title.getBoundingClientRect();
    const handleRect = handleEl.getBoundingClientRect();
    const fpRect = fpEl.getBoundingClientRect();
    const bioRect = bioEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    // Fingerprint must be horizontally aligned with handle (same
    // row, give or take a few pixels) AND positioned to its right.
    const sameRow = Math.abs(handleRect.top - fpRect.top) < 14;
    const fpRightOfHandle = fpRect.left >= handleRect.right - 2;
    // Title must be ABOVE the account card.
    const titleAboveCard = titleRect.bottom <= cardRect.top + 4;
    return {
      ok: true,
      sameRow,
      fpRightOfHandle,
      titleAboveCard,
      handleDisplayedText: (handleEl.textContent ?? "").trim(),
      handleTitleAttr: handleEl.getAttribute("title") ?? "",
      handleAriaLabel: handleEl.getAttribute("aria-label") ?? "",
      handleClientWidth: handleEl.clientWidth,
      handleScrollWidth: handleEl.scrollWidth,
      bioFullWidth: bioRect.width >= cardRect.width * 0.9
    };
  });
  if (!layout.ok) { fail("3.layout-read", layout.reason); throw new Error(); }
  if (!layout.titleAboveCard) fail("3a.title-position", "dialog title overlaps the account card");
  else ok(`3a. dialog title sits above the account card`);
  if (!layout.sameRow) fail("3b.inline-row", "fingerprint icon is not on the same row as the handle");
  else ok(`3b. fingerprint icon is inline with the handle`);
  if (!layout.fpRightOfHandle) fail("3c.fp-position", "fingerprint icon is not to the right of the handle");
  else ok(`3c. fingerprint icon is positioned to the right of the handle`);

  // ===== Long handle truncates visually but preserves full value =====
  const fullHandle = `@${handle}`;
  if (layout.handleDisplayedText !== fullHandle) {
    fail("4a.text-content", `handle textContent should be the full handle; got '${layout.handleDisplayedText}'`);
  } else {
    ok(`4a. textContent carries the full handle (${fullHandle.length} chars)`);
  }
  if (layout.handleTitleAttr !== fullHandle) {
    fail("4b.title-attr", `title attribute should be the full handle; got '${layout.handleTitleAttr}'`);
  } else {
    ok(`4b. title attribute carries the full handle`);
  }
  if (layout.handleAriaLabel !== fullHandle) {
    fail("4c.aria-label", `aria-label should be the full handle; got '${layout.handleAriaLabel}'`);
  } else {
    ok(`4c. aria-label carries the full handle`);
  }
  // For a 17+ char handle the CSS cap (16ch) must cause overflow,
  // i.e. scrollWidth > clientWidth (truncation in effect).
  if (fullHandle.length > 17 && layout.handleScrollWidth <= layout.handleClientWidth + 1) {
    fail("4d.truncation", `expected truncation: scrollWidth=${layout.handleScrollWidth} clientWidth=${layout.handleClientWidth}`);
  } else {
    ok(`4d. long handle truncates (scrollWidth=${layout.handleScrollWidth}, clientWidth=${layout.handleClientWidth})`);
  }

  // ===== Bio textarea stays full width =====
  if (!layout.bioFullWidth) {
    fail("5.bio-width", "bio textarea is not full width of the account card");
  } else {
    ok(`5. bio textarea remains full width`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nACCOUNT-DIALOG-LAYOUT SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nACCOUNT-DIALOG-LAYOUT SMOKE PASSED");
})().catch((error) => { console.error("ACCOUNT-DIALOG-LAYOUT SMOKE ERROR", error); process.exit(2); });

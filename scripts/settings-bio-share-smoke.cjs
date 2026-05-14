#!/usr/bin/env node
// Phase 14C: bio editor in account dialog + share-profile button in
// settings. (Previously both lived in settings; consolidated in
// Phase 14C so there's one bio surface and it writes through to the
// public /u/<handle> page.)
//
// Drives the browser through:
//   1. Sign up via the UI.
//   2. Open the account dialog -> verify the bio textarea is present
//      and empty, with the placeholder "say something about yourself".
//   3. Type a bio, click save -> assert the state line shows "saved"
//      and /u/<handle> renders the new bio.
//   4. Open the settings dialog and stub navigator.clipboard.writeText.
//      Click "copy your profile link" -> assert the stub received
//      ${origin}/u/<handle>.
//   5. Re-open the account dialog, clear the textarea, save -> assert
//      the state line shows "bio cleared" and /u/<handle> drops the
//      bio element.
//   6. Reopen the account dialog -> textarea hydrates to empty.
//
// Wired up as `npm run smoke:settings-bio-share`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first.\n" + e.message); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => console.log("ok:", label);

async function waitFor(page, predicate, timeoutMs = 10000, intervalMs = 100, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function openAccount(page) {
  await page.evaluate(() => { document.getElementById("account-button")?.click(); });
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => document.getElementById("account-menu-account")?.click());
  return waitFor(page, () => document.getElementById("account-dialog")?.open === true);
}

async function closeAccount(page) {
  await page.evaluate(() => document.getElementById("account-cancel")?.click());
  await new Promise((r) => setTimeout(r, 200));
}

async function openSettings(page) {
  await page.evaluate(() => { document.getElementById("account-button")?.click(); });
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => document.getElementById("account-menu-settings")?.click());
  return waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
  await page.setViewport({ width: 980, height: 820 });

  // Stub navigator.clipboard.writeText BEFORE the page boots.
  await page.evaluateOnNewDocument(() => {
    /** @type {{ values: string[] }} */
    const capture = { values: [] };
    Object.defineProperty(window, "__smokeClipboard", { value: capture, writable: false });
    const writeText = (text) => {
      capture.values.push(String(text));
      return Promise.resolve();
    };
    if (!("clipboard" in navigator) || typeof navigator.clipboard !== "object") {
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    } else {
      try {
        Object.defineProperty(navigator.clipboard, "writeText", { value: writeText, configurable: true });
      } catch { /* readonly; fall through */ }
    }
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // ---- sign up
  const handle = `bio${Date.now().toString().slice(-7)}`;
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in", 20000)) {
    fail("setup", "signup never reached signed-in");
    await browser.close();
    process.exit(1);
  }
  ok(`1. signed up @${handle}`);

  // ---- open ACCOUNT dialog (where the bio editor lives in 14C)
  if (!await openAccount(page)) {
    fail("2.open-account", "account dialog never opened");
    await browser.close();
    process.exit(1);
  }
  // Wait for the bio to hydrate (fetchIdentityProfile resolves).
  await waitFor(page, () => {
    const ta = document.getElementById("account-bio");
    return ta instanceof HTMLTextAreaElement;
  }, 8000);
  const bioInitial = await page.evaluate(() => {
    const ta = document.getElementById("account-bio");
    const saveBtn = document.getElementById("account-save-bio");
    return {
      present: ta instanceof HTMLTextAreaElement,
      value: ta instanceof HTMLTextAreaElement ? ta.value : null,
      placeholder: ta instanceof HTMLTextAreaElement ? ta.placeholder : null,
      saveBtn: saveBtn instanceof HTMLButtonElement
    };
  });
  if (!bioInitial.present) fail("2a.bio-textarea", "bio textarea missing in account dialog");
  else if (bioInitial.value !== "") fail("2a.bio-initial-empty", `bio textarea not empty for new account: '${bioInitial.value}'`);
  else if (!/say (something|a little) about yourself/i.test(bioInitial.placeholder ?? "")) {
    fail("2a.bio-placeholder", `expected friendly placeholder, got '${bioInitial.placeholder}'`);
  } else if (!bioInitial.saveBtn) fail("2a.bio-save", "save button missing");
  else ok(`2a. account dialog bio editor renders empty with placeholder + save button`);

  // ---- type + save. No apostrophes / angle brackets so the literal
  // includes() check matches the HTML-escaped render verbatim.
  const newBio = "writing here so the world has a simple place to read.";
  await page.evaluate((value) => {
    const ta = document.getElementById("account-bio");
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, newBio);
  await page.evaluate(() => document.getElementById("account-save-bio")?.click());
  const saved = await waitFor(page, () => {
    const state = document.getElementById("account-state")?.textContent ?? "";
    return /saved/i.test(state);
  }, 8000);
  if (!saved) {
    const obs = await page.evaluate(() => document.getElementById("account-state")?.textContent ?? "");
    fail("2c.bio-save-state", `expected "saved" state, got '${obs}'`);
  } else ok(`2c. save flips state to "saved"`);

  const r1 = await fetch(`${BASE}/u/${encodeURIComponent(handle)}`);
  const r1body = await r1.text();
  if (!r1body.includes(newBio)) fail("2d.bio-public", `/u/${handle} does not include the new bio`);
  else if (!/<p class="bio">/.test(r1body)) fail("2d.bio-public-element", `/u/${handle} missing <p class="bio">`);
  else ok(`2d. /u/${handle} renders the new bio`);

  await closeAccount(page);

  // ---- share profile lives in settings now.
  if (!await openSettings(page)) {
    fail("3.open-settings", "settings dialog never opened");
    await browser.close();
    process.exit(1);
  }
  await page.evaluate(() => document.getElementById("settings-share-profile")?.click());
  const stateAfterShare = await waitFor(page, () => {
    const state = document.getElementById("settings-state")?.textContent ?? "";
    return /profile link copied/i.test(state);
  }, 3000);
  const captured = await page.evaluate(() => {
    const cap = window.__smokeClipboard;
    return cap ? cap.values : [];
  });
  if (!stateAfterShare) {
    const obs = await page.evaluate(() => document.getElementById("settings-state")?.textContent ?? "");
    fail("3a.share-state", `expected "profile link copied" state, got '${obs}'`);
  } else ok(`3a. share button surfaces "profile link copied"`);
  const expectedUrl = `${BASE}/u/${encodeURIComponent(handle)}`;
  if (!Array.isArray(captured) || captured.length === 0) {
    fail("3b.share-clipboard", `clipboard stub captured nothing`);
  } else if (!captured.some((v) => v === expectedUrl)) {
    fail("3b.share-clipboard-value", `clipboard captured ${JSON.stringify(captured)}, expected ${expectedUrl}`);
  } else {
    ok(`3b. share button wrote ${expectedUrl} to clipboard`);
  }
  await page.evaluate(() => document.getElementById("settings-cancel")?.click());
  await new Promise((r) => setTimeout(r, 120));

  // ---- clear bio: open account, empty the textarea, save.
  if (!await openAccount(page)) { fail("4.reopen-account", "account dialog never reopened"); }
  await waitFor(page, (expected) => {
    const ta = document.getElementById("account-bio");
    return ta instanceof HTMLTextAreaElement && ta.value === expected;
  }, 8000, 100, newBio);
  await page.evaluate(() => {
    const ta = document.getElementById("account-bio");
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.evaluate(() => document.getElementById("account-save-bio")?.click());
  const cleared = await waitFor(page, () => {
    const state = document.getElementById("account-state")?.textContent ?? "";
    return /cleared/i.test(state);
  }, 8000);
  if (!cleared) {
    const obs = await page.evaluate(() => document.getElementById("account-state")?.textContent ?? "");
    fail("4a.bio-clear-state", `expected "bio cleared" state, got '${obs}'`);
  } else ok(`4a. clear (save with empty textarea) flips state to "bio cleared"`);

  const r2 = await fetch(`${BASE}/u/${encodeURIComponent(handle)}`);
  const r2body = await r2.text();
  if (/<p class="bio[^>]*>/.test(r2body)) fail("4b.bio-cleared-public", `bio element still rendered on /u/${handle} after clear`);
  else if (/no bio yet/i.test(r2body)) fail("4b.no-placeholder", `"no bio yet" placeholder reappeared`);
  else ok(`4b. /u/${handle} omits bio element after clear`);

  await closeAccount(page);

  // ---- reopen account, confirm hydration is empty.
  if (!await openAccount(page)) fail("5.reopen-after-clear", "account dialog never reopened after clear");
  await waitFor(page, () => {
    const ta = document.getElementById("account-bio");
    return ta instanceof HTMLTextAreaElement;
  }, 8000);
  // Allow a beat for the fetch to land.
  await new Promise((r) => setTimeout(r, 800));
  const rehydrated = await page.evaluate(() => {
    const ta = document.getElementById("account-bio");
    return ta instanceof HTMLTextAreaElement ? ta.value : null;
  });
  if (rehydrated !== "") fail("5.rehydrate", `expected empty bio after reopen, got '${rehydrated}'`);
  else ok(`5. reopen of account re-hydrates to empty bio`);

  const cspViolations = await page.evaluate(() => (window.__smokeCspViolations || []).slice());
  if (Array.isArray(cspViolations) && cspViolations.length > 0) {
    fail("6.csp", `securitypolicyviolation events: ${cspViolations.length}`);
  } else ok(`6. no CSP violations across account + settings flows`);

  await browser.close();
  if (failures.length > 0) {
    console.error(`SETTINGS-BIO-SHARE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("SETTINGS-BIO-SHARE SMOKE PASSED");
})().catch((err) => {
  console.error("SETTINGS-BIO-SHARE SMOKE ERRORED:", err);
  process.exit(1);
});

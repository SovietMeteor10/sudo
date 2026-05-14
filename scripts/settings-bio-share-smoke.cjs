#!/usr/bin/env node
// Phase 14B final polish: in-app bio editor + share-profile button.
//
// Drives the browser through:
//   1. Sign up via the UI.
//   2. Open Settings -> verify the bio textarea is present and empty,
//      with the placeholder "say a little about yourself".
//   3. Type a bio, click save -> assert the state line shows "saved"
//      and /u/<handle> renders the new bio.
//   4. Stub navigator.clipboard.writeText on the page, click
//      "copy profile link" -> assert the stub received
//      ${origin}/u/<handle>.
//   5. Clear the bio (clear button) -> assert "bio cleared" and
//      /u/<handle> stops rendering a bio element.
//   6. Reopen Settings -> assert the textarea is empty (re-hydrated).
//   7. Cross-user write rejection is exercised by u-profile-smoke at
//      the API layer; not duplicated here.
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

  // Stub navigator.clipboard.writeText BEFORE the page boots so the
  // share-profile capture is reliable.
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

  // ---- open settings
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
  });
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => document.getElementById("account-menu-settings")?.click());
  if (!await waitFor(page, () => document.getElementById("settings-dialog")?.open === true)) {
    fail("2.open-settings", "settings dialog never opened");
    await browser.close();
    process.exit(1);
  }
  // Wait for hydration to complete (the textarea is briefly disabled).
  await waitFor(page, () => {
    const ta = document.getElementById("settings-bio");
    return ta instanceof HTMLTextAreaElement && !ta.disabled;
  }, 8000);
  const bioInitial = await page.evaluate(() => {
    const ta = document.getElementById("settings-bio");
    return {
      present: ta instanceof HTMLTextAreaElement,
      value: ta instanceof HTMLTextAreaElement ? ta.value : null,
      placeholder: ta instanceof HTMLTextAreaElement ? ta.placeholder : null,
      counter: document.getElementById("settings-bio-counter")?.textContent ?? "",
      saveBtn: document.getElementById("settings-bio-save") instanceof HTMLButtonElement,
      clearBtn: document.getElementById("settings-bio-clear") instanceof HTMLButtonElement,
      shareBtn: document.getElementById("settings-share-profile") instanceof HTMLButtonElement
    };
  });
  if (!bioInitial.present) fail("2a.bio-textarea", "bio textarea missing in settings dialog");
  else if (bioInitial.value !== "") fail("2a.bio-initial-empty", `bio textarea not empty for new account: '${bioInitial.value}'`);
  else if (!/say a little about yourself/i.test(bioInitial.placeholder ?? "")) fail("2a.bio-placeholder", `expected placeholder "say a little about yourself", got '${bioInitial.placeholder}'`);
  else if (!/0 \/ 280/.test(bioInitial.counter)) fail("2a.bio-counter", `expected "0 / 280" counter, got '${bioInitial.counter}'`);
  else if (!bioInitial.saveBtn || !bioInitial.clearBtn || !bioInitial.shareBtn) fail("2a.bio-buttons", "save / clear / share buttons missing");
  else ok(`2a. bio editor renders empty with placeholder + counter + buttons`);

  // ---- type a bio + save. No apostrophes / angle brackets here so
  // the literal includes() check matches the HTML-escaped render
  // verbatim. (escapeHtml turns ' into &#39;, " into &quot;, etc.)
  const newBio = "writing here so the world has a simple place to read.";
  await page.evaluate((value) => {
    const ta = document.getElementById("settings-bio");
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, newBio);
  const counterMid = await page.evaluate(() => document.getElementById("settings-bio-counter")?.textContent ?? "");
  if (!counterMid.startsWith(String(newBio.length))) fail("2b.counter-typing", `counter didn't update with typing: '${counterMid}'`);
  else ok(`2b. counter updates as you type (${counterMid.trim()})`);

  await page.evaluate(() => document.getElementById("settings-bio-save")?.click());
  const saved = await waitFor(page, () => {
    const state = document.getElementById("settings-bio-state")?.textContent ?? "";
    return /saved/i.test(state);
  }, 8000);
  if (!saved) {
    const obs = await page.evaluate(() => document.getElementById("settings-bio-state")?.textContent ?? "");
    fail("2c.bio-save-state", `expected "saved" state, got '${obs}'`);
  } else {
    ok(`2c. save flips state to "saved"`);
  }

  // Verify /u/<handle> reflects the new bio.
  const r1 = await fetch(`${BASE}/u/${encodeURIComponent(handle)}`);
  const r1body = await r1.text();
  if (!r1body.includes(newBio)) fail("2d.bio-public", `/u/${handle} does not include the new bio`);
  else if (!/<p class="bio">/.test(r1body)) fail("2d.bio-public-element", `/u/${handle} missing <p class="bio">`);
  else ok(`2d. /u/${handle} renders the new bio`);

  // ---- share profile
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

  // ---- clear bio
  await page.evaluate(() => document.getElementById("settings-bio-clear")?.click());
  const cleared = await waitFor(page, () => {
    const state = document.getElementById("settings-bio-state")?.textContent ?? "";
    return /cleared/i.test(state);
  }, 8000);
  if (!cleared) {
    const obs = await page.evaluate(() => document.getElementById("settings-bio-state")?.textContent ?? "");
    fail("4a.bio-clear-state", `expected "bio cleared" state, got '${obs}'`);
  } else ok(`4a. clear flips state to "bio cleared"`);

  const r2 = await fetch(`${BASE}/u/${encodeURIComponent(handle)}`);
  const r2body = await r2.text();
  if (/<p class="bio[^>]*>/.test(r2body)) fail("4b.bio-cleared-public", `bio element still rendered on /u/${handle} after clear`);
  else if (/no bio yet/i.test(r2body)) fail("4b.no-placeholder", `"no bio yet" placeholder reappeared`);
  else ok(`4b. /u/${handle} omits bio element after clear`);

  // ---- close + reopen settings, confirm re-hydration sees the
  //      cleared bio (empty value).
  await page.evaluate(() => document.getElementById("settings-cancel")?.click());
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
  });
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => document.getElementById("account-menu-settings")?.click());
  await waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
  await waitFor(page, () => {
    const ta = document.getElementById("settings-bio");
    return ta instanceof HTMLTextAreaElement && !ta.disabled;
  }, 8000);
  const rehydrated = await page.evaluate(() => {
    const ta = document.getElementById("settings-bio");
    return ta instanceof HTMLTextAreaElement ? ta.value : null;
  });
  if (rehydrated !== "") fail("5.rehydrate", `expected empty bio after reopen, got '${rehydrated}'`);
  else ok(`5. reopen of settings re-hydrates to empty bio`);

  // CSP / console error check.
  const cspViolations = await page.evaluate(() => {
    return (window.__smokeCspViolations || []).slice();
  });
  if (Array.isArray(cspViolations) && cspViolations.length > 0) {
    fail("6.csp", `securitypolicyviolation events: ${cspViolations.length}`);
  }

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

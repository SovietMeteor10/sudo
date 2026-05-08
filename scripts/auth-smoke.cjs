#!/usr/bin/env node
// Browser-level auth-flow smoke. Drives the built portal in headless Chrome
// and refuses to let the dialog stay on "creating account..." or
// "signing in..." indefinitely.
//
// Requires puppeteer-core and a Chrome binary. Both are looked up the same
// way as the manual smokes in /tmp; the script is intentionally NOT wired
// into npm install because the live server doesn't need a browser. See
// docs/SMOKE.md for setup.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 \
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   node scripts/auth-smoke.cjs

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const fail = (msg) => { console.error("FAIL:", msg); process.exitCode = 1; };
const ok = (msg) => console.log("ok:", msg);

async function waitForDialogToSettle(page, dialogId, stateElementId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.evaluate((d, s) => ({
      authState: document.body.dataset.authState,
      dialogOpen: document.getElementById(d)?.open ?? false,
      stateText: document.getElementById(s)?.textContent ?? ""
    }), dialogId, stateElementId);
    if (snapshot.authState === "signed-in") return { kind: "success", snapshot };
    const text = (snapshot.stateText || "").toLowerCase();
    const stillWorking = /creating account|signing in|working\.\.\.|loading/.test(text) || text === "";
    if (snapshot.dialogOpen && !stillWorking && text) return { kind: "error", snapshot };
    if (!snapshot.dialogOpen && snapshot.authState !== "signed-in") return { kind: "error", snapshot };
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalSnap = await page.evaluate((d, s) => ({
    authState: document.body.dataset.authState,
    dialogOpen: document.getElementById(d)?.open ?? false,
    stateText: document.getElementById(s)?.textContent ?? ""
  }), dialogId, stateElementId);
  return { kind: "timeout", snapshot: finalSnap };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });

  const errors = [];
  const failedRequests = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) failedRequests.push(`${r.status()} ${r.url()}`); });

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // -----------------------------------------------------------
  // Test 1: a clean signup must reach signed-in within 15s.
  // -----------------------------------------------------------
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));

  const handle = "smoke" + Date.now().toString().slice(-7);
  const password = "CorrectHorseBatteryStaple9!";
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  await page.click('#signup-form button[type="submit"]');

  const signupResult = await waitForDialogToSettle(page, "signup-dialog", "signup-state", 15000);
  if (signupResult.kind === "timeout") {
    fail(`signup hung at: '${signupResult.snapshot.stateText}' (authState=${signupResult.snapshot.authState})`);
  } else if (signupResult.kind === "error") {
    fail(`signup failed: '${signupResult.snapshot.stateText}'`);
  } else {
    ok(`signup signed in as @${handle}`);
  }

  // -----------------------------------------------------------
  // Test 2: reload preserves the local session OR shows a clear sign-in card.
  // -----------------------------------------------------------
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  const afterReload = await page.evaluate(() => document.body.dataset.authState);
  if (afterReload !== "signed-in" && afterReload !== "menu") {
    fail(`unexpected authState after reload: ${afterReload}`);
  } else {
    ok(`post-reload authState=${afterReload}`);
  }

  // -----------------------------------------------------------
  // Test 3: signing in with an unknown handle resolves to a clear error in <15s.
  // -----------------------------------------------------------
  await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.deleteDatabase("sudo_local_state");
    req.onsuccess = req.onerror = req.onblocked = () => res();
  }));
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));

  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signin-handle", "doesnotexist" + Date.now().toString().slice(-5));
  await page.type("#signin-password", "any-passphrase");
  await page.click("#signin-submit");

  const signinResult = await waitForDialogToSettle(page, "signin-dialog", "signin-state", 15000);
  if (signinResult.kind === "timeout") {
    fail(`signin hung at: '${signinResult.snapshot.stateText}'`);
  } else if (signinResult.kind === "success") {
    fail("signin should not have succeeded for an unknown handle");
  } else {
    if (!/account not found on this device|wrong passphrase|network error|too long|invalid|not found/i.test(signinResult.snapshot.stateText)) {
      fail(`signin error not user-friendly: '${signinResult.snapshot.stateText}'`);
    } else {
      ok(`signin failure clear: '${signinResult.snapshot.stateText}'`);
    }
  }

  if (errors.length > 0) {
    console.log("\nbrowser console errors:");
    for (const message of errors) console.log("  -", message);
  }
  if (failedRequests.length > 0) {
    console.log("\nfailed requests during smoke:");
    for (const message of failedRequests) console.log("  -", message);
  }

  await browser.close();
  if (process.exitCode) console.error("\nAUTH SMOKE FAILED");
  else console.log("\nAUTH SMOKE PASSED");
})().catch((e) => { console.error("AUTH SMOKE ERROR", e); process.exit(2); });

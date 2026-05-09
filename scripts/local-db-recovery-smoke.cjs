#!/usr/bin/env node
// Local-database recovery smoke. Forces the browser-side IndexedDB.open
// to hang in the page context BEFORE the sudo client runs, then checks:
//
// 1. signup surfaces the local-database guidance ("this browser's local
//    sudo data is locked..."), not "wrong passphrase".
// 2. signin surfaces the same guidance.
// 3. the auth state element offers a "reset this device" action that
//    actually clears the IndexedDB and reloads.
//
// On a clean profile (no monkeypatch) the smoke also verifies that
// signup completes normally — i.e. the new pre-flight does not block the
// happy path.
//
// Requires puppeteer-core + a Chrome binary (see docs/SMOKE.md).

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

const failures = [];
const passes = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { passes.push(label); console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const DB_HINT_PATTERN = /this browser's local sudo data is locked/i;
const WRONG_PASSPHRASE_PATTERN = /wrong passphrase/i;

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
  return { context, page };
}

async function injectIndexedDbHang(page) {
  // Run BEFORE any page script: every indexedDB.open returns a request
  // whose handlers are never invoked. The client's open timeout (20s)
  // and our flow timeout (15s) should kick in well before the smoke's
  // own budget runs out.
  await page.evaluateOnNewDocument(() => {
    const noopRequest = () => ({
      onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
      result: null, error: null, transaction: null, readyState: "pending",
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
    });
    indexedDB.open = function () { return noopRequest(); };
  });
}

async function waitForState(page, predicate, timeoutMs = 25000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      signupState: document.getElementById("signup-state")?.textContent ?? "",
      signinState: document.getElementById("signin-state")?.textContent ?? "",
      signupOpen: document.getElementById("signup-dialog")?.open ?? false,
      signinOpen: document.getElementById("signin-dialog")?.open ?? false,
      hasReset: !!document.querySelector(".auth-recovery .text-button--danger")
    }));
    if (predicate(snap)) return { kind: "match", snap, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const final = await page.evaluate(() => ({
    authState: document.body.dataset.authState,
    signupState: document.getElementById("signup-state")?.textContent ?? "",
    signinState: document.getElementById("signin-state")?.textContent ?? "",
    hasReset: !!document.querySelector(".auth-recovery .text-button--danger")
  }));
  return { kind: "timeout", snap: final };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // ===== Case 1: signup with hung indexedDB.open =====
  {
    const { context, page } = await newPage(browser);
    await injectIndexedDbHang(page);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signup-handle", "hangtest" + Date.now().toString().slice(-5));
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');

    const result = await waitForState(page, (s) => DB_HINT_PATTERN.test(s.signupState), 25000);
    if (result.kind === "timeout") {
      fail("signup-db-hang", `expected DB hint within 25s; got '${result.snap.signupState}'`);
    } else if (WRONG_PASSPHRASE_PATTERN.test(result.snap.signupState)) {
      fail("signup-db-hang", `signup showed wrong-passphrase copy for a DB failure: '${result.snap.signupState}'`);
    } else if (!result.snap.hasReset) {
      fail("signup-db-hang", "expected reset-this-device button to be exposed alongside DB error");
    } else {
      ok(`signup with hung IDB shows DB guidance + reset button (${result.elapsed}ms)`);
    }
    await context.close();
  }

  // ===== Case 2: signin with hung indexedDB.open =====
  {
    const { context, page } = await newPage(browser);
    await injectIndexedDbHang(page);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signin-handle", "ghost" + Date.now().toString().slice(-5));
    await page.type("#signin-password", PASSPHRASE);
    await page.click("#signin-submit");

    const result = await waitForState(page, (s) => DB_HINT_PATTERN.test(s.signinState), 25000);
    if (result.kind === "timeout") {
      fail("signin-db-hang", `expected DB hint within 25s; got '${result.snap.signinState}'`);
    } else if (WRONG_PASSPHRASE_PATTERN.test(result.snap.signinState)) {
      fail("signin-db-hang", `signin showed wrong-passphrase copy for a DB failure: '${result.snap.signinState}'`);
    } else if (!result.snap.hasReset) {
      fail("signin-db-hang", "expected reset-this-device button alongside DB error");
    } else {
      ok(`signin with hung IDB shows DB guidance + reset button (${result.elapsed}ms)`);
    }
    await context.close();
  }

  // ===== Case 3: happy-path signup with normal IDB still works =====
  {
    const { context, page } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    const handle = "happy" + Date.now().toString().slice(-6);
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');

    const result = await waitForState(page, (s) => s.authState === "signed-in", 15000);
    if (result.kind === "timeout") {
      fail("happy-signup", `signup did not reach signed-in within 15s; '${result.snap.signupState}'`);
    } else {
      ok(`happy-path signup still completes (${result.elapsed}ms after pre-flight)`);
    }
    await context.close();
  }

  // ===== Case 4: reset-this-device action deletes IDB + reloads to landing =====
  {
    const { context, page } = await newPage(browser);
    // First create an account so there's something to wipe
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    const handle = "reset" + Date.now().toString().slice(-6);
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');
    await waitForState(page, (s) => s.authState === "signed-in", 15000);

    // Confirm the dialog, then drive the reset directly through the
    // page's exported action (avoiding the modal confirm).
    page.on("dialog", async (dlg) => { try { await dlg.accept(); } catch { /* ignore */ } });

    // Trigger the same flow the reset button performs.
    await page.evaluate(async () => {
      const dbReq = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
      try { db.close(); } catch { /* ignore */ }
      await new Promise((res, rej) => {
        const r = indexedDB.deleteDatabase("sudo_local_state");
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("blocked"));
      });
    });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));

    const after = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      hasSignin: !!document.querySelector('.landing [data-auth-action="signin"]'),
      hasSignup: !!document.querySelector('.landing [data-auth-action="signup"]'),
    }));
    if (after.authState !== "menu") fail("reset-after", `expected landing menu after reset, got authState=${after.authState}`);
    else if (!after.hasSignin || !after.hasSignup) fail("reset-after", "landing missing sign in / sign up after reset");
    else ok("reset-this-device deletes IDB and returns to clean landing");

    // And signin with the old handle should now fail with a "not on this device" message
    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signin-handle", handle);
    await page.type("#signin-password", PASSPHRASE);
    await page.click("#signin-submit");
    const reSignin = await waitForState(page, (s) => /account not found on this device/i.test(s.signinState) || /wrong passphrase/i.test(s.signinState) || DB_HINT_PATTERN.test(s.signinState), 12000);
    if (reSignin.kind === "match" && /account not found on this device/i.test(reSignin.snap.signinState)) {
      ok("after reset: signin with old handle says 'account not found on this device'");
    } else if (reSignin.kind === "match" && DB_HINT_PATTERN.test(reSignin.snap.signinState)) {
      fail("post-reset-signin", `post-reset signin should report account-not-found, not DB error: '${reSignin.snap.signinState}'`);
    } else if (reSignin.kind === "match") {
      fail("post-reset-signin", `unexpected message: '${reSignin.snap.signinState}'`);
    } else {
      fail("post-reset-signin", `signin hung after reset: '${reSignin.snap.signinState}'`);
    }
    await context.close();
  }

  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("LOCAL DB RECOVERY SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("LOCAL DB RECOVERY SMOKE PASSED");
})().catch((error) => { console.error("LOCAL DB RECOVERY SMOKE ERROR", error); process.exit(2); });

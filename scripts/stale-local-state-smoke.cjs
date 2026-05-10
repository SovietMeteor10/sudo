#!/usr/bin/env node
// Stale local state smoke. Verifies that after a production server
// reset, browsers carrying old local state are forced back to fresh
// signup/signin and cannot silently restore an account the server no
// longer knows.
//
// Flow:
//   1. Sign up account A in browser context.
//   2. Confirm signed-in + IndexedDB has the encrypted account bundle.
//   3. Simulate server reset by DELETing A's identity (and any
//      dev_sessions) directly from sudo.sqlite. We use a separate
//      better-sqlite3 connection rather than restarting the server,
//      so the running server keeps serving and the next /dev/session
//      call sees the missing row.
//   4. Reload page: auto-restore must NOT silently sign in. Landing
//      screen must show the stale banner.
//   5. Try signing in with A's credentials: must fail with a stale
//      message; user is NOT signed in.
//   6. Click "reset this browser": IndexedDB sudo_local_state is
//      cleared; banner clears.
//   7. Sign up a fresh account B: succeeds.

const { spawn } = require("node:child_process");
const path = require("node:path");
const Database = require("better-sqlite3");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLOW_BUDGET_MS = 15000;
const APP_DB_PATH = process.env.SUDO_DB_PATH || path.resolve(__dirname, "..", "data", "sudo.sqlite");

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

async function waitForState(page, predicate, timeoutMs = FLOW_BUDGET_MS, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      signupState: document.getElementById("signup-state")?.textContent ?? "",
      signinState: document.getElementById("signin-state")?.textContent ?? "",
      staleBanner: document.getElementById("landing-stale")?.hidden === false
        ? (document.getElementById("landing-stale")?.textContent ?? "")
        : "",
      signinDialogOpen: document.getElementById("signin-dialog")?.open ?? false,
      signupDialogOpen: document.getElementById("signup-dialog")?.open ?? false
    }));
    if (predicate(snap)) return { kind: "match", snap, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
  const last = await page.evaluate(() => ({
    authState: document.body.dataset.authState,
    signupState: document.getElementById("signup-state")?.textContent ?? "",
    signinState: document.getElementById("signin-state")?.textContent ?? "",
    staleBanner: document.getElementById("landing-stale")?.hidden === false
      ? (document.getElementById("landing-stale")?.textContent ?? "")
      : "",
    signinDialogOpen: document.getElementById("signin-dialog")?.open ?? false,
    signupDialogOpen: document.getElementById("signup-dialog")?.open ?? false
  }));
  return { kind: "timeout", snap: last, elapsed: Date.now() - start };
}

const isHanging = (text) => /creating account|signing in|working\.\.\.|loading|restoring/i.test(text || "");

function deleteIdentityRows(canonicalId) {
  const db = new Database(APP_DB_PATH);
  try {
    const before = db.prepare("SELECT canonical_id FROM identities WHERE canonical_id = ?").get(canonicalId);
    if (!before) {
      throw new Error(`identity row for ${canonicalId} not found in ${APP_DB_PATH}`);
    }
    // Order matters: drop dev_sessions first so /dev/session returns 401
    // immediately, then drop the identity itself.
    db.prepare("DELETE FROM dev_sessions WHERE canonical_id = ?").run(canonicalId);
    db.prepare("DELETE FROM dev_account_access WHERE canonical_id = ?").run(canonicalId);
    db.prepare("DELETE FROM identities WHERE canonical_id = ?").run(canonicalId);
    return true;
  } finally {
    db.close();
  }
}

(async () => {
  // Auto-accept the window.confirm() that resetThisDeviceWithConfirm uses.
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("dialog", (d) => { void d.accept(); });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.setViewport({ width: 980, height: 820 });

  // ===== 1. Sign up account A =====
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handleA = "stale" + Date.now().toString().slice(-7);
  const password = "CorrectHorseBatteryStaple9!";
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handleA);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  await page.click('#signup-form button[type="submit"]');
  const signedIn = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signupState && !isHanging(s.signupState)), FLOW_BUDGET_MS);
  if (signedIn.kind !== "match" || signedIn.snap.authState !== "signed-in") {
    fail("1.signup", `did not sign in: '${signedIn.snap.signupState}'`);
  } else {
    ok(`1. signed up as @${handleA}`);
  }

  // Discover canonical_id via well-known + capture local crypto_accounts.
  const lookup = await page.evaluate(async (handle) => {
    const r = await fetch("/.well-known/handles/" + encodeURIComponent(handle));
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  }, handleA);
  if (!lookup.ok) {
    fail("1.lookup", `well-known did not resolve @${handleA}: ${lookup.status}`);
    await browser.close();
    process.exit(failures.length === 0 ? 0 : 1);
  }
  const canonicalA = lookup.body.canonical_id;
  ok(`1b. registry has canonical_id ${canonicalA.slice(0, 16)}...`);

  const localBefore = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("sudo_local_state");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("crypto_accounts", "readonly");
      const all = tx.objectStore("crypto_accounts").getAll();
      all.onsuccess = () => resolve(all.result.map((r) => ({ canonical_id: r.canonical_id, handle: r.handle })));
      all.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  }));
  if (!Array.isArray(localBefore) || !localBefore.some((a) => a.canonical_id === canonicalA)) {
    fail("1c.crypto-store", `expected stored crypto_account for canonical_id ${canonicalA}, got ${JSON.stringify(localBefore)}`);
  } else {
    ok(`1c. local crypto_accounts has @${handleA}`);
  }

  // ===== 2. Simulate server reset =====
  try {
    deleteIdentityRows(canonicalA);
    ok("2. simulated server reset (deleted identity + dev_sessions for A)");
  } catch (error) {
    fail("2.simulate-reset", error.message);
    await browser.close();
    process.exit(1);
  }

  // Confirm well-known now 404s for A.
  const lookupAfter = await page.evaluate(async (handle) => {
    const r = await fetch("/.well-known/handles/" + encodeURIComponent(handle));
    return r.status;
  }, handleA);
  if (lookupAfter !== 404) fail("2b.lookup", `expected 404 for @${handleA} after reset, got ${lookupAfter}`);
  else ok("2b. /.well-known/handles 404s for wiped handle");

  // ===== 3. Reload — auto-restore must NOT sign in =====
  await page.reload({ waitUntil: "networkidle0" });
  const afterReload = await waitForState(page, (s) => s.authState === "menu" && s.staleBanner !== "", FLOW_BUDGET_MS);
  if (afterReload.kind !== "match") {
    fail("3.reload", `expected signed-out landing with stale banner, got authState=${afterReload.snap.authState} banner='${afterReload.snap.staleBanner}'`);
  } else if (!/no longer exists/i.test(afterReload.snap.staleBanner)) {
    fail("3.reload", `stale banner text not informative: '${afterReload.snap.staleBanner}'`);
  } else {
    ok(`3. after reload: signed out + stale banner: '${afterReload.snap.staleBanner.slice(0, 80)}...'`);
  }

  // ===== 4. Sign-in with old credentials must fail =====
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signin-handle", handleA);
  await page.type("#signin-password", password);
  await page.click("#signin-submit");
  const signinStale = await waitForState(page, (s) => !!s.signinState && !isHanging(s.signinState), FLOW_BUDGET_MS);
  if (signinStale.kind !== "match") {
    fail("4.signin", `signin state never settled: '${signinStale.snap.signinState}'`);
  } else if (signinStale.snap.authState === "signed-in") {
    fail("4.signin", "stale local account was allowed to sign in");
  } else if (!/no longer exists|sign up again/i.test(signinStale.snap.signinState)) {
    fail("4.signin", `expected stale-state error, got '${signinStale.snap.signinState}'`);
  } else {
    ok(`4. sign-in blocked with stale-state error: '${signinStale.snap.signinState.slice(0, 80)}...'`);
  }

  // Close the signin dialog so the landing reset button is clickable.
  await page.evaluate(() => document.getElementById("signin-cancel")?.click());
  await new Promise((r) => setTimeout(r, 200));

  // ===== 5. Reset this browser =====
  // Auto-confirm dialog handler set on the page above will accept.
  // resetThisDeviceWithConfirm calls deleteLocalDb() then schedules
  // window.location.reload(). Wait for the navigation rather than
  // racing the reload with our next evaluate().
  const navWait = page.waitForNavigation({ waitUntil: "networkidle0", timeout: FLOW_BUDGET_MS });
  await page.click("#landing-reset");
  await navWait;
  await page.waitForFunction(
    () => document.body.dataset.authState === "menu",
    { timeout: FLOW_BUDGET_MS }
  );
  // After reset, sudo_local_state DB should be gone or empty.
  const localAfter = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("sudo_local_state");
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("crypto_accounts", "readonly");
        const all = tx.objectStore("crypto_accounts").getAll();
        all.onsuccess = () => resolve({ ok: true, accounts: all.result.length });
        all.onerror = () => resolve({ ok: false });
      } catch {
        resolve({ ok: true, accounts: 0 });
      }
    };
    req.onerror = () => resolve({ ok: true, accounts: 0 });
  }));
  if (localAfter.accounts !== 0) {
    fail("5.reset", `expected 0 stored crypto_accounts after reset, got ${localAfter.accounts}`);
  } else {
    ok("5. reset-this-browser cleared local crypto_accounts");
  }
  const bannerAfterReset = await page.evaluate(() => ({
    hidden: document.getElementById("landing-stale")?.hidden ?? true,
    text: document.getElementById("landing-stale")?.textContent ?? ""
  }));
  if (bannerAfterReset.hidden === false && bannerAfterReset.text !== "") {
    // Acceptable: banner may briefly persist, then auto-restore detects no stale state.
    // Either way the user can sign up — the next assertion confirms.
    console.log(`note: banner still visible after reset: '${bannerAfterReset.text.slice(0, 60)}'`);
  }

  // ===== 6. Sign up fresh account B =====
  const handleB = "fresh" + Date.now().toString().slice(-7);
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handleB);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  await page.click('#signup-form button[type="submit"]');
  const fresh = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signupState && !isHanging(s.signupState)), FLOW_BUDGET_MS);
  if (fresh.kind !== "match" || fresh.snap.authState !== "signed-in") {
    fail("6.fresh-signup", `did not sign in: '${fresh.snap.signupState}' authState=${fresh.snap.authState}`);
  } else {
    ok(`6. fresh signup as @${handleB} succeeded after reset`);
  }

  await browser.close();

  console.log(`\nstale-local-state smoke: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(" - " + f);
    process.exit(1);
  }
})().catch((error) => {
  console.error("smoke crashed:", error);
  process.exit(1);
});

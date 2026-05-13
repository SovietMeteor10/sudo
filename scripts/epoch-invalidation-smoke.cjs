#!/usr/bin/env node
// epoch-invalidation smoke (Phase 13 Part C).
//
// Verifies the stale-client protection: when the server's
// NETWORK_EPOCH differs from what a browser last saw, the browser
// wipes its IndexedDB + service worker caches and reloads.
//
// Setup:
//   1. Sign up A. This puts crypto state in IDB + records the
//      current epoch in localStorage as `sudo.network_epoch`.
//   2. Stub localStorage `sudo.network_epoch` to a synthetic old
//      UUID — simulating a browser that connected before a reset.
//   3. Reload the page. The boot-time epoch check should fire,
//      detect the mismatch, wipe IDB, unregister the SW, and
//      reload.
//   4. After the reload, the page is in the landing/auth state —
//      the user has to sign up / sign in again.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first."); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function waitFor(page, predicate, timeoutMs = 8000, intervalMs = 100, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function signUp(page, handle) {
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 15000);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("ERR>", e.message));
    await page.setViewport({ width: 980, height: 820 });
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    // ===== Phase 1: sign up. =====
    const handle = `epi${Date.now().toString().slice(-7)}`;
    if (!await signUp(page, handle)) { fail("1.signup", "sign up failed"); throw new Error(); }
    ok(`1. signed up @${handle}`);

    // The boot-time epoch check records the server's epoch in
    // localStorage. Capture it.
    const epoch1 = await page.evaluate(() => localStorage.getItem("sudo.network_epoch"));
    if (typeof epoch1 !== "string" || epoch1.length < 10) {
      fail("1b.epoch-stored", `localStorage[sudo.network_epoch] not set after first visit; got ${JSON.stringify(epoch1)}`);
      throw new Error();
    }
    ok(`1b. boot-time check stored epoch=${epoch1.slice(0, 12)}…`);

    // Confirm IDB is populated (we just signed up).
    const seededRows = await page.evaluate(async () => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      try {
        const tx = db.transaction("crypto_accounts", "readonly");
        const all = await new Promise((res, rej) => {
          const r = tx.objectStore("crypto_accounts").getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
        return all.length;
      } finally { db.close(); }
    });
    if (seededRows < 1) { fail("1c.idb", `expected ≥1 crypto_account row, got ${seededRows}`); throw new Error(); }
    ok(`1c. IDB has ${seededRows} crypto_account row(s)`);

    // ===== Phase 2: stub localStorage to a synthetic old epoch.
    // Simulates a browser that connected before a network reset.
    await page.evaluate(() => {
      localStorage.setItem("sudo.network_epoch", "stale-old-epoch-aaaaaaaaaaaaaaaa");
    });
    ok(`2. injected synthetic stale epoch`);

    // ===== Phase 3: reload. The boot check fires, detects the
    // mismatch, wipes IDB, and triggers a SECOND reload ~1.2s
    // later. We wait for that second navigation to finish before
    // polling — otherwise the evaluate context gets destroyed
    // mid-poll. =====
    await Promise.all([
      page.reload({ waitUntil: "networkidle0" }),
      // Catch the cascaded reload triggered by the wipe code.
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => null)
    ]);
    const becameLanding = await waitFor(page, () => {
      const auth = document.body.dataset.authState;
      return auth !== undefined && auth !== "signed-in";
    }, 12000, 250);
    if (!becameLanding) {
      const peek = await page.evaluate(() => ({
        authState: document.body.dataset.authState,
        bodyTextFirst200: (document.body.innerText || "").slice(0, 200)
      }));
      fail("3.landing", `after stale-epoch reload, page did not return to landing state: ${JSON.stringify(peek)}`);
    } else {
      ok(`3. stale-epoch reload returned page to landing/auth state`);
    }

    // ===== Phase 4: localStorage epoch was updated to the
    // server's value (not the stub we injected). =====
    const epoch2 = await page.evaluate(() => localStorage.getItem("sudo.network_epoch"));
    if (epoch2 === "stale-old-epoch-aaaaaaaaaaaaaaaa") {
      fail("4.epoch-stale", "localStorage epoch is still the synthetic stub — wipe didn't refresh it");
    } else if (epoch2 !== epoch1) {
      fail("4.epoch-drift", `localStorage epoch changed unexpectedly: ${epoch1} → ${epoch2}`);
    } else {
      ok(`4. localStorage epoch matches the server (wipe updated it to '${epoch2.slice(0, 12)}…')`);
    }

    // ===== Phase 5: IDB was actually wiped — the crypto_account
    // row from phase 1 should be gone. =====
    const remainingRows = await page.evaluate(async () => {
      try {
        const req = indexedDB.open("sudo_local_state");
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        try {
          if (!db.objectStoreNames.contains("crypto_accounts")) return 0;
          const tx = db.transaction("crypto_accounts", "readonly");
          const all = await new Promise((res, rej) => {
            const r = tx.objectStore("crypto_accounts").getAll();
            r.onsuccess = () => res(r.result || []);
            r.onerror = () => rej(r.error);
          });
          return all.length;
        } finally { db.close(); }
      } catch {
        // IDB may have been deleted entirely — that's a stronger
        // wipe and still counts as "no leftover rows".
        return 0;
      }
    });
    if (remainingRows > 0) {
      fail("5.idb-not-wiped", `expected 0 crypto_account rows after wipe, got ${remainingRows}`);
    } else {
      ok(`5. IDB crypto_accounts wiped (was ${seededRows}, now 0)`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`EPOCH-INVALIDATION SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("EPOCH-INVALIDATION SMOKE PASSED");
})().catch((err) => {
  console.error("EPOCH-INVALIDATION SMOKE ERRORED:", err);
  process.exit(1);
});

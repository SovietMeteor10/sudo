#!/usr/bin/env node
// Asserts that the production browser signup path generates and keeps
// all private key material on the client, never causing a write under
// data/keys/ for the new account, and never inserting a row into the
// server's dev_account_access table. Also asserts that the new account
// can fully reload + restore locally without any server-held secret.
//
// This smoke pins the architecture: any future regression that puts a
// browser signup back through the server-keygen path (devSignup.ts)
// will fail loudly here, well before it could ship.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 \
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   SUDO_DATA_DIR=$(pwd)/data \
//   SUDO_DB_PATH=$(pwd)/data/sudo.sqlite \
//   node scripts/client-signup-no-server-key-smoke.cjs
//
// The data-dir / db-path defaults match the local dev server.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIR = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
const KEYS_DIR = path.join(DATA_DIR, "keys");
const DB_PATH = process.env.SUDO_DB_PATH || path.join(DATA_DIR, "sudo.sqlite");

let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

function listKeyFiles() {
  try {
    return fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith(".pem"));
  } catch {
    return [];
  }
}

function devAccountAccessCount() {
  try {
    const out = execFileSync("sqlite3", [DB_PATH, "SELECT COUNT(*) FROM dev_account_access"], { encoding: "utf-8" });
    return Number.parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

function identitiesCount() {
  try {
    const out = execFileSync("sqlite3", [DB_PATH, "SELECT COUNT(*) FROM identities"], { encoding: "utf-8" });
    return Number.parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

(async () => {
  // Pre-state snapshot. We can't safely require an empty keys dir
  // because the directory is shared with prior smokes; instead, we
  // record the file list and check that no NEW file appears containing
  // the canonical id of the account we will create.
  const preKeyFiles = new Set(listKeyFiles());
  const preAccessCount = devAccountAccessCount();
  const preIdentities = identitiesCount();

  ok(`pre-state: ${preKeyFiles.size} pem(s) in data/keys, ${preAccessCount} dev_account_access row(s), ${preIdentities} identities`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  let canonicalId = "";
  let handle = "";

  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 980, height: 820 });

    const signupNetworkPaths = new Set();
    page.on("request", (req) => {
      const url = req.url();
      if (url.startsWith(BASE)) {
        const pathOnly = url.slice(BASE.length).split("?")[0];
        signupNetworkPaths.add(`${req.method()} ${pathOnly}`);
      }
    });

    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    handle = `noserverkey${Date.now().toString().slice(-6)}`;
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');

    let signedIn = false;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await page.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") { signedIn = true; break; }
    }
    if (!signedIn) {
      fail("signup", `auth state did not reach signed-in for @${handle}`);
      throw new Error("signup hung");
    }

    // Pull canonical_id from the registered identities table by handle.
    // This is also independent proof that the browser successfully
    // posted a registerable identity_document to the server.
    try {
      const out = execFileSync("sqlite3", [DB_PATH, `SELECT canonical_id FROM identities WHERE handle = '@${handle}' LIMIT 1`], { encoding: "utf-8" });
      canonicalId = out.trim();
    } catch {}
    if (!canonicalId) {
      fail("registry", `identities table has no row for @${handle}`);
      throw new Error("registry missing");
    }
    ok(`signup completed for @${handle} (${canonicalId.slice(0, 32)}...)`);

    if (signupNetworkPaths.has("POST /api/identity/signup") || signupNetworkPaths.has("POST /dev/signup")) {
      fail("network", "browser hit a server-keygen endpoint during signup");
    } else if (signupNetworkPaths.has("POST /api/identity/register")) {
      ok("browser used /api/identity/register (public-key-only) and never POST /api/identity/signup");
    } else {
      fail("network", `unexpected: no signup-related POST observed. saw: ${[...signupNetworkPaths].join(", ")}`);
    }

    // Sign out and reload. For client-key accounts today, reload
    // intentionally lands on the menu (no session token is written
    // at signup), so the user must explicitly unlock with their
    // password. The interesting assertion is that the unlock
    // succeeds *locally* without the server holding any credential.
    await page.evaluate(() => document.getElementById("account-menu-logout")?.click());
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await page.evaluate(() => document.body.dataset.authState);
      if (a !== "signed-in") break;
    }
    await page.reload({ waitUntil: "networkidle0" });

    // Now perform a local-only sign-in. We watch network calls during
    // this step to assert that the *legacy* /api/identity/signin path
    // is not the one that ultimately authenticates. (The client may
    // call it as a fallback after a local-first failure; what matters
    // is whether it returned 200 and was the source of the signed-in
    // transition.)
    const signinNetworkPaths = new Map();
    const signinHandler = (req) => {
      const url = req.url();
      if (url.startsWith(BASE)) {
        const pathOnly = url.slice(BASE.length).split("?")[0];
        signinNetworkPaths.set(`${req.method()} ${pathOnly}`, true);
      }
    };
    page.on("request", signinHandler);

    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signin-handle", handle);
    await page.type("#signin-password", PASSPHRASE);
    await page.click('#signin-form button[type="submit"]');

    let resignedIn = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await page.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") { resignedIn = true; break; }
    }
    if (resignedIn) {
      ok(`local-only sign-in via password decrypted the IndexedDB bundle and signed @${handle} back in`);
    } else {
      fail("signin", `local sign-in did not reach signed-in for @${handle}`);
    }

    // For a client-only account, the legacy server-credential path
    // SHOULD NOT have been able to authenticate (no row exists).
    // It might still be called as a fallback; the access count check
    // below proves no credential was ever created.
    if (signinNetworkPaths.has("POST /api/identity/signin")) {
      ok("note: client tried /api/identity/signin as fallback — expected to 401 since no server credential exists");
    } else {
      ok("client unlocked entirely from local IndexedDB; no server signin attempt");
    }
  } finally {
    await browser.close();
  }

  // Post-state checks against on-disk + sqlite.
  const postKeyFiles = listKeyFiles();
  const newKeyFiles = postKeyFiles.filter((f) => !preKeyFiles.has(f));
  if (newKeyFiles.length === 0) {
    ok("data/keys/ received zero new .pem files for this signup");
  } else {
    fail("data-keys", `new pem(s) appeared: ${newKeyFiles.join(", ")}`);
  }

  const matchingForCanonical = postKeyFiles.filter((f) => f.includes(canonicalId.replace(/^sudo:ed25519:/, "")));
  if (matchingForCanonical.length === 0) {
    ok(`no pem under data/keys/ contains the new canonical id`);
  } else {
    fail("data-keys-canonical", `pem(s) contain new canonical id: ${matchingForCanonical.join(", ")}`);
  }

  const postAccessCount = devAccountAccessCount();
  if (postAccessCount === preAccessCount) {
    ok(`dev_account_access unchanged at ${postAccessCount} (no server-stored credential created)`);
  } else {
    fail("dev-account-access", `dev_account_access went ${preAccessCount} -> ${postAccessCount}`);
  }

  const postIdentities = identitiesCount();
  if (postIdentities === preIdentities + 1) {
    ok(`identities table grew by exactly 1 (public registry record created)`);
  } else {
    fail("identities", `identities went ${preIdentities} -> ${postIdentities}, expected +1`);
  }

  // ===== Phase 2a: legacy /api/identity/signup must be no-write. =====
  // Mint an HTTP-direct fixture user and verify no PEM lands in
  // data/keys/ even though the legacy server-side codepath ran.
  // This phase keeps the legacy signup route covered; it stays
  // when the legacy signin handler is removed in the next migration
  // step. /dev/signup alias coverage stays here too.
  const legacyHandle = `legsig${Date.now().toString().slice(-6)}`;
  const preLegacyKeyFiles = new Set(listKeyFiles());
  const preLegacyAccessCount = devAccountAccessCount();
  let legacyResp;
  try {
    legacyResp = await fetch(`${BASE}/api/identity/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: legacyHandle,
        password: PASSPHRASE,
        recoveryQuestion: "first object",
        recoveryAnswer: "kettle"
      })
    });
  } catch (e) {
    fail("legacy-fetch", `POST /api/identity/signup threw: ${(e || {}).message}`);
    legacyResp = null;
  }

  if (legacyResp !== null && legacyResp.status === 201) {
    const body = await legacyResp.json();
    if (body?.identity?.canonical_id && body?.sessionToken && body?.backupCode) {
      ok(`legacy /api/identity/signup returned the expected shape (identity + sessionToken + backupCode)`);
    } else {
      fail("legacy-shape", `legacy signup body missing fields: ${JSON.stringify(body).slice(0, 200)}`);
    }
    const legacyCanonical = body.identity.canonical_id;

    const postLegacyKeyFiles = listKeyFiles();
    const newLegacyKeyFiles = postLegacyKeyFiles.filter((f) => !preLegacyKeyFiles.has(f));
    if (newLegacyKeyFiles.length === 0) {
      ok("legacy /api/identity/signup writes zero new .pem files under data/keys/");
    } else {
      fail("legacy-keys", `new pem(s) appeared from legacy signup: ${newLegacyKeyFiles.join(", ")}`);
    }
    const matchingForLegacy = postLegacyKeyFiles.filter((f) => f.includes(legacyCanonical.replace(/^sudo:ed25519:/, "")));
    if (matchingForLegacy.length === 0) {
      ok(`no pem under data/keys/ contains the new legacy canonical id`);
    } else {
      fail("legacy-keys-canonical", `pem(s) contain new legacy canonical id: ${matchingForLegacy.join(", ")}`);
    }

    const postLegacyAccessCount = devAccountAccessCount();
    if (postLegacyAccessCount === preLegacyAccessCount + 1) {
      ok("legacy signup did add exactly one dev_account_access row (server credential for legacy signin path)");
    } else {
      fail("legacy-credential", `dev_account_access went ${preLegacyAccessCount} -> ${postLegacyAccessCount}, expected +1`);
    }

    // ===== Phase 2b: legacy /api/identity/signin still works.
    // ===== REMOVABLE in the next migration commit (the one that
    // ===== deletes the handler + dev_account_access table). When
    // ===== that lands, delete this block — Phase 2a above is
    // ===== independent and stays.
    const signinResp = await fetch(`${BASE}/api/identity/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: legacyHandle, password: PASSPHRASE })
    });
    if (signinResp.status === 200) {
      const sBody = await signinResp.json();
      if (sBody?.sessionToken) ok("[Phase 2b — removable] legacy /api/identity/signin still returns a session for the legacy account");
      else fail("legacy-signin-body", `signin missing sessionToken`);
    } else {
      fail("legacy-signin", `signin returned ${signinResp.status}`);
    }
    // ===== end Phase 2b. Below this comment we resume Phase 2a
    // ===== assertions on the /dev/signup alias.

    // /dev/signup alias still works.
    const aliasResp = await fetch(`${BASE}/dev/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: `${legacyHandle}alias`,
        password: PASSPHRASE,
        recoveryQuestion: "first object",
        recoveryAnswer: "kettle"
      })
    });
    if (aliasResp.status === 201 && aliasResp.headers.get("deprecation") === "true") {
      ok("/dev/signup alias still 201s and emits Deprecation: true");
    } else {
      fail("alias", `/dev/signup status=${aliasResp.status} deprecation=${aliasResp.headers.get("deprecation")}`);
    }
    const postAliasKeyFiles = listKeyFiles();
    const newAliasKeys = postAliasKeyFiles.filter((f) => !postLegacyKeyFiles.includes(f));
    if (newAliasKeys.length === 0) ok("/dev/signup alias also writes zero new .pem files");
    else fail("alias-keys", `pem(s) appeared from /dev/signup: ${newAliasKeys.join(", ")}`);
  } else {
    fail("legacy-signup", `expected 201 from /api/identity/signup, got ${legacyResp?.status}`);
  }

  if (failures.length > 0) {
    console.error(`CLIENT-SIGNUP NO-SERVER-KEY SMOKE FAILED (${failures.length} failure(s))`);
    process.exit(1);
  }
  console.log("CLIENT-SIGNUP NO-SERVER-KEY SMOKE PASSED");
})();

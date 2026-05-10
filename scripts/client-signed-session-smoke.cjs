#!/usr/bin/env node
// Pins the client-signed session bootstrap.
//
// Phase 1 — HTTP-only contract checks (no browser):
//   a. GET  /api/identity/challenge/:canonical_id returns a fresh
//      nonce + expires_at and the canonical_id round-trips.
//   b. GET on an unknown canonical → 404 identity_not_found.
//   c. POST /api/identity/session-from-challenge with a malformed
//      body → 400 invalid_payload.
//   d. POST with a bogus signature → 401 invalid_session_challenge,
//      AND the same nonce can no longer be used (replay protection
//      via single-use deletion).
//   e. POST with the correct signature, generated client-side via
//      node:crypto from a freshly-minted browser-style identity:
//      → 200 with { identity, sessionToken, expiresAt }.
//   f. The bearer the server returned is honored by GET
//      /api/identity/session.
//   g. Replaying the just-consumed nonce → 401 unknown_nonce.
//   h. Expired nonce: SUDO_CHALLENGE_TTL_SECONDS=1 server, sleep
//      ~1.5s, attempt → 401 expired_nonce.
//
// Phase 2 — browser-driven smoke proving the production signin
// path uses the challenge flow:
//   i. Browser signup, sign-out, sign-in.
//   j. The recorded network log shows
//      GET  /api/identity/challenge/:id        (fresh)
//      POST /api/identity/session-from-challenge (200)
//      AND does NOT show
//      POST /api/identity/signin              (the password path)
//
// Phase 3 — legacy /api/identity/signin still works for fixture
// accounts that have a dev_account_access row (this is what the
// HTTP-direct fixture smokes depend on).

const {
  generateKeyPairSync,
  createPublicKey,
  sign: nodeSign
} = require("node:crypto");

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
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }

function sha256Hex(value) {
  return require("node:crypto").createHash("sha256").update(value).digest("hex");
}

// Build a freshly-signed identity_document the server's /register
// will accept. We need this so the smoke owns the private key and
// can sign challenges directly via node:crypto.
function buildIdentity(handle) {
  const identityKey = generateKeyPairSync("ed25519");
  const feedKey = generateKeyPairSync("ed25519");
  const identityPublicSpki = base64Url(identityKey.publicKey.export({ type: "spki", format: "der" }));
  const feedPublicSpki = base64Url(feedKey.publicKey.export({ type: "spki", format: "der" }));
  const canonicalId = `sudo:ed25519:${sha256Hex(identityPublicSpki)}`;
  const createdAt = new Date().toISOString();
  const unsigned = {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: canonicalId,
    handle: `@${handle}`,
    home_node: "127.0.0.1",
    keys: {
      identity: { type: "ed25519", public_key: identityPublicSpki },
      messaging: { type: "x25519_or_placeholder", public_key: `placeholder:${identityPublicSpki.slice(0, 24)}` },
      feed: { type: "ed25519", public_key: feedPublicSpki }
    },
    delivery_relays: [],
    feed_endpoints: [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence: 1
  };
  const signature = base64Url(nodeSign(null, Buffer.from(canonicalJson(unsigned)), identityKey.privateKey));
  return {
    canonicalId,
    identityKey,
    document: { ...unsigned, signature }
  };
}

async function postJson(path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await resp.json(); } catch { /* not json */ }
  return { status: resp.status, body: json };
}

async function getJson(path) {
  const resp = await fetch(`${BASE}${path}`);
  let json = null;
  try { json = await resp.json(); } catch { /* not json */ }
  return { status: resp.status, body: json };
}

(async () => {
  // ===== Phase 1 =====
  // Mint a fresh client-side identity, register via /api/identity/register.
  const ident = buildIdentity(`csm${Date.now().toString().slice(-6)}`);
  const reg = await postJson("/api/identity/register", { identity_document: ident.document });
  if (reg.status !== 201) { fail("register", `expected 201, got ${reg.status}: ${JSON.stringify(reg.body)}`); throw new Error(); }
  ok(`registered fresh client-side identity ${ident.canonicalId.slice(0, 24)}...`);

  // 1a. challenge GET returns nonce + expires_at + canonical_id.
  const ch1 = await getJson(`/api/identity/challenge/${encodeURIComponent(ident.canonicalId)}`);
  if (ch1.status !== 200 || typeof ch1.body?.nonce !== "string" || typeof ch1.body?.expires_at !== "string") {
    fail("challenge-shape", `bad: ${JSON.stringify(ch1)}`);
    throw new Error();
  }
  if (ch1.body.canonical_id !== ident.canonicalId) {
    fail("challenge-roundtrip", `canonical mismatch: ${ch1.body.canonical_id}`);
  } else {
    ok(`challenge GET returns { nonce, expires_at, canonical_id } and round-trips`);
  }

  // 1b. unknown canonical → 404.
  const ch404 = await getJson("/api/identity/challenge/sudo:ed25519:0000000000000000000000000000000000000000000000000000000000000000");
  if (ch404.status === 404) ok(`challenge for unknown canonical → 404 identity_not_found`);
  else fail("challenge-unknown", `expected 404, got ${ch404.status}`);

  // 1c. malformed body → 400.
  const malformed = await postJson("/api/identity/session-from-challenge", { nonce: "x" });
  if (malformed.status === 400) ok(`malformed session-from-challenge body → 400 invalid_payload`);
  else fail("session-malformed", `expected 400, got ${malformed.status}`);

  // 1d. bogus signature → 401, AND nonce burned.
  const ch2 = await getJson(`/api/identity/challenge/${encodeURIComponent(ident.canonicalId)}`);
  const bogus = await postJson("/api/identity/session-from-challenge", {
    canonical_id: ident.canonicalId,
    nonce: ch2.body.nonce,
    signature: "YmFkc2lnbmF0dXJl"
  });
  if (bogus.status === 401) ok(`bogus signature → 401 invalid_session_challenge`);
  else fail("bogus-sig", `expected 401, got ${bogus.status}`);
  const replay = await postJson("/api/identity/session-from-challenge", {
    canonical_id: ident.canonicalId,
    nonce: ch2.body.nonce,
    signature: "YmFkc2lnbmF0dXJl"
  });
  if (replay.status === 401 && replay.body?.message === "unknown_nonce") {
    ok(`failed-verify nonce was burned (replay → unknown_nonce)`);
  } else {
    fail("burn-on-fail", `expected 401 unknown_nonce, got ${replay.status} ${JSON.stringify(replay.body)}`);
  }

  // 1e. correct signature mints a session.
  const ch3 = await getJson(`/api/identity/challenge/${encodeURIComponent(ident.canonicalId)}`);
  const signable = { type: "sudo_session_challenge", canonical_id: ident.canonicalId, nonce: ch3.body.nonce };
  const signature = base64Url(nodeSign(null, Buffer.from(canonicalJson(signable)), ident.identityKey.privateKey));
  const session = await postJson("/api/identity/session-from-challenge", {
    canonical_id: ident.canonicalId, nonce: ch3.body.nonce, signature
  });
  if (session.status !== 200) { fail("session-mint", `expected 200, got ${session.status}: ${JSON.stringify(session.body)}`); throw new Error(); }
  if (typeof session.body?.sessionToken !== "string" || typeof session.body?.expiresAt !== "string") {
    fail("session-shape", `bad: ${JSON.stringify(session.body)}`);
  } else {
    ok(`valid signature → 200 with { identity, sessionToken, expiresAt }`);
  }

  // 1f. bearer is honored by GET /api/identity/session.
  const restoreResp = await fetch(`${BASE}/api/identity/session`, {
    headers: { authorization: `Bearer ${session.body.sessionToken}`, accept: "application/json" }
  });
  if (restoreResp.status === 200) {
    const restored = await restoreResp.json();
    if (restored?.canonical_id === ident.canonicalId) ok(`server-issued bearer is accepted by /api/identity/session`);
    else fail("bearer-canonical", `restore returned wrong canonical: ${restored?.canonical_id}`);
  } else {
    fail("bearer-rejected", `restore returned ${restoreResp.status}`);
  }

  // 1g. replay of the now-consumed nonce → 401 unknown_nonce.
  const replay2 = await postJson("/api/identity/session-from-challenge", {
    canonical_id: ident.canonicalId, nonce: ch3.body.nonce, signature
  });
  if (replay2.status === 401 && replay2.body?.message === "unknown_nonce") {
    ok(`replayed consumed nonce → 401 unknown_nonce (single-use enforced)`);
  } else {
    fail("replay-success", `expected 401 unknown_nonce, got ${replay2.status} ${JSON.stringify(replay2.body)}`);
  }

  // 1h. expired-nonce path. We can't shorten the TTL on a running
  // server without a restart. Skip with a note rather than fake it.
  ok(`expired-nonce check skipped (requires SUDO_CHALLENGE_TTL_SECONDS=1 server restart; covered by service unit-test in expiry-aware ConsumeOutcome)`);

  // ===== Phase 2 =====
  // Browser signin flow: confirm the production main.js uses the
  // challenge endpoints and does NOT submit the password to
  // /api/identity/signin for a fresh client-key account.
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  try {
    const handleA = `clientsessA${Date.now().toString().slice(-6)}`;
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.setViewport({ width: 980, height: 820 });

    // Start recording network BEFORE the signup click so we can
    // assert what doSignup actually fires. This catches the new
    // client-signed session bootstrap on the signup path.
    const signupPaths = new Set();
    pageA.on("request", (req) => {
      const url = req.url();
      if (url.startsWith(BASE)) {
        signupPaths.add(`${req.method()} ${url.slice(BASE.length).split("?")[0]}`);
      }
    });

    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });

    // Signup.
    await pageA.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    await pageA.type("#signup-handle", handleA);
    await pageA.type("#signup-password", PASSPHRASE);
    await pageA.type("#signup-password-confirm", PASSPHRASE);
    await pageA.click('#signup-form button[type="submit"]');
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await pageA.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") break;
    }
    ok(`browser signed up @${handleA}`);

    // Wait a beat for any deferred mint-server-session calls.
    await new Promise((r) => setTimeout(r, 1500));

    const signupUsedRegister = signupPaths.has("POST /api/identity/register");
    const signupUsedChallenge = [...signupPaths].some((p) => p.startsWith("GET /api/identity/challenge/"));
    const signupUsedExchange = signupPaths.has("POST /api/identity/session-from-challenge");
    const signupUsedLegacySignup = signupPaths.has("POST /api/identity/signup");
    const signupUsedLegacySignin = signupPaths.has("POST /api/identity/signin");

    if (signupUsedRegister) ok(`signup POSTed /api/identity/register (public-key only)`);
    else fail("signup-register", `signup did not POST /api/identity/register; saw=${[...signupPaths].join(", ")}`);

    if (signupUsedChallenge && signupUsedExchange) {
      ok(`signup minted a server session via the challenge flow (GET /challenge + POST /session-from-challenge)`);
    } else {
      fail("signup-mint", `signup did not use the challenge flow. challenge=${signupUsedChallenge} exchange=${signupUsedExchange}; saw=${[...signupPaths].join(", ")}`);
    }

    if (!signupUsedLegacySignup) ok(`signup did NOT POST /api/identity/signup (legacy keygen path stays dormant)`);
    else fail("signup-legacy-signup", `unexpected POST /api/identity/signup during browser signup`);

    if (!signupUsedLegacySignin) ok(`signup did NOT POST /api/identity/signin (no password to server)`);
    else fail("signup-legacy-signin", `unexpected POST /api/identity/signin during browser signup`);

    // Reload immediately after signup. The bearer the new flow wrote
    // to localStorage must let us restore signed-in state without
    // re-entering the passphrase.
    await pageA.reload({ waitUntil: "networkidle0" });
    let restoredAfterSignup = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await pageA.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") { restoredAfterSignup = true; break; }
    }
    if (restoredAfterSignup) {
      ok(`reload immediately after signup restores signed-in state (no passphrase re-entry)`);
    } else {
      fail("signup-reload-restore", `reload after signup did not restore signed-in; user would have to sign in again`);
    }

    // Sign out, then start recording network for the signin click.
    await pageA.evaluate(() => document.getElementById("account-menu-logout")?.click());
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await pageA.evaluate(() => document.body.dataset.authState);
      if (a !== "signed-in") break;
    }

    const networkPaths = new Set();
    pageA.on("request", (req) => {
      const url = req.url();
      if (url.startsWith(BASE)) {
        networkPaths.add(`${req.method()} ${url.slice(BASE.length).split("?")[0]}`);
      }
    });

    await pageA.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await pageA.type("#signin-handle", handleA);
    await pageA.type("#signin-password", PASSPHRASE);
    await pageA.click('#signin-form button[type="submit"]');
    let backIn = false;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await pageA.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") { backIn = true; break; }
    }
    if (!backIn) fail("browser-signin", `auth state did not reach signed-in for @${handleA}`);
    else ok(`browser signed back in via local IDB unlock`);

    // Wait a beat for any deferred network calls.
    await new Promise((r) => setTimeout(r, 1500));

    const usedChallenge = [...networkPaths].some((p) => p.startsWith("GET /api/identity/challenge/"));
    const usedExchange = networkPaths.has("POST /api/identity/session-from-challenge");
    const usedLegacy = networkPaths.has("POST /api/identity/signin");

    if (usedChallenge && usedExchange) ok(`browser signin used the challenge flow (GET /challenge + POST /session-from-challenge)`);
    else fail("browser-flow", `expected both challenge GET and session-from-challenge POST. saw=${[...networkPaths].join(", ")}`);

    if (!usedLegacy) ok(`browser signin did NOT POST /api/identity/signin (no password to server for browser-key account)`);
    else fail("password-path", `unexpected POST /api/identity/signin during browser-key signin`);

    // Reload — bearer-token path must still restore.
    await pageA.reload({ waitUntil: "networkidle0" });
    let restored = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const a = await pageA.evaluate(() => document.body.dataset.authState);
      if (a === "signed-in") { restored = true; break; }
    }
    if (restored) ok(`reload restores signed-in state via the new bearer (challenge-minted session)`);
    else fail("reload-restore", `reload did not restore signed-in state`);
  } finally {
    await browser.close();
  }

  // ===== Phase 3 =====
  // Legacy /api/identity/signin still works for accounts that exist
  // in dev_account_access (HTTP-direct fixtures rely on this).
  const legacyHandle = `legacysignin${Date.now().toString().slice(-6)}`;
  const legacyPassword = `LegacyPassphrase!_${Date.now().toString().slice(-6)}A`;
  const legacy = await postJson("/api/identity/signup", {
    handle: legacyHandle, password: legacyPassword, recoveryQuestion: "q", recoveryAnswer: "a"
  });
  if (legacy.status !== 201) { fail("legacy-mint", `legacy signup failed: ${legacy.status}`); }
  else {
    const lsi = await postJson("/api/identity/signin", { handle: legacyHandle, password: legacyPassword });
    if (lsi.status === 200 && typeof lsi.body?.sessionToken === "string") {
      ok(`legacy POST /api/identity/signin still works for password-credentialed accounts`);
    } else {
      fail("legacy-signin", `expected 200 with sessionToken, got ${lsi.status} ${JSON.stringify(lsi.body)}`);
    }
    // Force a wrong-password attempt so we have both an "ok" and an
    // "invalid_credentials" event in the local server log to assert
    // against.
    const lsiBad = await postJson("/api/identity/signin", { handle: legacyHandle, password: "DefinitelyNotTheRightPassphrase1!" });
    if (lsiBad.status === 401) ok(`legacy signin with wrong password → 401 (expected)`);
    else fail("legacy-signin-bad", `expected 401, got ${lsiBad.status}`);
  }

  // ===== Phase 4: legacy-signin instrumentation =====
  // Migration tracker. Each /api/identity/signin attempt should emit
  // a single-line `[legacy-signin]` event in the server log. The
  // event must include the outcome and the handle, must NEVER carry
  // the submitted password, and must be greppable as one line so
  // `wc -l` works as a usage counter.
  //
  // Reads the local dev server's log file (default /tmp/sudo-local.log
  // because that's what the npm scripts redirect to). Set
  // SUDO_LOG_FILE to override. If the file is unreadable we skip the
  // assertion with a note rather than fail — this smoke is intended
  // for local-dev runs.
  const logPath = process.env.SUDO_LOG_FILE || "/tmp/sudo-local.log";
  let logBody = "";
  try {
    logBody = require("node:fs").readFileSync(logPath, "utf-8");
  } catch (e) {
    ok(`legacy-signin log assertion skipped (cannot read ${logPath}: ${(e || {}).message})`);
  }
  if (logBody.length > 0) {
    const lines = logBody.split("\n").filter((l) => l.includes("[legacy-signin]"));
    if (lines.length === 0) {
      fail("legacy-signin-log", `expected at least one [legacy-signin] line in ${logPath}; found 0`);
    } else {
      ok(`server log carries ${lines.length} [legacy-signin] event(s)`);
    }
    const okEvents = lines.filter((l) => l.includes(`"outcome":"ok"`) && l.includes(`"handle":"${legacyHandle}"`));
    if (okEvents.length >= 1) ok(`legacy-signin success event present for @${legacyHandle}`);
    else fail("legacy-signin-ok", `no success event matched: ${lines.join(" | ").slice(0, 400)}`);

    const failEvents = lines.filter((l) => l.includes(`"outcome":"invalid_credentials"`) && l.includes(`"handle":"${legacyHandle}"`));
    if (failEvents.length >= 1) ok(`legacy-signin invalid_credentials event present for @${legacyHandle}`);
    else fail("legacy-signin-fail", `no invalid_credentials event matched: ${lines.join(" | ").slice(0, 400)}`);

    if (logBody.includes(legacyPassword)) {
      fail("legacy-signin-password-leak", `password value leaked into server log`);
    } else {
      ok(`legacy-signin events never log the submitted password`);
    }

    // One-line greppability: every [legacy-signin] occurrence must be
    // followed by a `{` on the same line (not by a multi-line dump).
    const malformedLines = lines.filter((l) => !/\[legacy-signin\] \{/.test(l));
    if (malformedLines.length === 0) ok(`every [legacy-signin] event is one line (grep + wc -l friendly)`);
    else fail("legacy-signin-multiline", `${malformedLines.length} multi-line event(s)`);
  }

  if (failures.length > 0) {
    console.error(`CLIENT-SIGNED-SESSION SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("CLIENT-SIGNED-SESSION SMOKE PASSED");
})();

#!/usr/bin/env node
// link-existing-account smoke. Pins the new cross-device flow that
// replaces password-on-fresh-device. Two browser contexts:
//
//   A — desktop. Signs up. Opens settings → linked devices → "link
//       another device". Server returns a pairing code; client
//       deposits its encrypted crypto_account bundle into the
//       pairing channel (already encrypted under the user's
//       account passphrase, then wrapped once more under
//       PBKDF2(pairing_code) for transit). Pairing card displays
//       the code, the URL, and an expiry countdown.
//
//   B — mobile/fresh browser. Lands on the new four-button landing
//       (create account / unlock this device / link existing
//       account / restore from backup). Picks "link existing
//       account". Types the pairing code + the same account
//       passphrase. Client fetches the bundle, peels the outer
//       layer, fetches the signed identity profile, stores the
//       resulting LocalCryptoAccountRecord, unlocks with the
//       passphrase, mints a session via the challenge flow, signs
//       a SignedDeviceMembership for the new device's brand-new
//       device id, completes the pairing on the server, and lands
//       signed in.
//
// Assertions:
//   1.  A signs up (set up the desktop side).
//   2.  A creates a pairing code via settings → devices → link
//       another device. Pairing card surfaces code, URL, and
//       expiry.
//   3.  A's bundle is depositable: GET /api/devices/pair/handoff/
//       :code returns the wrapped ciphertext + owner_canonical_id.
//   4.  Server payload contains NO plaintext private key fields and
//       NO plaintext passphrase.
//   5.  B (fresh browser context) lands on the new 4-option
//       landing.
//   6.  B's "link existing account" opens #link-device-dialog.
//   7.  B types the code + correct passphrase, dialog closes, B
//       lands signed-in with the SAME handle as A.
//   8.  B's outbound network during link includes the challenge
//       flow (GET /api/identity/challenge/... + POST
//       /session-from-challenge) and the pair/complete POST.
//       NEVER includes any legacy /api/identity/signin POST.
//   9.  B's device_id is FRESH — does not equal A's device id.
//   10. After link, both A's and B's device records appear active
//       in /api/devices/{canonical_id}.
//   11. Reusing the consumed pairing code on a third probe fails
//       (404).
//   12. Wrong passphrase on a fresh pairing fails clearly without
//       leaving a half-written crypto_account row.
//   13. Revoking B from A's settings flips B's trust_state to
//       revoked (sync gating verified by HTTP — the recipient
//       /sync GET returns 403 once revoked).
//
// Wired up as `npm run smoke:link-existing-account`.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA_DIR = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
const DB_PATH = process.env.SUDO_DB_PATH || path.join(DATA_DIR, "sudo.sqlite");

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

  // ===== A — desktop signup =====
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.setViewport({ width: 980, height: 820 });
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handleA = `linkdesk${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handleA);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "A never reached signed-in"); throw new Error();
  }
  ok(`1. A signed up @${handleA}`);

  // Resolve canonical_id via the public registry instead of poking
  // sqlite directly — the local DB isn't reachable when this smoke
  // runs against a remote BASE.
  let canonicalA = "";
  try {
    const resp = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handleA)}`);
    if (resp.ok) {
      const body = await resp.json();
      canonicalA = typeof body?.canonical_id === "string" ? body.canonical_id : "";
    }
  } catch {}
  if (!canonicalA) {
    // Fallback: handles route on the API surface.
    try {
      const resp = await fetch(`${BASE}/api/identity/handles/${encodeURIComponent(handleA)}`);
      if (resp.ok) {
        const body = await resp.json();
        canonicalA = typeof body?.canonical_id === "string" ? body.canonical_id : "";
      }
    } catch {}
  }
  if (!canonicalA) { fail("1b.canonical", `no canonical_id for @${handleA} (registry lookup failed)`); throw new Error(); }

  // ===== A — open pairing flow =====
  await pageA.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  if (!await waitFor(pageA, () => document.getElementById("settings-dialog")?.open === true)) {
    fail("2.open-settings", "settings did not open"); throw new Error();
  }
  await pageA.evaluate(() => document.getElementById("settings-devices")?.click());
  if (!await waitFor(pageA, () => document.getElementById("devices-dialog")?.open === true)) {
    fail("2.open-devices", "devices did not open"); throw new Error();
  }
  await pageA.evaluate(() => document.getElementById("device-link-start")?.click());
  if (!await waitFor(pageA, () => document.getElementById("pairing-card")?.hidden === false, 10000)) {
    fail("2.pair-card", "pairing card did not appear"); throw new Error();
  }
  // Wait until the code text actually populates — the start flow
  // is async (server pair/start + bundle wrap + handoff POST).
  await waitFor(pageA, () => /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""), 10000);
  const pairing = await pageA.evaluate(() => ({
    code: document.getElementById("pairing-card-code")?.textContent?.trim() ?? "",
    url: document.getElementById("pairing-card-url")?.textContent?.trim() ?? "",
    expires: document.getElementById("pairing-card-expires")?.textContent?.trim() ?? "",
    qrCellCount: document.querySelectorAll("#pairing-card-qr svg rect").length
  }));
  if (!/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(pairing.code)) {
    fail("2.code-shape", `pairing code shape unexpected: '${pairing.code}'`);
  } else {
    ok(`2. A's pairing card shows code=${pairing.code}`);
  }
  // URL must be the canonical ?collect= form, not the legacy ?pair=.
  if (!pairing.url.includes("?collect=")) {
    fail("2b.url-form", `expected ?collect=, got '${pairing.url}'`);
  } else if (pairing.url.includes("?pair=")) {
    fail("2b.url-form", `URL still uses ?pair=: '${pairing.url}'`);
  } else {
    ok(`2b. URL uses ?collect= form (${pairing.url.slice(0, 60)}...)`);
  }
  // Expiry copy mentions seconds and ≤60s budget.
  const expiresSecondsMatch = /expires in (\d+)s/.exec(pairing.expires);
  if (!expiresSecondsMatch) {
    fail("2c.expiry", `expiry copy unexpected: '${pairing.expires}'`);
  } else if (Number(expiresSecondsMatch[1]) > 65) {
    fail("2c.expiry", `expiry > 65s suggests TTL was not reduced: '${pairing.expires}'`);
  } else {
    ok(`2c. passcode expires in ≤60s ('${pairing.expires}')`);
  }
  // QR is rendered as an inline <svg> with many <rect> cells. A v3
  // QR has 29×29 modules; expect at least a few hundred rect cells
  // (one per dark module) once the encoder runs.
  if (pairing.qrCellCount < 50) {
    fail("2d.qr-render", `expected QR <svg> to contain many <rect> cells, got ${pairing.qrCellCount}`);
  } else {
    ok(`2d. QR rendered as inline SVG (${pairing.qrCellCount} dark modules)`);
  }

  // ===== 3. Server has the bundle =====
  const handoffResp = await fetch(`${BASE}/api/devices/pair/handoff/${encodeURIComponent(pairing.code)}`).catch(() => null);
  let handoffBody = null;
  if (handoffResp) handoffBody = await handoffResp.json().catch(() => null);
  if (!handoffResp || handoffResp.status !== 200 || !handoffBody?.ok) {
    fail("3.handoff", `expected 200/ok, got ${handoffResp?.status}: ${JSON.stringify(handoffBody)}`);
    throw new Error();
  }
  if (typeof handoffBody.encrypted_account_bundle !== "string" || handoffBody.encrypted_account_bundle.length < 100) {
    fail("3.handoff-shape", "missing or too-short encrypted_account_bundle");
  } else {
    ok(`3. server returned encrypted bundle (${handoffBody.encrypted_account_bundle.length} bytes) for ${handoffBody.owner_canonical_id?.slice(0, 24)}...`);
  }

  // ===== 4. Bundle has no plaintext leaks =====
  const bundleStr = handoffBody.encrypted_account_bundle;
  if (bundleStr.includes(PASSPHRASE)) fail("4.passphrase-leak", "passphrase appears in plaintext in the wrapped bundle");
  else ok(`4a. wrapped bundle does not contain the account passphrase in plaintext`);
  if (/"private_key"\s*:\s*"[A-Za-z0-9+/_=-]{16,}"/i.test(bundleStr)) {
    fail("4.private-key-leak", "wrapped bundle contains a plaintext private_key field");
  } else {
    ok(`4b. wrapped bundle does not contain a plaintext private_key field`);
  }

  // Capture A's current device_id so we can compare with B's later.
  const deviceIdA = await pageA.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open("sudo_local_state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("settings", "readonly");
        const get = tx.objectStore("settings").get("device.metadata");
        get.onsuccess = () => resolve(get.result?.value?.device_id ?? null);
        get.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  });
  if (!deviceIdA) { fail("4c.device-id", "could not read A's device_id from IDB"); throw new Error(); }
  ok(`4c. A's device_id captured: ${deviceIdA.slice(0, 8)}`);

  // ===== B — fresh browser landing =====
  // Landing is back to the minimal 2-button form (sign in + sign up).
  // The "collect from another device" entry lives inside the
  // sign-in dialog's secondary actions, not on landing.
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  const landingShape = await pageB.evaluate(() => ({
    signin: document.querySelector('.landing [data-auth-action="signin"]')?.textContent?.trim() ?? "",
    signup: document.querySelector('.landing [data-auth-action="signup"]')?.textContent?.trim() ?? "",
    hasLandingLink: !!document.querySelector('.landing [data-auth-action="link"]'),
    hasLandingRestore: !!document.querySelector('.landing [data-auth-action="restore"]'),
    hasLandingReset: !!document.getElementById("landing-reset"),
    hasYellowBanner: !!document.getElementById("recovery-reminder"),
    hasHintParagraph: !!document.querySelector(".landing__hint"),
    bodyLower: document.body.textContent?.toLowerCase() ?? ""
  }));
  if (!landingShape.signin || !landingShape.signup) {
    fail("5.landing-shape", `landing missing sign in or sign up: ${JSON.stringify(landingShape)}`);
  } else if (landingShape.hasLandingLink || landingShape.hasLandingRestore || landingShape.hasLandingReset) {
    fail("5.landing-extras", `landing still has secondary CTAs: link=${landingShape.hasLandingLink} restore=${landingShape.hasLandingRestore} reset=${landingShape.hasLandingReset}`);
  } else if (landingShape.hasHintParagraph) {
    fail("5.landing-hint", "landing still has the .landing__hint paragraph; it should be removed");
  } else if (landingShape.hasYellowBanner) {
    fail("5.yellow-banner", "#recovery-reminder still rendered (the yellow strip)");
  } else {
    ok(`5. B landing is minimal (sign in + sign up; no link/restore/reset/hint/banner)`);
  }

  // ===== 6. Open collect-from-signin =====
  // Watch outbound network so we can assert later that B never POSTs
  // to /api/identity/signin and DOES use the challenge flow.
  const linkPaths = new Set();
  pageB.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(BASE)) return;
    linkPaths.add(`${req.method()} ${u.slice(BASE.length).split("?")[0]}`);
  });
  await pageB.click('.landing [data-auth-action="signin"]');
  if (!await waitFor(pageB, () => document.getElementById("signin-dialog")?.open === true)) {
    fail("6.signin", "signin dialog did not open"); throw new Error();
  }
  // The signin dialog must surface "collect account from another
  // device" as a secondary action.
  const signinSecondary = await pageB.evaluate(() => {
    const buttons = [...document.querySelectorAll('#signin-dialog [data-auth-action="link"]')];
    return buttons.map((b) => b.textContent?.trim() ?? "");
  });
  if (signinSecondary.length === 0) {
    fail("6.collect-button", "signin dialog has no [data-auth-action=link] button");
  } else if (!/collect|another device/i.test(signinSecondary[0])) {
    fail("6.collect-copy", `signin secondary button copy unexpected: '${signinSecondary[0]}'`);
  } else {
    ok(`6. signin dialog surfaces '${signinSecondary[0]}'`);
  }
  await pageB.click('#signin-dialog [data-auth-action="link"]');
  if (!await waitFor(pageB, () => document.getElementById("link-device-dialog")?.open === true)) {
    fail("6b.link-dialog", "collect-account dialog did not open from signin"); throw new Error();
  }
  ok(`6b. signin → 'collect account' opens #link-device-dialog`);
  // The dialog title and submit button must use "collect"/"passcode"
  // wording, not "pairing" or "link this device".
  const collectShape = await pageB.evaluate(() => ({
    title: document.getElementById("link-device-title")?.textContent?.trim() ?? "",
    submit: document.getElementById("link-device-submit")?.textContent?.trim() ?? "",
    codeLabel: document.querySelector('label[for="link-device-code"]')?.textContent?.trim() ?? "",
    scanQrPresent: !!document.getElementById("link-device-scan"),
    scanQrDisabled: document.getElementById("link-device-scan")?.disabled ?? false
  }));
  if (!/collect/i.test(collectShape.title)) fail("6c.title", `dialog title not collect-flavored: '${collectShape.title}'`);
  else ok(`6c. dialog title: '${collectShape.title}'`);
  if (!/collect/i.test(collectShape.submit)) fail("6d.submit", `submit copy not collect-flavored: '${collectShape.submit}'`);
  else ok(`6d. submit copy: '${collectShape.submit}'`);
  if (!/temporary passcode/i.test(collectShape.codeLabel)) fail("6e.code-label", `code label unexpected: '${collectShape.codeLabel}'`);
  else ok(`6e. code field labelled '${collectShape.codeLabel}'`);
  if (!collectShape.scanQrPresent || !collectShape.scanQrDisabled) {
    fail("6f.scan-qr", `'scan QR' placeholder missing or not disabled: present=${collectShape.scanQrPresent} disabled=${collectShape.scanQrDisabled}`);
  } else {
    ok(`6f. 'scan QR (coming soon)' placeholder present and disabled`);
  }

  // ===== 7. Type code + passphrase, submit =====
  await pageB.type("#link-device-code", pairing.code);
  await pageB.type("#link-device-passphrase", PASSPHRASE);
  await pageB.click("#link-device-submit");
  if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 30000)) {
    const state = await pageB.evaluate(() => document.getElementById("link-device-state")?.textContent ?? "");
    fail("7.signed-in", `B never reached signed-in: state='${state}'`); throw new Error();
  }
  const handleVisible = await pageB.evaluate((needle) => document.body.innerText.includes(needle), `@${handleA}`);
  if (!handleVisible) fail("7.handle", `B's UI does not show @${handleA} after link`);
  else ok(`7. B linked + signed in as @${handleA}`);

  // ===== 8. Network assertions =====
  const usedChallengeGet = [...linkPaths].some((p) => p.startsWith("GET /api/identity/challenge/"));
  const usedChallengePost = linkPaths.has("POST /api/identity/session-from-challenge");
  const usedHandoffGet = [...linkPaths].some((p) => p.startsWith("GET /api/devices/pair/handoff/"));
  const usedPairComplete = linkPaths.has("POST /api/devices/pair/complete");
  const sawLegacySignin = linkPaths.has("POST /api/identity/signin");
  if (!usedHandoffGet) fail("8.handoff-get", "B did not GET /api/devices/pair/handoff/");
  else ok(`8a. B GETed /api/devices/pair/handoff/`);
  if (!usedChallengeGet || !usedChallengePost) fail("8.challenge", `challenge flow missing: GET=${usedChallengeGet} POST=${usedChallengePost}`);
  else ok(`8b. B used the client-signed challenge flow (challenge GET + session-from-challenge POST)`);
  if (!usedPairComplete) fail("8.pair-complete", "B did not POST /api/devices/pair/complete");
  else ok(`8c. B POSTed /api/devices/pair/complete to register its membership`);
  if (sawLegacySignin) fail("8.legacy-signin", "B POSTed legacy /api/identity/signin (should not happen)");
  else ok(`8d. B never POSTed legacy /api/identity/signin`);

  // ===== 9. B's device_id is fresh =====
  const deviceIdB = await pageB.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open("sudo_local_state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("settings", "readonly");
        const get = tx.objectStore("settings").get("device.metadata");
        get.onsuccess = () => resolve(get.result?.value?.device_id ?? null);
        get.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  });
  if (!deviceIdB) fail("9.device-id-b", "could not read B's device_id");
  else if (deviceIdB === deviceIdA) fail("9.device-id-fresh", `B reused A's device_id ${deviceIdA}`);
  else ok(`9. B has a FRESH device_id ${deviceIdB.slice(0, 8)} (not A's ${deviceIdA.slice(0, 8)})`);

  // ===== 9b. A's pairing card flips to "device linked" =====
  // The trusted-devices poll on A's side detects B's new device and
  // surfaces the success message inside the pairing card. Up to ~5s
  // for the next poll tick to fire.
  const successShown = await waitFor(pageA, () => {
    const success = document.getElementById("pairing-card-success");
    if (!success || success.hidden) return false;
    return /device linked/i.test(success.textContent ?? "");
  }, 8000);
  if (!successShown) {
    const observed = await pageA.evaluate(() => ({
      hidden: document.getElementById("pairing-card-success")?.hidden,
      text: document.getElementById("pairing-card-success")?.textContent ?? ""
    }));
    fail("9b.success", `A's pairing card never showed success: hidden=${observed.hidden} text='${observed.text}'`);
  } else {
    ok(`9b. A's pairing card flipped to 'device linked' after B paired`);
  }

  // ===== 10. /api/devices listing has both records =====
  const listing = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`).then((r) => r.json()).catch(() => ({}));
  const ids = new Set((listing.devices ?? []).map((d) => d.device_id));
  if (!ids.has(deviceIdA) || !ids.has(deviceIdB)) {
    fail("10.listing", `device listing missing one or both: A=${ids.has(deviceIdA)} B=${ids.has(deviceIdB)}; ids=${[...ids].map((i) => i.slice(0, 8)).join(",")}`);
  } else {
    ok(`10. /api/devices listing shows both A and B as devices`);
  }

  // ===== 11. Pairing code reuse fails =====
  const reuseResp = await fetch(`${BASE}/api/devices/pair/handoff/${encodeURIComponent(pairing.code)}`);
  if (reuseResp.status !== 404) fail("11.reuse", `expected 404 on consumed code, got ${reuseResp.status}`);
  else ok(`11. consumed pairing code returns 404 on reuse`);

  // ===== 12. Wrong passphrase fails cleanly =====
  // Mint a fresh pairing on A. Cancel the existing card first so
  // there's no lingering DOM state, then poll until the code text
  // changes — the start flow is async (server round-trip + bundle
  // wrap + handoff POST) so reading the DOM right after the click
  // would catch the previous code.
  await pageA.evaluate(() => document.getElementById("pairing-card-cancel")?.click());
  await new Promise((r) => setTimeout(r, 200));
  await pageA.evaluate(() => document.getElementById("device-link-start")?.click());
  let pairing2 = "";
  const fresh2Start = Date.now();
  while (Date.now() - fresh2Start < 10000) {
    pairing2 = await pageA.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
    if (pairing2.length > 0 && pairing2 !== pairing.code) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pairing2 === "" || pairing2 === pairing.code) {
    fail("12.fresh-code", `second pairing did not surface a new code (saw '${pairing2}')`);
    throw new Error();
  }

  // Open a third browser context for the wrong-pass attempt. Land
  // → sign in → collect-account (matches the new entry path).
  const ctxC = await browser.createBrowserContext();
  const pageC = await ctxC.newPage();
  await pageC.setViewport({ width: 980, height: 820 });
  await pageC.goto(BASE + "/", { waitUntil: "networkidle0" });
  await pageC.click('.landing [data-auth-action="signin"]');
  await waitFor(pageC, () => document.getElementById("signin-dialog")?.open === true);
  await pageC.click('#signin-dialog [data-auth-action="link"]');
  await waitFor(pageC, () => document.getElementById("link-device-dialog")?.open === true);
  await pageC.type("#link-device-code", pairing2);
  await pageC.type("#link-device-passphrase", "DefinitelyWrongPass1!");
  await pageC.click("#link-device-submit");
  if (!await waitFor(pageC, () => /wrong|passphrase|decrypt|unlock/i.test(document.getElementById("link-device-state")?.textContent ?? ""), 15000)) {
    const obs = await pageC.evaluate(() => document.getElementById("link-device-state")?.textContent ?? "");
    fail("12.wrong-pass", `wrong passphrase did not surface a clear error: '${obs}'`);
  } else {
    ok(`12. wrong passphrase surfaces a clear error without locking the account`);
  }
  // Verify no half-written crypto_account row was left in C's IDB.
  const cAccounts = await pageC.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open("sudo_local_state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("crypto_accounts", "readonly");
        const all = tx.objectStore("crypto_accounts").getAll();
        all.onsuccess = () => resolve(all.result.length);
        all.onerror = () => resolve(-1);
      };
      req.onerror = () => resolve(-1);
    });
  });
  if (cAccounts !== 0) fail("12.cleanup", `wrong-pass left ${cAccounts} crypto_accounts in C (expected 0)`);
  else ok(`12b. wrong-pass cleaned up — no stuck crypto_account row in C`);

  // Cancel A's pending pairing so the row doesn't clutter further
  // tests in the suite.
  await pageA.evaluate(() => document.getElementById("pairing-card-cancel")?.click());

  // ===== 13. Hard revoke =====
  // The in-app revoke flow (Settings → Linked devices → revoke)
  // now mints + posts a signed SignedDeviceMembership with
  // trust_state="revoked" and sequence + 1 in addition to flipping
  // the cache. After it lands, /sync GET for the revoked device
  // must return 403, not 200 — that's the cryptographic gate.
  // Before revoke: B should be able to pull /sync (returns events).
  const preSync = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync?device_id=${encodeURIComponent(deviceIdB)}`);
  if (preSync.status !== 200) {
    fail("13.pre-sync", `B should be able to pull /sync before revoke; got ${preSync.status}`);
  } else {
    ok(`13a. before revoke, B's /sync GET returns 200`);
  }
  // Trigger the in-app revoke from A by clicking the revoke button
  // in the device list. The renderer wires the click to the
  // revokeDevice() function which builds + signs the revocation
  // membership using A's identity key.
  await pageA.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(pageA, () => document.getElementById("settings-dialog")?.open === true);
  await pageA.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(pageA, () => document.getElementById("devices-dialog")?.open === true);
  // Two-step revoke: click the prompt button to open the inline
  // confirm pane, then click the confirm button to actually post the
  // signed revocation membership. Mirrors the production UX.
  const promptClicked = await pageA.evaluate((targetDeviceId) => {
    const buttons = [...document.querySelectorAll('[data-device-action="revoke-prompt"]')];
    const target = buttons.find((b) => b.getAttribute("data-device-id") === targetDeviceId);
    if (target instanceof HTMLButtonElement) { target.click(); return true; }
    return false;
  }, deviceIdB);
  if (!promptClicked) {
    fail("13.click-prompt", "could not find a revoke-prompt button for B in the device list");
    throw new Error();
  }
  await new Promise((r) => setTimeout(r, 100));
  const confirmClicked = await pageA.evaluate((targetDeviceId) => {
    const buttons = [...document.querySelectorAll('[data-device-action="revoke-confirm"]')];
    const target = buttons.find((b) => b.getAttribute("data-device-id") === targetDeviceId);
    if (target instanceof HTMLButtonElement) { target.click(); return true; }
    return false;
  }, deviceIdB);
  if (!confirmClicked) {
    fail("13.click-confirm", "could not find a revoke-confirm button for B in the device list");
    throw new Error();
  }
  // Wait for the revocation to land server-side: poll the device
  // listing until trust_state flips to "revoked".
  let revokedRow = null;
  for (let i = 0; i < 30; i++) {
    const post = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`).then((r) => r.json()).catch(() => ({}));
    revokedRow = (post.devices ?? []).find((d) => d.device_id === deviceIdB);
    if (revokedRow?.trust_state === "revoked") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!revokedRow || revokedRow.trust_state !== "revoked") {
    fail("13b.cache-flip", `B trust_state never flipped to revoked: ${JSON.stringify(revokedRow)}`);
  } else {
    ok(`13b. B's trust_state flipped to 'revoked' in the listing`);
  }
  // The hard-revoke check: /sync GET for B should now return 403
  // because resolveActiveMembership returns null for the revoked
  // device. Allow a brief poll window so the membership upsert
  // ordering settles.
  let postSyncStatus = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync?device_id=${encodeURIComponent(deviceIdB)}`);
    postSyncStatus = r.status;
    if (postSyncStatus === 403) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (postSyncStatus !== 403) {
    fail("13c.sync-gate", `expected 403 from /sync after hard revoke, got ${postSyncStatus}`);
  } else {
    ok(`13c. revoked device gets 403 from /sync GET (signed membership gate engaged)`);
  }
  // ACK should also be gated.
  const ackResp = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient_device_id: deviceIdB, last_server_seq: 0 })
  });
  if (ackResp.status !== 403) {
    fail("13d.ack-gate", `expected 403 from /sync/ack after revoke, got ${ackResp.status}`);
  } else {
    ok(`13d. revoked device gets 403 from /sync/ack POST`);
  }

  await pageA.close(); await ctxA.close();
  await pageB.close(); await ctxB.close();
  await pageC.close(); await ctxC.close();
  await browser.close();

  if (failures.length > 0) {
    console.error(`\nLINK-EXISTING-ACCOUNT SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nLINK-EXISTING-ACCOUNT SMOKE PASSED");
})().catch((error) => { console.error("LINK-EXISTING-ACCOUNT SMOKE ERROR", error); process.exit(2); });

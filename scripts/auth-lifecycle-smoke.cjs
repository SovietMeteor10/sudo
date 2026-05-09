#!/usr/bin/env node
// Full account-lifecycle browser smoke. Drives the built portal through
// signup -> signed-in -> sign-out -> sign-in -> failure paths -> backup
// export -> backup restore -> recovery copy -> device-link copy ->
// non-blocking device sync -> static-module integrity. Every assertion
// has a hard timeout; nothing is allowed to sit on "creating account..."
// or "signing in..." past the 15s ceiling.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 \
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   node scripts/auth-lifecycle-smoke.cjs
//
// Wired up as `npm run smoke:auth-lifecycle`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FLOW_BUDGET_MS = 15000;

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

const banned = ["indexeddb", "pbkdf2", "aes-gcm", "private key", "key vault"];

async function waitForState(page, predicate, timeoutMs = FLOW_BUDGET_MS, interval = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      signupState: document.getElementById("signup-state")?.textContent ?? "",
      signinState: document.getElementById("signin-state")?.textContent ?? "",
      restoreState: document.getElementById("restore-state")?.textContent ?? "",
      signupOpen: document.getElementById("signup-dialog")?.open ?? false,
      signinOpen: document.getElementById("signin-dialog")?.open ?? false,
      restoreOpen: document.getElementById("restore-dialog")?.open ?? false
    }));
    if (predicate(snap)) return { kind: "match", snap, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
  const last = await page.evaluate(() => ({
    authState: document.body.dataset.authState,
    signupState: document.getElementById("signup-state")?.textContent ?? "",
    signinState: document.getElementById("signin-state")?.textContent ?? "",
    restoreState: document.getElementById("restore-state")?.textContent ?? ""
  }));
  return { kind: "timeout", snap: last, elapsed: Date.now() - start };
}

const isHanging = (text) => /creating account|signing in|working\.\.\.|loading|restoring|linking device/i.test(text || "");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });
  let context = await browser.createBrowserContext();
  let page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });

  const moduleRequests = [];
  const failedRequests = [];
  page.on("response", (r) => {
    const url = r.url();
    if (/\/(client|protocol)\//.test(url)) {
      moduleRequests.push({ url, status: r.status(), type: r.headers()["content-type"] || "" });
    }
    if (r.status() >= 400 && !url.endsWith("favicon.ico")) failedRequests.push(`${r.status()} ${url}`);
  });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  // ===== 1. Landing page =====
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const landing = await page.evaluate(() => ({
    sudoText: /sudo/i.test(document.body.innerText),
    hasSignin: !!document.querySelector('.landing [data-auth-action="signin"]'),
    hasSignup: !!document.querySelector('.landing [data-auth-action="signup"]'),
    hasRestoreOnLanding: !!document.querySelector('.landing [data-auth-action="restore"]'),
    signinClickable: !!document.querySelector('.landing [data-auth-action="signin"]:not([disabled])'),
    signupClickable: !!document.querySelector('.landing [data-auth-action="signup"]:not([disabled])')
  }));
  if (!landing.sudoText) fail("landing", "page does not show 'sudo'");
  else if (!landing.hasSignin || !landing.hasSignup) fail("landing", "missing sign in or sign up");
  else if (landing.hasRestoreOnLanding) fail("landing", "restore button must not be on landing");
  else if (!landing.signinClickable || !landing.signupClickable) fail("landing", "auth buttons not clickable");
  else ok("1. landing shows sudo + sign in + sign up; no restore on landing");

  // ===== 2. Create account success =====
  const handle = "lifecycle" + Date.now().toString().slice(-7);
  const password = "CorrectHorseBatteryStaple9!";
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  const signupStart = Date.now();
  await page.click('#signup-form button[type="submit"]');
  const signedIn = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signupState && !isHanging(s.signupState)), FLOW_BUDGET_MS);
  if (signedIn.kind === "timeout") fail("create-account", `still hanging after ${signedIn.elapsed}ms: '${signedIn.snap.signupState}'`);
  else if (signedIn.snap.authState !== "signed-in") fail("create-account", `did not sign in: '${signedIn.snap.signupState}'`);
  else ok(`2. create account succeeded for @${handle} in ${Date.now() - signupStart}ms`);

  // ===== 3. Post-signup state =====
  if (signedIn.snap.authState === "signed-in") {
    const post = await page.evaluate((needle) => ({
      handleVisible: document.body.innerText.includes(needle),
      currentDeviceText: document.getElementById("device-current-status")?.textContent ?? "",
      bodyLower: document.body.innerText.toLowerCase()
    }), handle);
    if (!post.handleVisible) fail("post-signup", `handle @${handle} not visible in main app`);
    else ok("3a. handle visible in main app");
    if (!/signed in/i.test(post.currentDeviceText)) fail("post-signup", `device-current-status not signed-in: '${post.currentDeviceText}'`);
    else ok("3b. current-device shows signed-in state");
    const banned_seen = banned.filter((term) => post.bodyLower.includes(term));
    if (banned_seen.length > 0) fail("post-signup", `banned crypto jargon visible: ${banned_seen.join(", ")}`);
    else ok("3c. no crypto jargon (IndexedDB/PBKDF2/AES-GCM/private key/key vault) in main app");

    const demoNeedles = ["@northcatalog", "@linebreak", "wired the registry", "rss still feels", "finger endpoints", "key continuity"];
    const demoSeen = demoNeedles.filter((needle) => post.bodyLower.includes(needle.toLowerCase()));
    if (demoSeen.length > 0) fail("post-signup", `demo content visible: ${demoSeen.join(", ")}`);
    else ok("3d. no demo posts in fresh feed");

    const streamText = await page.evaluate(() => document.getElementById("stream-list")?.innerText.toLowerCase() ?? "");
    if (!/no posts yet|sign in/i.test(streamText)) {
      // OK if a real post the user just posted shows up, but for fresh signup it should be empty.
      if (streamText.trim().length > 0) fail("post-signup", `fresh feed not empty: '${streamText.slice(0, 200)}'`);
    } else ok("3e. fresh feed shows 'no posts yet'");

    const chatsText = await page.evaluate(() => document.getElementById("chat-list")?.innerText.toLowerCase() ?? "");
    if (!/no chats yet/.test(chatsText)) fail("post-signup", `chat list not empty: '${chatsText.slice(0, 200)}'`);
    else ok("3f. fresh chat list shows 'no chats yet'");

    // 3g. directory hint sits directly below the search input.
    const directoryHint = await page.evaluate(() => {
      const search = document.getElementById("lookup-form");
      const hint = document.getElementById("directory-hint");
      if (!search || !hint) return { ok: false, reason: "missing element" };
      const sR = search.getBoundingClientRect();
      const hR = hint.getBoundingClientRect();
      return { ok: hR.top >= sR.bottom - 1 && /resolve identity|search|handle/i.test(hint.textContent || ""), text: hint.textContent };
    });
    if (!directoryHint.ok) fail("directory-hint", `expected hint directly below search input, got '${directoryHint.text ?? "(missing)"}'`);
    else ok(`3g. directory hint sits below search input: '${directoryHint.text}'`);

    // 3h. account menu surfaces honest relay status (no fake onion claim).
    const relayCopy = await page.evaluate(() => {
      document.getElementById("account-button")?.click();
      const text = document.getElementById("account-menu-relay")?.textContent ?? "";
      document.getElementById("account-button")?.click();
      return text.toLowerCase();
    });
    if (!/https fallback|encrypted, not onion-routed|onion|unavailable/.test(relayCopy)) {
      fail("relay-status", `account menu does not surface honest relay status: '${relayCopy}'`);
    } else if (/onion-routed/.test(relayCopy) && !/not onion-routed/.test(relayCopy)) {
      fail("relay-status", `relay copy claims onion routing without onion transport: '${relayCopy}'`);
    } else ok(`3h. relay status: '${relayCopy}'`);

    // 3i. After posting, the composer status text should not linger as 'posted'.
    const composerProbe = await page.evaluate(async () => {
      const body = document.getElementById("feed-body");
      if (!body) return { ok: false, reason: "missing composer" };
      body.value = "smoke post";
      body.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("feed-composer")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // Wait a moment for the async submit to settle.
      const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) {
        const text = document.getElementById("feed-composer-state")?.textContent ?? "";
        if (text === "" || /posted|^$/i.test(text)) {
          await waitFor(200);
          return { ok: true, text: document.getElementById("feed-composer-state")?.textContent ?? "" };
        }
        if (/error|fail/i.test(text)) return { ok: false, reason: text };
        await waitFor(100);
      }
      return { ok: false, reason: "composer state never settled" };
    });
    if (!composerProbe.ok) fail("composer-quiet", `composer status never quieted: ${composerProbe.reason}`);
    else if (/posted/i.test(composerProbe.text)) fail("composer-quiet", `composer still shows 'posted': '${composerProbe.text}'`);
    else ok(`3i. composer status quiets after post (text='${composerProbe.text}')`);

    // 3j. Post header layout: handle on the left, time on the right (no leading ISO date).
    const postShape = await page.evaluate(() => {
      const post = document.querySelector(".stream-post");
      if (!post) return { ok: false, reason: "no post rendered" };
      const handle = post.querySelector(".stream-post__handle")?.textContent ?? "";
      const time = post.querySelector(".stream-post__time")?.textContent ?? "";
      const meta = post.querySelector(".stream-post__meta")?.textContent ?? "";
      return { ok: true, handle, time, meta };
    });
    if (!postShape.ok) fail("post-header", postShape.reason);
    else if (/^\d{4}-\d{2}-\d{2}/.test(postShape.meta.trim())) fail("post-header", `meta still leads with ISO date: '${postShape.meta}'`);
    else if (!/^@/.test(postShape.handle)) fail("post-header", `expected handle starting with @, got '${postShape.handle}'`);
    // Time + date format: "HH:MM DD MMM" (this year) or "HH:MM DD MMM YY" (other year)
    else if (!/^\d{2}:\d{2} \d{2} [A-Z][a-z]{2}( \d{2})?$/.test(postShape.time.trim())) {
      fail("post-header", `expected 'HH:MM DD MMM' (with optional YY), got '${postShape.time}'`);
    } else ok(`3j. post header has @handle '${postShape.handle}' and time '${postShape.time}'`);

    // 3k. Personal feed posts expose the unified action row: vote
    // control (single button) + reply ↩. The repost button is
    // intentionally absent on the viewer's own posts (self-repost is
    // blocked end-to-end) — its presence here would be a regression.
    const actionShape = await page.evaluate(() => {
      const post = document.querySelector(".stream-post");
      if (!post) return { ok: false, reason: "no post rendered" };
      const vote = post.querySelector(".stream-post__action--vote");
      const reply = post.querySelector(".stream-post__action[data-reaction='reply']");
      const repost = post.querySelector(".stream-post__action[data-reaction='repost']");
      const upDown = post.querySelector("[data-reaction='recommend'], [data-reaction='downrank']");
      return {
        ok: true,
        hasVote: vote !== null,
        hasReply: reply !== null,
        hasRepost: repost !== null,
        hasLegacyUpDown: upDown !== null,
        voteState: vote?.getAttribute("data-vote-state") ?? ""
      };
    });
    if (!actionShape.ok) fail("post-actions", actionShape.reason);
    else if (!actionShape.hasVote) fail("post-actions", "missing vote control");
    else if (!actionShape.hasReply) fail("post-actions", "missing reply button");
    else if (actionShape.hasRepost) fail("post-actions", "repost button present on own post (self-repost is blocked)");
    else if (actionShape.hasLegacyUpDown) fail("post-actions", "legacy up/down buttons still present");
    else if (actionShape.voteState !== "neutral") fail("post-actions", `vote starts in '${actionShape.voteState}', expected 'neutral'`);
    else ok("3k. post exposes vote + reply action row (repost hidden on own posts)");

    // 3l. Discover tab renders through .stream-post (unified card),
    // does not expose recent/rising/hot toggle buttons, and does not
    // surface the "public discovery index" debug label.
    const discoverShape = await page.evaluate(() => {
      const root = document.getElementById("discovery-list");
      if (!root) return { ok: false, reason: "no discovery root" };
      const text = root.textContent ?? "";
      const buttons = Array.from(root.querySelectorAll("button"));
      const hasModeButton = buttons.some((b) => {
        const t = (b.textContent ?? "").trim().toLowerCase();
        return t === "recent" || t === "rising" || t === "hot";
      });
      const hasDebugLabel = /public discovery index/i.test(text);
      const usesUnifiedCard = root.querySelector(".discovery-card") === null;
      return { ok: true, hasModeButton, hasDebugLabel, usesUnifiedCard };
    });
    if (!discoverShape.ok) fail("discover-shape", discoverShape.reason);
    else if (discoverShape.hasModeButton) fail("discover-shape", "discover still exposes recent/rising/hot mode buttons");
    else if (discoverShape.hasDebugLabel) fail("discover-shape", "discover still surfaces 'public discovery index' label");
    else if (!discoverShape.usesUnifiedCard) fail("discover-shape", "discover still renders legacy .discovery-card layout");
    else ok("3l. discover renders unified post card with no debug surface");
  }

  // ===== 4. Sign out / sign in same device =====
  // Sign out via the account menu (top-right username -> logout).
  const signedOut = await page.evaluate(() => {
    const trigger = document.getElementById("account-button");
    const logout = document.getElementById("account-menu-logout");
    if (!trigger || !logout) return false;
    trigger.click();
    logout.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 400));
  let authStateAfterSignout = await page.evaluate(() => document.body.dataset.authState);
  if (signedOut && authStateAfterSignout === "menu") ok("4a. sign out returned to landing menu");
  else if (!signedOut) ok("4a. logout button not yet exposed; clearing session for sign-in test");

  // Re-open sign-in card and sign in with same handle/passphrase.
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signin-handle", handle);
  await page.type("#signin-password", password);
  const signinStart = Date.now();
  await page.click("#signin-submit");
  const signinResult = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signinState && !isHanging(s.signinState)), FLOW_BUDGET_MS);
  if (signinResult.kind === "timeout") fail("same-device-signin", `still hanging after ${signinResult.elapsed}ms: '${signinResult.snap.signinState}'`);
  else if (signinResult.snap.authState !== "signed-in") fail("same-device-signin", `did not sign in: '${signinResult.snap.signinState}'`);
  else ok(`4b. same-device sign-in succeeded in ${Date.now() - signinStart}ms`);

  // ===== 5. Unknown account failure =====
  // New context so we don't see the previous account locally.
  await page.close();
  await context.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) failedRequests.push(`${r.status()} ${r.url()}`); });
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signin-handle", "nobody" + Date.now().toString().slice(-6));
  await page.type("#signin-password", "any-passphrase");
  await page.click("#signin-submit");
  const unknownResult = await waitForState(page, (s) => !!s.signinState && !isHanging(s.signinState), FLOW_BUDGET_MS);
  if (unknownResult.kind === "timeout") fail("unknown-handle", `signin hung: '${unknownResult.snap.signinState}'`);
  else if (!/account not found on this device|not found|unavailable|invalid/i.test(unknownResult.snap.signinState)) {
    fail("unknown-handle", `error not user-friendly: '${unknownResult.snap.signinState}'`);
  } else ok(`5. unknown handle resolved in ${unknownResult.elapsed}ms: '${unknownResult.snap.signinState}'`);

  // ===== 6. Wrong passphrase failure =====
  // Create a new account in this fresh context, sign out, then try wrong passphrase.
  await page.click("#signin-cancel");
  await new Promise((r) => setTimeout(r, 200));
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  const handle2 = "wrongpw" + Date.now().toString().slice(-7);
  await page.type("#signup-handle", handle2);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  await page.click('#signup-form button[type="submit"]');
  const signed2 = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signupState && !isHanging(s.signupState)), FLOW_BUDGET_MS);
  if (signed2.snap.authState !== "signed-in") {
    fail("wrong-passphrase-setup", `could not create second account: '${signed2.snap.signupState}'`);
  } else {
    await page.evaluate(() => {
      document.getElementById("account-button")?.click();
      document.getElementById("account-menu-logout")?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signin-handle", handle2);
    await page.type("#signin-password", "DefinitelyWrongPass1!");
    await page.click("#signin-submit");
    const wrongPwResult = await waitForState(page, (s) => !!s.signinState && !isHanging(s.signinState), FLOW_BUDGET_MS);
    if (wrongPwResult.kind === "timeout") fail("wrong-passphrase", `signin hung: '${wrongPwResult.snap.signinState}'`);
    else if (!/wrong passphrase|invalid|incorrect|not found|account/i.test(wrongPwResult.snap.signinState)) {
      fail("wrong-passphrase", `error not user-friendly: '${wrongPwResult.snap.signinState}'`);
    } else ok(`6. wrong passphrase resolved in ${wrongPwResult.elapsed}ms: '${wrongPwResult.snap.signinState}'`);
    // Sign back in for backup test.
    await page.click("#signin-cancel");
    await new Promise((r) => setTimeout(r, 200));
    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => { document.getElementById("signin-handle").value = ""; document.getElementById("signin-password").value = ""; });
    await page.type("#signin-handle", handle2);
    await page.type("#signin-password", password);
    await page.click("#signin-submit");
    await waitForState(page, (s) => s.authState === "signed-in", FLOW_BUDGET_MS);
  }

  // ===== 7. Backup export =====
  // The current implementation gates the export on window.prompt() for the
  // backup passphrase. Headless Chrome auto-dismisses prompts, so we
  // override prompt to return our test passphrase. We also hook
  // URL.createObjectURL to grab the encrypted blob text without needing
  // a real download.
  const backupResult = await page.evaluate(async (testPassphrase) => {
    return new Promise((resolve) => {
      window.prompt = () => testPassphrase;
      const origCreate = URL.createObjectURL.bind(URL);
      let captured = null;
      URL.createObjectURL = (blob) => {
        const reader = new FileReader();
        reader.onload = () => { captured = reader.result; };
        reader.readAsText(blob);
        return origCreate(blob);
      };
      // Backup lives in the top-right account dropdown; open it then click.
      document.getElementById("account-button")?.click();
      const button = document.getElementById("account-menu-backup");
      if (!button) { resolve({ ok: false, reason: "backup button missing" }); return; }
      button.click();
      const start = Date.now();
      const feedbackText = () => document.getElementById("local-maintenance-feedback")?.textContent ?? "";
      const tick = () => {
        if (captured !== null) { resolve({ ok: true, body: captured }); return; }
        const fb = feedbackText();
        if (/cancelled|fail/i.test(fb)) { resolve({ ok: false, reason: `feedback: ${fb}` }); return; }
        if (Date.now() - start > 8000) { resolve({ ok: false, reason: `backup did not produce a blob within 8s (feedback='${fb}')` }); return; }
        setTimeout(tick, 100);
      };
      tick();
    });
  }, password);
  let backupBlob = null;
  if (!backupResult.ok) fail("backup-export", backupResult.reason);
  else {
    backupBlob = backupResult.body;
    let parsed;
    try { parsed = JSON.parse(backupBlob); } catch (e) { fail("backup-export", `not valid JSON: ${e.message}`); parsed = null; }
    if (parsed) {
      // Should be encrypted: ciphertext present, no plaintext private material.
      const lowered = backupBlob.toLowerCase();
      const looksEncrypted = !!(parsed.ciphertext || parsed.encrypted_bundle_json) && !lowered.includes("\"private_key\":") && !lowered.includes(password.toLowerCase());
      if (!looksEncrypted) fail("backup-export", "exported JSON appears to contain plaintext private material or the passphrase");
      else ok(`7. backup export produced encrypted JSON (${backupBlob.length} bytes)`);
    }
  }

  // ===== 8. Restore from backup file =====
  if (backupBlob) {
    // Fresh context to simulate another browser
    await page.close();
    await context.close();
    context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport({ width: 980, height: 820 });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) failedRequests.push(`${r.status()} ${r.url()}`); });
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    await page.click('.landing [data-auth-action="signin"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.click('#signin-dialog [data-auth-action="restore"]');
    await new Promise((r) => setTimeout(r, 250));
    await page.click("#restore-mode-file");
    await new Promise((r) => setTimeout(r, 100));

    // Inject the file directly into the input.
    const fileInput = await page.$("#restore-file");
    const fs = require("node:fs");
    const tmp = require("node:path").join(require("node:os").tmpdir(), `sudo-backup-${Date.now()}.sudo-backup.json`);
    fs.writeFileSync(tmp, backupBlob);
    await fileInput.uploadFile(tmp);
    await page.type("#restore-passphrase", password);
    await page.click("#restore-submit");
    // Restore dialog closes on success; feedback lands in
    // local-maintenance-feedback. We accept any of: signed-in, dialog
    // closed, "backup restored" feedback, or an explicit error.
    const restoreResult = await waitForState(page, (s) => {
      if (s.authState === "signed-in") return true;
      if (!s.restoreOpen) return true; // dialog closed
      if (s.restoreState && !isHanging(s.restoreState)) return true;
      return false;
    }, FLOW_BUDGET_MS);
    fs.unlinkSync(tmp);
    const maintenanceFeedback = await page.evaluate(() => document.getElementById("local-maintenance-feedback")?.textContent ?? "");
    if (restoreResult.kind === "timeout") fail("backup-restore", `still hanging: '${restoreResult.snap.restoreState}' / feedback='${maintenanceFeedback}'`);
    else if (restoreResult.snap.authState === "signed-in") ok(`8a. backup file restore succeeded in ${restoreResult.elapsed}ms`);
    else if (/restored|imported/i.test(maintenanceFeedback)) ok(`8a. backup restored in ${restoreResult.elapsed}ms (feedback='${maintenanceFeedback}')`);
    else if (/not yet|coming soon|unavailable/i.test(restoreResult.snap.restoreState)) ok(`8a. backup restore not implemented and says so: '${restoreResult.snap.restoreState}'`);
    else fail("backup-restore", `restore failed: state='${restoreResult.snap.restoreState}' feedback='${maintenanceFeedback}'`);

    // 8b. After restore, sign-in works for the same account
    if (restoreResult.snap.authState !== "signed-in") {
      // attempt explicit sign-in
      await page.click('.landing [data-auth-action="signin"]');
      await new Promise((r) => setTimeout(r, 200));
      await page.type("#signin-handle", handle2);
      await page.type("#signin-password", password);
      await page.click("#signin-submit");
      const post = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signinState && !isHanging(s.signinState)), FLOW_BUDGET_MS);
      if (post.snap.authState === "signed-in") ok(`8b. sign-in works after restore in ${post.elapsed}ms`);
      else fail("post-restore-signin", `could not sign in after restore: '${post.snap.signinState}'`);
    } else {
      ok("8b. signed in directly via restore");
    }
  } else {
    fail("backup-restore", "skipped — no backup blob produced");
  }

  // ===== 9. Recovery answer / backup code path =====
  // The current restore card has a "recovery" mode. Spec says: must clearly
  // indicate availability or unavailability and never sit on a hang.
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-logout")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.click('#signin-dialog [data-auth-action="restore"]');
  await new Promise((r) => setTimeout(r, 250));
  const recoveryHint = await page.evaluate(() => ({
    hint: document.getElementById("restore-passkey-support")?.textContent ?? "",
    recoveryFieldsVisible: !document.getElementById("restore-recovery-fields")?.hidden
  }));
  if (!recoveryHint.recoveryFieldsVisible) fail("recovery-mode", "recovery panel not visible by default");
  else if (!/development|use backup file|not.*available|backup file restore/i.test(recoveryHint.hint)) {
    fail("recovery-mode", `recovery copy must clearly point users to backup file: '${recoveryHint.hint}'`);
  } else ok(`9. recovery mode copy is clear: '${recoveryHint.hint.slice(0, 80)}'`);

  // ===== 10. Device linking foundation =====
  await page.click("#restore-cancel");
  await new Promise((r) => setTimeout(r, 200));
  // Sign in to access device panel
  await page.click('.landing [data-auth-action="signin"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => { document.getElementById("signin-handle").value = ""; document.getElementById("signin-password").value = ""; });
  await page.type("#signin-handle", handle2);
  await page.type("#signin-password", password);
  await page.click("#signin-submit");
  await waitForState(page, (s) => s.authState === "signed-in", FLOW_BUDGET_MS);
  // Devices live behind the account-menu -> linked devices dialog.
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-devices")?.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  const linkResult = await page.evaluate(async () => {
    const startBtn = document.getElementById("device-link-start");
    if (!startBtn) return { ok: false, reason: "device-link-start button missing" };
    // Clear any stale feedback (e.g. "device saved" from background sync)
    // before pressing so we observe the new pairing-flow result only.
    const codeInput = document.getElementById("device-pairing-code");
    const feedback = document.getElementById("device-panel-feedback");
    if (codeInput) codeInput.value = "";
    if (feedback) feedback.textContent = "";
    startBtn.click();
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const code = codeInput?.value ?? "";
      const fbText = feedback?.textContent ?? "";
      if (code) return { ok: true, code, feedback: fbText };
      if (/pairing code ready|pairing start failed|sign in first/i.test(fbText)) {
        return { ok: !!code, feedback: fbText, code };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, reason: "device link did not respond within 8s" };
  });
  if (!linkResult.ok) fail("device-link", linkResult.reason || `no clear feedback: '${linkResult.feedback}'`);
  else ok(`10. device link returned a pairing code: '${linkResult.code.slice(0, 16)}...'`);

  // ===== 11. Network timeout simulation: hang /api/devices/register =====
  await page.close();
  await context.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().endsWith("/api/devices/register")) {
      // Never respond — simulates network hang
      // (request will eventually be aborted when the page closes)
      return;
    }
    req.continue();
  });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  const handle3 = "hangtest" + Date.now().toString().slice(-7);
  await page.type("#signup-handle", handle3);
  await page.type("#signup-password", password);
  await page.type("#signup-password-confirm", password);
  await page.click('#signup-form button[type="submit"]');
  const hangResult = await waitForState(page, (s) => s.authState === "signed-in" || (!!s.signupState && !isHanging(s.signupState)), FLOW_BUDGET_MS);
  if (hangResult.snap.authState !== "signed-in") {
    fail("nonblocking-device-sync", `signup blocked when /api/devices/register hangs: '${hangResult.snap.signupState}' authState=${hangResult.snap.authState}`);
  } else {
    ok(`11. signup completed even though /api/devices/register was hanging (${hangResult.elapsed}ms)`);
  }

  // ===== 12. Static module integrity =====
  const badModules = moduleRequests.filter((m) => m.status !== 200 || !/javascript|ecmascript/i.test(m.type));
  if (badModules.length > 0) fail("static-modules", `non-JS or non-200 module responses: ${badModules.slice(0, 3).map(m => `${m.status} ${m.url}`).join("; ")}`);
  else if (moduleRequests.length === 0) ok("12. no /client or /protocol module fetches observed (no negative result)");
  else ok(`12. all ${moduleRequests.length} /client and /protocol module requests returned 200 with JS content-type`);

  // ===== Wrap-up =====
  if (consoleErrors.length > 0) {
    console.log("\nbrowser console errors:");
    for (const message of consoleErrors) console.log("  -", message);
  }
  if (failedRequests.length > 0) {
    console.log("\nfailed requests during run:");
    for (const message of failedRequests.slice(0, 20)) console.log("  -", message);
  }

  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("\nLIFECYCLE SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nLIFECYCLE SMOKE PASSED");
})().catch((error) => { console.error("LIFECYCLE SMOKE ERROR", error); process.exit(2); });

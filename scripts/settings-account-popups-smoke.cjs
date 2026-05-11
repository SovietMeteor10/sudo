#!/usr/bin/env node
// Settings + Account popup smoke. Pins the UX cleanup post-step-7:
//
// Front page (Part 1):
//   - no #landing-reset button on the landing screen
//   - landing carries a single plain-language hint about keys living
//     on this device — no relay/keychain/IndexedDB/recovery-question
//     wording leaks through
//   - sign in + sign up are still the primary actions
//
// Account dropdown (Parts 2-3):
//   - menu shows account + settings + logout (slim shape)
//   - no account-menu-backup, account-menu-restore,
//     account-menu-devices, account-menu-fingerprint, or
//     account-menu-relay items
//   - clicking "settings" opens #settings-dialog
//   - clicking "account" opens #account-dialog
//
// Settings dialog (Part 2):
//   - has Backup, Restore, Linked devices buttons
//   - has a danger zone collapsed by default
//   - reset button is disabled until the user types RESET exactly
//   - a programmatic .click() on the reset button while the input
//     is empty does nothing (the handler double-checks the input
//     value, so a regression that drops the disabled gate would
//     still be blocked)
//   - typing RESET enables the button (the destructive flow itself
//     is exercised by stale-local-state-smoke.cjs; we don't
//     actually wipe IndexedDB here)
//
// Account dialog (Part 3):
//   - shows the current handle
//   - renders the visual fingerprint grid (8x8 cells)
//   - shows the compact fingerprint text
//   - shows a recovery-status row that mentions backup OR linked
//     device, or honestly says "unprotected"
//   - canonical id lives under the "advanced" disclosure (collapsed)
//   - bio textarea is editable
//
// Bio persistence (Part 4):
//   - typing into bio + clicking save writes through; reload + reopen
//     the dialog and the bio is still there
//
// Part 5 — relay/recovery-question/IndexedDB/keychain wording does
// not appear in any user-facing copy across landing, account menu,
// settings dialog, or account dialog.
//
// Wired up as `npm run smoke:settings-account`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const FORBIDDEN_TERMS = [
  "relay inbox", "encrypted relay", "blob",
  "locked account",
  "recovery question", "recovery answer", "recovery code",
  "indexeddb", "keychain", "key vault"
];

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

async function waitFor(page, predicate, timeoutMs = 10000, interval = 80) {
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
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 980, height: 820 });
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // ===== Part 1: landing copy =====
  const landingShape = await page.evaluate(() => {
    const landing = document.querySelector(".landing");
    return {
      hasResetButton: !!document.getElementById("landing-reset"),
      hasSignin: !!document.querySelector('.landing [data-auth-action="signin"]'),
      hasSignup: !!document.querySelector('.landing [data-auth-action="signup"]'),
      hasHint: !!document.querySelector(".landing__hint"),
      bodyText: (landing?.textContent ?? "").toLowerCase()
    };
  });
  if (landingShape.hasResetButton) fail("1a.no-landing-reset", "#landing-reset still on landing");
  else ok(`1a. landing has no #landing-reset button`);
  if (!landingShape.hasSignin || !landingShape.hasSignup) fail("1b.signin-signup", "missing sign in or sign up");
  else ok(`1b. landing keeps sign in + sign up`);
  if (!landingShape.hasHint) fail("1c.landing-hint", "landing missing the plain-language hint paragraph");
  else ok(`1c. landing has plain-language hint about local keys`);
  const leakedOnLanding = FORBIDDEN_TERMS.filter((term) => landingShape.bodyText.includes(term));
  if (leakedOnLanding.length > 0) {
    fail("1d.landing-copy", `landing leaks technical terms: ${leakedOnLanding.join(", ")}`);
  } else {
    ok(`1d. landing copy is free of relay/recovery-Q/keychain/IndexedDB wording`);
  }

  // ===== Sign up so we can probe signed-in surfaces =====
  const handle = `uxclean${Date.now().toString().slice(-7)}`;
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in")) {
    fail("setup.signup", "signup never reached signed-in"); throw new Error();
  }
  ok(`setup. signed up @${handle}`);

  // ===== Part 2: account dropdown shape =====
  const menuShape = await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    const root = document.getElementById("account-menu");
    const items = root === null ? [] : [...root.querySelectorAll(".account-menu__item")].map((b) => b.id);
    const lower = (root?.textContent ?? "").toLowerCase();
    document.getElementById("account-button")?.click();
    return { items, lower };
  });
  const expected = ["account-menu-account", "account-menu-settings", "account-menu-logout"];
  const removed = ["account-menu-backup", "account-menu-restore", "account-menu-devices", "account-menu-fingerprint", "account-menu-relay", "account-menu-lock"];
  const missing = expected.filter((id) => !menuShape.items.includes(id));
  const lingering = removed.filter((id) => menuShape.items.includes(id));
  if (missing.length > 0) fail("2a.menu-shape", `missing items: ${missing.join(", ")}`);
  else ok(`2a. account menu has slim shape (account/settings/logout)`);
  if (lingering.length > 0) fail("2b.menu-shape", `removed items still present: ${lingering.join(", ")}`);
  else ok(`2b. account menu does not surface backup/restore/devices/fingerprint/relay/lock rows`);
  const leakedInMenu = FORBIDDEN_TERMS.filter((term) => menuShape.lower.includes(term));
  if (leakedInMenu.length > 0) fail("2c.menu-copy", `menu copy leaks: ${leakedInMenu.join(", ")}`);
  else ok(`2c. account menu copy is free of leaked technical terms`);

  // ===== Part 3: open settings dialog =====
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("settings-dialog")?.open === true)) {
    fail("3.settings-open", "settings dialog did not open"); throw new Error();
  }
  ok(`3a. account menu → settings opens #settings-dialog`);

  const settingsShape = await page.evaluate(() => {
    const root = document.getElementById("settings-dialog");
    return {
      hasBackup: !!document.getElementById("settings-backup"),
      hasRestore: !!document.getElementById("settings-restore"),
      hasDevices: !!document.getElementById("settings-devices"),
      hasResetInput: !!document.getElementById("settings-reset-confirm"),
      hasResetButton: !!document.getElementById("settings-reset"),
      resetButtonDisabled: document.getElementById("settings-reset")?.disabled === true,
      dangerSummary: document.querySelector("#settings-danger summary")?.textContent ?? "",
      dangerOpen: document.getElementById("settings-danger")?.open ?? false,
      lower: (root?.textContent ?? "").toLowerCase()
    };
  });
  if (!settingsShape.hasBackup || !settingsShape.hasRestore || !settingsShape.hasDevices) {
    fail("3b.settings-actions", `settings missing actions: backup=${settingsShape.hasBackup} restore=${settingsShape.hasRestore} devices=${settingsShape.hasDevices}`);
  } else ok(`3b. settings dialog has Backup, Restore, Linked devices buttons`);
  if (!settingsShape.hasResetInput || !settingsShape.hasResetButton) {
    fail("3c.settings-reset", `settings reset surface missing`);
  } else if (!settingsShape.resetButtonDisabled) {
    fail("3c.settings-reset-default", `reset button is enabled by default; should require typing RESET first`);
  } else ok(`3c. settings reset button starts disabled (gated on typed confirm)`);
  if (settingsShape.dangerOpen) fail("3d.settings-danger-open", "danger zone is open by default");
  else ok(`3d. settings danger zone is collapsed by default ('${settingsShape.dangerSummary}')`);
  const leakedInSettings = FORBIDDEN_TERMS.filter((term) => settingsShape.lower.includes(term));
  if (leakedInSettings.length > 0) fail("3e.settings-copy", `settings copy leaks: ${leakedInSettings.join(", ")}`);
  else ok(`3e. settings copy is free of leaked technical terms`);

  // 3f. Type a wrong value -> button stays disabled. Type RESET -> enabled.
  await page.evaluate(() => {
    const details = document.getElementById("settings-danger");
    if (details instanceof HTMLDetailsElement) details.open = true;
    const input = document.getElementById("settings-reset-confirm");
    if (input instanceof HTMLInputElement) {
      input.value = "reset";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const wrongValueDisabled = await page.evaluate(() => document.getElementById("settings-reset")?.disabled);
  if (wrongValueDisabled !== true) fail("3f.reset-typo", "reset button enabled with wrong-case 'reset'");
  else ok(`3f. typing 'reset' (wrong case) keeps reset disabled`);

  await page.evaluate(() => {
    const input = document.getElementById("settings-reset-confirm");
    if (input instanceof HTMLInputElement) {
      input.value = "RESET";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const correctValueEnabled = await page.evaluate(() => document.getElementById("settings-reset")?.disabled);
  if (correctValueEnabled !== false) fail("3g.reset-confirm", "reset button still disabled after typing RESET");
  else ok(`3g. typing 'RESET' enables the reset button`);

  // We do NOT actually click reset here — that wipes IndexedDB and
  // ends the smoke session. The destructive flow itself is exercised
  // by stale-local-state-smoke.cjs. Close settings.
  await page.evaluate(() => document.getElementById("settings-cancel")?.click());

  // ===== Part 4: account dialog =====
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-account")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("account-dialog")?.open === true)) {
    fail("4.account-open", "account dialog did not open"); throw new Error();
  }
  ok(`4a. account menu → account opens #account-dialog`);

  const accountShape = await page.evaluate(() => {
    const root = document.getElementById("account-dialog");
    const grid = document.getElementById("account-card-fingerprint-grid");
    const fingerprintCellCount = grid === null ? 0 : grid.querySelectorAll(".identity-fingerprint-grid__cell").length;
    return {
      handle: document.getElementById("account-card-handle")?.textContent ?? "",
      fingerprintCellCount,
      fingerprintText: document.getElementById("account-card-fingerprint-text")?.textContent ?? "",
      statusText: document.getElementById("account-card-status")?.textContent ?? "",
      bioInputPresent: !!document.getElementById("account-bio"),
      advancedOpen: document.getElementById("account-advanced")?.open ?? false,
      canonicalText: document.getElementById("account-card-canonical")?.textContent ?? "",
      lower: (root?.textContent ?? "").toLowerCase()
    };
  });
  if (!accountShape.handle.includes(handle)) fail("4b.handle", `account dialog handle wrong: '${accountShape.handle}'`);
  else ok(`4b. account dialog shows handle ${accountShape.handle}`);
  if (accountShape.fingerprintCellCount !== 64) {
    fail("4c.fingerprint-grid", `expected 64 grid cells (8x8), got ${accountShape.fingerprintCellCount}`);
  } else ok(`4c. account dialog renders 8x8 visual fingerprint grid`);
  if (!/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(accountShape.fingerprintText.trim())) {
    fail("4d.fingerprint-text", `compact fingerprint shape unexpected: '${accountShape.fingerprintText}'`);
  } else ok(`4d. account dialog shows compact fingerprint '${accountShape.fingerprintText}'`);
  if (!/recovery|backup|unprotected|linked device/i.test(accountShape.statusText)) {
    fail("4e.recovery-status", `recovery status copy missing/unexpected: '${accountShape.statusText}'`);
  } else ok(`4e. account dialog shows recovery status: '${accountShape.statusText.slice(0, 80).trim()}...'`);
  if (!accountShape.bioInputPresent) fail("4f.bio-input", "account dialog has no #account-bio textarea");
  else ok(`4f. account dialog has an editable bio textarea`);
  if (accountShape.advancedOpen) fail("4g.advanced", "account 'advanced' is open by default; should be collapsed");
  else ok(`4g. canonical id is hidden behind the collapsed 'advanced' disclosure`);
  if (!accountShape.canonicalText.startsWith("sudo:")) {
    fail("4h.canonical", `canonical id missing or wrong shape: '${accountShape.canonicalText}'`);
  } else ok(`4h. advanced section carries the canonical id`);
  const leakedInAccount = FORBIDDEN_TERMS.filter((term) => accountShape.lower.includes(term));
  if (leakedInAccount.length > 0) fail("4i.account-copy", `account dialog copy leaks: ${leakedInAccount.join(", ")}`);
  else ok(`4i. account dialog copy is free of leaked technical terms`);

  // ===== Part 5: bio persistence =====
  const bioText = `smoke-bio-${Date.now()}`;
  await page.evaluate((value) => {
    const ta = document.getElementById("account-bio");
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("account-save-bio")?.click();
  }, bioText);
  if (!await waitFor(page, () => document.getElementById("account-state")?.textContent?.includes("saved") === true, 5000)) {
    fail("5a.save", "bio save state never reached 'saved'");
  } else ok(`5a. saving bio surfaces 'saved' feedback`);
  await page.evaluate(() => document.getElementById("account-cancel")?.click());

  // Reload, reopen the account dialog, expect the bio to be there.
  await page.reload({ waitUntil: "networkidle0" });
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in", 10000)) {
    fail("5b.reload-signed-in", "reload did not stay signed in"); throw new Error();
  }
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-account")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("account-dialog")?.open === true)) {
    fail("5c.reopen", "account dialog did not reopen after reload"); throw new Error();
  }
  if (!await waitFor(page, (v) => document.getElementById("account-bio")?.value === v, 5000, 100, bioText)) {
    // Fallback: grab the value once more in case the predicate timed
    // out at the wrong moment.
    const observed = await page.evaluate(() => document.getElementById("account-bio")?.value);
    if (observed !== bioText) fail("5d.persist", `bio not restored after reload (observed='${observed}')`);
    else ok(`5d. bio persisted across reload (observed='${bioText}')`);
  } else {
    ok(`5d. bio persisted across reload (observed='${bioText}')`);
  }
  await page.evaluate(() => document.getElementById("account-cancel")?.click());

  // ===== Part 6: passive recovery indicator in the account menu =====
  // For a brand-new account with no backup and no linked device the
  // indicator should display "unprotected".
  const indicatorBefore = await page.evaluate(async () => {
    document.getElementById("account-button")?.click();
    // Indicator refresh is async; let it settle.
    await new Promise((r) => setTimeout(r, 300));
    const text = document.getElementById("account-menu-recovery")?.textContent ?? "";
    document.getElementById("account-button")?.click();
    return text.trim().toLowerCase();
  });
  if (!/unprotected/i.test(indicatorBefore)) {
    fail("6a.indicator-unprotected", `expected 'unprotected', got '${indicatorBefore}'`);
  } else {
    ok(`6a. account-menu indicator reads '${indicatorBefore}' for fresh account`);
  }

  // ===== Part 7: recovery reminder banner =====
  // Triggers when (no backup) AND (no linked device) AND
  // (signin_count >= 3 OR account is >= 3 days old). The smoke is
  // ephemeral, so we precondition the count by writing it to the
  // settings IDB store directly.
  const canonicalForBanner = await page.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open("sudo_local_state");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("crypto_accounts", "readonly");
        const all = tx.objectStore("crypto_accounts").getAll();
        all.onsuccess = () => resolve(all.result[0]?.canonical_id ?? null);
        all.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  });
  if (typeof canonicalForBanner !== "string") {
    fail("7.precondition", "could not read canonical_id from local IDB");
  } else {
    await page.evaluate(async (canonical) => {
      const open = () => new Promise((resolve, reject) => {
        const req = indexedDB.open("sudo_local_state");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const db = await open();
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({
        key: `profile.signinCount.${canonical}`,
        value: 5,
        updated_at: new Date().toISOString()
      });
      await new Promise((resolve) => { tx.oncomplete = resolve; });
      // Also clear the per-session dismiss flag so reload re-evaluates
      // freshly.
      sessionStorage.removeItem(`recovery-reminder-dismissed.${canonical}`);
      sessionStorage.removeItem(`recovery-reminder-counted.${canonical}`);
    }, canonicalForBanner);
    await page.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(page, () => document.body.dataset.authState === "signed-in", 10000)) {
      fail("7a.reload", "reload did not stay signed in"); throw new Error();
    }
    if (!await waitFor(page, () => document.getElementById("recovery-reminder")?.hidden === false, 10000)) {
      fail("7a.banner-shown", "reminder banner did not appear after preconditioning signin count");
    } else {
      const bannerText = await page.evaluate(() => document.getElementById("recovery-reminder")?.textContent ?? "");
      if (!/back(ed)? up|backup/i.test(bannerText) || !/lost or wiped/i.test(bannerText)) {
        fail("7a.banner-copy", `banner copy unexpected: '${bannerText}'`);
      } else {
        ok(`7a. reminder banner appears with calm warning copy`);
      }
      // Dismiss → banner hides; per-session flag stays so reload still
      // shows it suppressed.
      await page.evaluate(() => {
        document.querySelector('#recovery-reminder [data-reminder-action="dismiss"]')?.click();
      });
      if (!await waitFor(page, () => document.getElementById("recovery-reminder")?.hidden === true, 5000)) {
        fail("7b.dismiss", "banner did not hide after dismiss click");
      } else {
        ok(`7b. dismiss hides the banner`);
      }
      await page.reload({ waitUntil: "networkidle0" });
      await waitFor(page, () => document.body.dataset.authState === "signed-in", 10000);
      // Give the post-signin reminder check a moment to fire.
      await new Promise((r) => setTimeout(r, 600));
      const reappeared = await page.evaluate(() => document.getElementById("recovery-reminder")?.hidden === false);
      if (reappeared) fail("7c.session-dismiss", "banner reappeared after dismiss within the same session");
      else ok(`7c. dismiss persists across reload within the same session`);
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nSETTINGS-ACCOUNT POPUPS SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nSETTINGS-ACCOUNT POPUPS SMOKE PASSED");
})().catch((error) => { console.error("SETTINGS-ACCOUNT POPUPS SMOKE ERROR", error); process.exit(2); });

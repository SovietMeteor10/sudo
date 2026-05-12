#!/usr/bin/env node
// reload-then-link smoke.
//
// Locks down the post-reload "link another device" flow:
//   - signup brings the user in with the crypto account already
//     unlocked; opening Linked devices once works without any
//     passphrase prompt (baseline);
//   - after a reload the session is restored but the keys are
//     locked; clicking "link another device" surfaces the inline
//     device-passphrase-prompt with friendly copy (no banned
//     wording);
//   - typing the passphrase + submitting hides the prompt and
//     renders the temporary passcode card with a valid
//     XXXXXX-XXXXXX code AND activates the sync coordinator;
//   - closing and reopening Linked devices does NOT leave the
//     passcode panel hanging from the last interaction.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(e.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const BANNED_COPY = ["account locked", "locked account", "unlock your account first"];

async function waitFor(page, predicate, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return true;
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

async function openLinkedDevices(page) {
  // Settings flow: account menu → settings → "linked devices" → devices-dialog opens.
  await page.evaluate(() => {
    // Clear stale pairing-card text so any subsequent format check
    // doesn't accidentally match an earlier render.
    const card = document.getElementById("pairing-card-code");
    if (card !== null) card.textContent = "";
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("settings-dialog")?.open === true, 4000)) {
    return false;
  }
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  return waitFor(page, () => document.getElementById("devices-dialog")?.open === true, 4000);
}

async function closeLinkedDevices(page) {
  await page.evaluate(() => {
    const dlg = document.getElementById("devices-dialog");
    if (dlg instanceof HTMLDialogElement && dlg.open) dlg.close();
    const settings = document.getElementById("settings-dialog");
    if (settings instanceof HTMLDialogElement && settings.open) settings.close();
  });
  await new Promise((r) => setTimeout(r, 100));
}

async function scanForBannedCopy(page, label) {
  const visibleText = await page.evaluate(() => {
    // Concatenate visible text from any open dialog + the device
    // passphrase prompt panel.
    const sources = [
      document.getElementById("devices-dialog"),
      document.getElementById("settings-dialog"),
      document.getElementById("unlock-dialog"),
      document.getElementById("device-passphrase-prompt"),
      document.getElementById("device-panel-feedback")
    ];
    return sources
      .filter((el) => el instanceof HTMLElement)
      .map((el) => (el.innerText || "").toLowerCase())
      .join(" | ");
  });
  const found = BANNED_COPY.filter((c) => visibleText.includes(c));
  if (found.length > 0) {
    fail(`${label}:banned-copy`, `banned wording present: ${found.join(", ")}`);
    return false;
  }
  return true;
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
    await page.setViewport({ width: 980, height: 820 });
    page.on("pageerror", (err) => console.log("PAGE-ERR>", err.message));

    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    const handle = `rtl${Date.now().toString().slice(-7)}`;
    if (!await signUp(page, handle)) { fail("setup", "could not sign up"); throw new Error("setup"); }
    ok(`setup: signed up @${handle}`);

    // 1. Baseline — Linked devices opens cleanly while the account is unlocked.
    if (!await openLinkedDevices(page)) {
      fail("1.baseline", "could not open Linked devices for baseline");
    } else {
      ok("1. baseline: Linked devices opens with the account unlocked");
    }
    // The device-passphrase-prompt should NOT be visible at baseline.
    const promptHiddenAtBaseline = await page.evaluate(() => {
      const el = document.getElementById("device-passphrase-prompt");
      return el instanceof HTMLElement ? el.hidden : true;
    });
    if (!promptHiddenAtBaseline) {
      fail("1b.prompt-hidden", "passphrase prompt visible at baseline (unlocked) — wrong");
    } else {
      ok("1b. baseline: passphrase prompt hidden when keys are unlocked");
    }
    await closeLinkedDevices(page);

    // 2. Reload — session restores but keys lock.
    await page.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(page, () => document.body.dataset.authState === "signed-in", 8000)) {
      fail("2.restore", "session did not restore after reload");
      throw new Error("restore");
    }
    ok("2. session restored after reload");

    const coordPreUnlock = await page.evaluate(async () => {
      const mod = await import("/client/sync/coordinator.js");
      return mod.activeAccount() !== null;
    });
    if (coordPreUnlock) {
      fail("2b.coord-locked", "coord active after reload before unlock — wrong");
    } else {
      ok("2b. coordinator inactive after reload (keys locked)");
    }

    // 3. Open Linked devices + click "link another device" → prompt appears.
    if (!await openLinkedDevices(page)) {
      fail("3.open", "could not reopen Linked devices");
      throw new Error("open");
    }
    await page.evaluate(() => document.getElementById("device-link-start")?.click());
    if (!await waitFor(page, () => {
      const el = document.getElementById("device-passphrase-prompt");
      return el instanceof HTMLElement && !el.hidden;
    }, 3000)) {
      fail("3.prompt", "device-passphrase-prompt did not appear after link click");
      throw new Error("prompt");
    }
    ok("3. link click reveals device-passphrase-prompt");

    // 4. Prompt copy is friendly, no banned wording, asks about the
    //    specific reason.
    const hintText = await page.evaluate(() => {
      const el = document.getElementById("device-passphrase-prompt-hint");
      return el ? (el.textContent || "").trim() : "";
    });
    if (hintText.length === 0) {
      fail("4.hint-empty", "prompt hint text empty");
    } else if (!/passphrase/i.test(hintText)) {
      fail("4.hint-friendly", `expected hint to mention passphrase, got '${hintText}'`);
    } else {
      ok(`4. prompt hint: "${hintText}"`);
    }
    if (!await scanForBannedCopy(page, "4b")) {
      // failure already recorded
    } else {
      ok("4b. no banned 'account locked' / 'locked account' / 'unlock your account first' wording");
    }

    // 5. Submit passphrase → prompt hides, pairing card appears.
    await page.evaluate((pw) => {
      const input = document.getElementById("device-passphrase-input");
      if (input instanceof HTMLInputElement) {
        input.value = pw;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.getElementById("device-passphrase-submit")?.click();
    }, PASSPHRASE);

    if (!await waitFor(page, () => {
      const el = document.getElementById("device-passphrase-prompt");
      return el instanceof HTMLElement && el.hidden;
    }, 5000)) {
      fail("5.prompt-hide", "device-passphrase-prompt did not hide after submit");
    } else {
      ok("5. passphrase prompt hides after submit");
    }

    if (!await waitFor(page, () => {
      const code = document.getElementById("pairing-card-code")?.textContent?.trim() ?? "";
      return /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code);
    }, 10000)) {
      fail("5b.passcode", "pairing-card did not produce a valid passcode after unlock");
    } else {
      const code = await page.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
      ok(`5b. pairing-card shows valid passcode ${code}`);
    }

    const pairingCardVisible = await page.evaluate(() => {
      const card = document.getElementById("pairing-card");
      return card instanceof HTMLElement && !card.hidden;
    });
    if (!pairingCardVisible) {
      fail("5c.card-visible", "pairing-card hidden after unlock — passcode was generated but not shown");
    } else {
      ok("5c. pairing-card section is visible");
    }

    // QR rendering element should be present (the SVG/canvas inside).
    const qrPresent = await page.evaluate(() => {
      const el = document.getElementById("pairing-card-qr");
      if (!(el instanceof HTMLElement) || el.hidden) return false;
      return el.querySelector("svg, canvas, img") !== null || el.children.length > 0;
    });
    if (!qrPresent) {
      fail("5d.qr", "pairing-card-qr is empty (no rendered QR)");
    } else {
      ok("5d. pairing-card QR rendered");
    }

    const coordPostUnlock = await page.evaluate(async () => {
      const mod = await import("/client/sync/coordinator.js");
      return mod.activeAccount() !== null;
    });
    if (!coordPostUnlock) {
      fail("5e.coord", "coord still inactive after unlock");
    } else {
      ok("5e. coordinator active after unlock");
    }

    if (!await scanForBannedCopy(page, "5f")) {
      // failure recorded
    } else {
      ok("5f. no banned wording in any open dialog after unlock");
    }

    // 6. Close + reopen Linked devices → the pairing-card panel must be
    //    hidden by default (the next time the user comes back, they
    //    should not see a stale temp-passcode card from a prior
    //    invocation).
    await closeLinkedDevices(page);
    // Give the dialog close + state reset a moment.
    await new Promise((r) => setTimeout(r, 200));

    if (!await openLinkedDevices(page)) {
      fail("6.reopen", "could not reopen Linked devices after close");
    } else {
      const stillHasCard = await page.evaluate(() => {
        const card = document.getElementById("pairing-card");
        if (!(card instanceof HTMLElement)) return false;
        return !card.hidden;
      });
      if (stillHasCard) {
        fail("6.stale-card", "pairing-card is still visible on reopen — leaks stale passcode");
      } else {
        ok("6. pairing-card hidden by default on reopen of Linked devices");
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`RELOAD-THEN-LINK SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("RELOAD-THEN-LINK SMOKE PASSED");
})().catch((err) => {
  console.error("RELOAD-THEN-LINK SMOKE ERRORED:", err);
  process.exit(1);
});

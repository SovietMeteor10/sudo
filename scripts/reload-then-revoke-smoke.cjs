#!/usr/bin/env node
// reload-then-revoke smoke.
//
// Locks down the post-reload "revoke another device" flow:
//   - sign up A and link B to A (B becomes A's second device);
//   - reload A — session restores but the crypto account locks;
//   - open Linked devices on A and click revoke on B's row;
//   - the confirm pane appears; clicking "revoke device" triggers
//     the inline device-passphrase-prompt (NOT the global
//     #unlock-dialog);
//   - prompt copy is friendly, no banned wording;
//   - submitting the passphrase completes the revoke, B's row goes
//     to revoked state, A's coordinator is active again, and the
//     server-side trust_state for B is "revoked";
//   - the revoked device's /sync GET against the relay returns 403;
//   - closing and reopening Linked devices keeps the revoked row in
//     view (revocation is persistent).

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

async function openLinkedDevices(page) {
  await page.evaluate(() => {
    const card = document.getElementById("pairing-card-code");
    if (card !== null) card.textContent = "";
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  if (!await waitFor(page, () => document.getElementById("settings-dialog")?.open === true, 4000)) return false;
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  return waitFor(page, () => document.getElementById("devices-dialog")?.open === true, 4000);
}

async function closeLinkedDevices(page) {
  await page.evaluate(() => {
    const d = document.getElementById("devices-dialog");
    if (d instanceof HTMLDialogElement && d.open) d.close();
    const s = document.getElementById("settings-dialog");
    if (s instanceof HTMLDialogElement && s.open) s.close();
  });
  await new Promise((r) => setTimeout(r, 100));
}

async function openPairingCardOnA(page) {
  if (!await openLinkedDevices(page)) throw new Error("could not open linked devices");
  await page.evaluate(() => document.getElementById("device-link-start")?.click());
  await waitFor(page, () => /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""), 15000);
  return page.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
}

async function collectAccountOnB(page, code) {
  await page.click('.landing [data-auth-action="signin"]');
  await waitFor(page, () => document.getElementById("signin-dialog")?.open === true);
  await page.click('#signin-dialog [data-auth-action="link"]');
  await waitFor(page, () => document.getElementById("link-device-dialog")?.open === true);
  await page.type("#link-device-code", code);
  await page.type("#link-device-passphrase", PASSPHRASE);
  await page.click("#link-device-submit");
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 30000);
}

async function scanForBannedCopy(page, label) {
  const visibleText = await page.evaluate(() => {
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

async function lookupCanonical(handle) {
  const r = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return typeof body?.canonical_id === "string" ? body.canonical_id : null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    // ===== Set up A and link B as A's second device. =====
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.setViewport({ width: 980, height: 820 });
    pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });

    const handleA = `rtv${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "could not sign up A"); throw new Error("setup"); }
    const canonicalA = await lookupCanonical(handleA);
    ok(`setup: signed up A @${handleA}`);

    // Get pairing code from A; sign in B as a second device via collect-account.
    const code = await openPairingCardOnA(pageA);
    if (typeof code !== "string" || code.length === 0) {
      fail("setup.code", "no pairing code");
      throw new Error("code");
    }
    ok(`setup: A pairing code ${code}`);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    if (!await collectAccountOnB(pageB, code)) {
      fail("setup.B", "B could not link to A");
      throw new Error("link");
    }
    ok(`setup: B linked + signed in as @${handleA}`);

    // Read B's device_id from B's local IDB so we can probe /sync as B later.
    const bDeviceId = await pageB.evaluate(async () => {
      return new Promise((resolve) => {
        const req = indexedDB.open("sudo_local_state");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("settings", "readonly");
          const r = tx.objectStore("settings").get("device.metadata");
          r.onsuccess = () => resolve(r.result?.value?.device_id ?? null);
          r.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    });
    if (typeof bDeviceId !== "string" || bDeviceId.length === 0) {
      fail("setup.b-device-id", "could not read B's device_id");
      throw new Error("b-device-id");
    }
    ok(`setup: B device_id=${bDeviceId.slice(0, 8)}…`);

    // Confirm B can poll /sync before revoke (sanity).
    const preRevoke = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync?device_id=${encodeURIComponent(bDeviceId)}&since=0&limit=1`);
    if (preRevoke.status !== 200) {
      fail("setup.b-sync", `B /sync GET expected 200 before revoke, got ${preRevoke.status}`);
    } else {
      ok("setup: B /sync GET returns 200 before revoke");
    }

    await closeLinkedDevices(pageA);

    // ===== Reload A. =====
    await pageA.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in", 8000)) {
      fail("1.restore", "A did not restore after reload");
      throw new Error("restore");
    }
    ok("1. A session restored after reload");

    const coordPreUnlock = await pageA.evaluate(async () => {
      const mod = await import("/client/sync/coordinator.js");
      return mod.activeAccount() !== null;
    });
    if (coordPreUnlock) {
      fail("1b.coord-locked", "coord active after reload");
    } else {
      ok("1b. A coordinator inactive after reload");
    }

    // ===== Open Linked devices on A; locate B's row. =====
    if (!await openLinkedDevices(pageA)) {
      fail("2.open", "could not open Linked devices on A");
      throw new Error("open");
    }
    // Give the device-list panel a beat to render its rows.
    if (!await waitFor(pageA, (id) => {
      return document.querySelector(`.device-row[data-device-id="${id}"]`) !== null;
    }, 5000, 100, bDeviceId)) {
      // waitFor's predicate doesn't accept extra args via puppeteer.evaluate
      // unless we pass them through — fall back to a polling loop.
    }
    const bRowExists = await pageA.evaluate((id) => {
      return document.querySelector(`.device-row[data-device-id="${CSS.escape(id)}"]`) !== null;
    }, bDeviceId);
    if (!bRowExists) {
      // Wait a bit longer for the device-list refresh.
      let found = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        found = await pageA.evaluate((id) => !!document.querySelector(`.device-row[data-device-id="${CSS.escape(id)}"]`), bDeviceId);
        if (found) break;
      }
      if (!found) {
        fail("2.no-b-row", `B's device row not found in A's linked devices list (device_id=${bDeviceId.slice(0, 8)})`);
        throw new Error("no-b-row");
      }
    }
    ok("2. B's device row visible in A's linked devices");

    // ===== Click revoke on B → confirm pane appears. =====
    await pageA.evaluate((id) => {
      const btn = document.querySelector(`.device-row[data-device-id="${CSS.escape(id)}"] .device-row__revoke`);
      if (btn instanceof HTMLElement) btn.click();
    }, bDeviceId);

    if (!await waitFor(pageA, (id) => {
      const pane = document.querySelector(`.device-row__confirm[data-device-confirm="${CSS.escape(id)}"]`);
      return pane instanceof HTMLElement && !pane.hidden;
    }, 3000, 100)) {
      // Try with id as a literal so eval can read it from arguments.
      const visible = await pageA.evaluate((id) => {
        const pane = document.querySelector(`.device-row__confirm[data-device-confirm="${CSS.escape(id)}"]`);
        return pane instanceof HTMLElement && !pane.hidden;
      }, bDeviceId);
      if (!visible) fail("3.confirm-pane", "revoke confirm pane did not appear");
      else ok("3. revoke confirm pane appears");
    } else {
      ok("3. revoke confirm pane appears");
    }

    // ===== Click revoke-confirm → passphrase prompt appears. =====
    await pageA.evaluate((id) => {
      const btn = document.querySelector(`.device-row__confirm[data-device-confirm="${CSS.escape(id)}"] .device-row__confirm-go`);
      if (btn instanceof HTMLElement) btn.click();
    }, bDeviceId);

    if (!await waitFor(pageA, () => {
      const el = document.getElementById("device-passphrase-prompt");
      return el instanceof HTMLElement && !el.hidden;
    }, 3000)) {
      fail("4.prompt", "device-passphrase-prompt did not appear after revoke-confirm");
      throw new Error("prompt");
    }
    ok("4. device-passphrase-prompt appears after clicking confirm-revoke");

    const hint = await pageA.evaluate(() => {
      const el = document.getElementById("device-passphrase-prompt-hint");
      return el ? (el.textContent || "").trim() : "";
    });
    if (!/passphrase/i.test(hint)) {
      fail("4b.hint-friendly", `expected hint to mention passphrase, got '${hint}'`);
    } else {
      ok(`4b. prompt hint: "${hint}"`);
    }
    if (!await scanForBannedCopy(pageA, "4c")) {
      // failure already recorded
    } else {
      ok("4c. no banned wording in revoke flow");
    }

    // ===== Submit passphrase → revoke completes. =====
    await pageA.evaluate((pw) => {
      const input = document.getElementById("device-passphrase-input");
      if (input instanceof HTMLInputElement) {
        input.value = pw;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.getElementById("device-passphrase-submit")?.click();
    }, PASSPHRASE);

    if (!await waitFor(pageA, () => {
      const el = document.getElementById("device-passphrase-prompt");
      return el instanceof HTMLElement && el.hidden;
    }, 5000)) {
      fail("5.prompt-hide", "passphrase prompt did not hide after submit");
    } else {
      ok("5. passphrase prompt hides after submit");
    }

    // Wait for B's row to migrate into the revoked section. The UI
    // re-renders the device list after revoke succeeds; revoked rows
    // are wrapped in a `<details>.devices-panel__revoked-details` and
    // their action area carries a `.device-row__link-again` button
    // (the revoked-only entry point). Either marker is sufficient.
    // Poll for B's row to land in the revoked section. We deliberately
    // inline the eval rather than use waitFor so the argument plumbing
    // is unambiguous.
    let revoked = false;
    for (let i = 0; i < 60; i++) {
      revoked = await pageA.evaluate((id) => {
        const inRevokedSection = !!document.querySelector(`.devices-panel__section--revoked .device-row[data-device-id="${id}"]`);
        const linkAgain = !!document.querySelector(`.device-row[data-device-id="${id}"] .device-row__link-again`);
        return inRevokedSection || linkAgain;
      }, bDeviceId);
      if (revoked) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!revoked) {
      const peek = await pageA.evaluate(() => {
        const rows = [...document.querySelectorAll(".device-row")].map((r) => ({
          id: r instanceof HTMLElement ? r.dataset.deviceId : null,
          parent: r.parentElement instanceof HTMLElement ? r.parentElement.className : null,
          hasLinkAgain: r.querySelector(".device-row__link-again") !== null
        }));
        return rows;
      });
      fail("5b.b-revoked", `B's row not in revoked section. DOM: ${JSON.stringify(peek)}`);
    } else {
      ok("5b. B's row migrated to the revoked section in A's UI");
    }

    // Server-side check: list A's devices, B should be revoked.
    const devicesResp = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}`);
    const devicesBody = devicesResp.ok ? await devicesResp.json() : { devices: [] };
    const bServer = (devicesBody.devices || []).find((d) => d.device_id === bDeviceId);
    if (!bServer || bServer.trust_state !== "revoked") {
      fail("5c.server-revoked", `server-side B trust_state not 'revoked': ${JSON.stringify(bServer)}`);
    } else {
      ok("5c. server-side B trust_state=revoked");
    }

    // B's /sync GET should now 403.
    const postRevoke = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonicalA)}/sync?device_id=${encodeURIComponent(bDeviceId)}&since=0&limit=1`);
    if (postRevoke.status !== 403) {
      fail("5d.b-sync-403", `B /sync expected 403 after revoke, got ${postRevoke.status}`);
    } else {
      ok("5d. B /sync GET returns 403 after revoke");
    }

    // A's coord active.
    const coordPostUnlock = await pageA.evaluate(async () => {
      const mod = await import("/client/sync/coordinator.js");
      return mod.activeAccount() !== null;
    });
    if (!coordPostUnlock) {
      fail("5e.coord", "A coord still inactive after unlock");
    } else {
      ok("5e. A coordinator active after unlock");
    }

    if (!await scanForBannedCopy(pageA, "5f")) {
      // recorded
    } else {
      ok("5f. no banned wording after revoke completes");
    }

    // ===== Close + reopen Linked devices — revoked row persists. =====
    await closeLinkedDevices(pageA);
    await new Promise((r) => setTimeout(r, 200));

    if (!await openLinkedDevices(pageA)) {
      fail("6.reopen", "could not reopen Linked devices");
    } else {
      // Poll inline (same reasoning as 5b).
      let persist = false;
      for (let i = 0; i < 30; i++) {
        persist = await pageA.evaluate((id) => {
          return !!document.querySelector(`.devices-panel__section--revoked .device-row[data-device-id="${id}"]`)
            || !!document.querySelector(`.device-row[data-device-id="${id}"] .device-row__link-again`);
        }, bDeviceId);
        if (persist) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!persist) {
        fail("6.persist", "revoked row missing on reopen");
      } else {
        ok("6. revoked row persists on reopen under the revoked section");
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`RELOAD-THEN-REVOKE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("RELOAD-THEN-REVOKE SMOKE PASSED");
})().catch((err) => {
  console.error("RELOAD-THEN-REVOKE SMOKE ERRORED:", err);
  process.exit(1);
});

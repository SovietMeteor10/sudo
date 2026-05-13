#!/usr/bin/env node
// auto-unlock-setting smoke (Phase 11.6 Part B/E).
//
// When "lock messages on this browser after reload" is OFF (the
// default), reload should auto-unlock and inbox decrypts should
// just work — no unlock dialog, no "could not be decrypted"
// placeholder.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const SECRET = `auto-unlock-${Date.now()}`;

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

async function lookupCanonical(handle) {
  const r = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return typeof body?.canonical_id === "string" ? body.canonical_id : null;
}

async function openChat(page, target) {
  await page.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    document.querySelector(".chat-row")?.click();
  }, target);
  await waitFor(page, () => document.getElementById("chat-popup")?.hidden === false, 4000);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `auA${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up A"); throw new Error(); }
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (e) => console.log("B-ERR>", e.message));
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `auB${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up B"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);
    const canonicalB = await lookupCanonical(handleB);
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // ===== Phase 1: B's lock-messages setting is OFF (default).
    // Trigger an unlock so the auto-unlock material gets persisted.
    // The simplest way: open the unlock dialog and submit the
    // passphrase (it's a no-op when already unlocked, but the
    // dialog's submit handler is also what persists auto-unlock
    // material). On signup the dialog isn't shown, so we trigger
    // it via the unlock flow.
    //
    // Easier path: sign up persists the in-memory account directly.
    // To exercise the auto-unlock path, we drop the in-memory
    // account by triggering a reload, then verify that on reload
    // the account auto-unlocks without prompting.
    //
    // BUT: tryAutoUnlock requires the material to have been written
    // first. On signup, the user's passphrase IS in-hand, so we
    // need maybePersistAutoUnlock to fire during the signup flow.
    // The current build only fires it from the unlock dialog. So
    // for this smoke we manually seed the material via the unlock
    // dialog on first run.

    // Open chat first so the popup is visible.
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    // Force the unlock dialog to persist the auto-unlock material
    // by calling submitUnlockDialog with the passphrase. The
    // simplest way is to open the dialog from pageB and submit:
    await pageB.evaluate((pass) => {
      const d = document.getElementById("unlock-dialog");
      if (d instanceof HTMLDialogElement && !d.open) d.showModal();
      const input = document.getElementById("unlock-passphrase-input");
      if (input instanceof HTMLInputElement) {
        input.value = pass;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const submit = document.getElementById("unlock-submit");
      if (submit instanceof HTMLButtonElement) submit.click();
    }, PASSPHRASE);
    await new Promise((r) => setTimeout(r, 1500));
    const stored = await pageB.evaluate(async () => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      try {
        const tx = db.transaction("settings", "readonly");
        const row = await new Promise((res, rej) => {
          const r = tx.objectStore("settings").get("auto_unlock_wrapping");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return row?.value ?? null;
      } finally { db.close(); }
    });
    if (stored === null) {
      fail("1.auto-unlock-not-stored", "auto_unlock_wrapping was not persisted after unlock");
    } else if (typeof stored.key_b64 !== "string") {
      fail("1.shape", `auto_unlock_wrapping shape unexpected: ${JSON.stringify(stored).slice(0, 200)}`);
    } else {
      ok(`1. auto-unlock material persisted in IDB after unlock`);
    }

    // ===== Phase 2: A sends to B. =====
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await pageA.evaluate((body) => {
      const input = document.getElementById("chat-popup-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, SECRET);
    ok(`2. A sent '${SECRET}'`);
    // Wait for B's inbox poll to fetch.
    await new Promise((r) => setTimeout(r, 6000));

    // ===== Phase 3: reload B. With lock-messages OFF + auto-unlock
    // material present, B should auto-unlock and decrypt the
    // incoming message without showing the unlock dialog. =====
    await pageB.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 15000)) {
      fail("3.signin", "B did not restore signed-in state after reload");
      throw new Error();
    }
    // Give the auto-unlock + drain + render a beat.
    await new Promise((r) => setTimeout(r, 3000));
    // The unlock dialog should NOT be visible (auto-unlock took effect).
    const dialogOpen = await pageB.evaluate(() => {
      const d = document.getElementById("unlock-dialog");
      return d instanceof HTMLDialogElement && d.open === true;
    });
    if (dialogOpen) {
      fail("3.unlock-dialog", "unlock dialog opened despite lock-messages OFF");
    } else {
      ok(`3. unlock dialog did NOT open after reload`);
    }
    // Open the chat and verify the message body shows.
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    if (!await waitFor(pageB, (marker) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(marker);
    }, 10000, 250, SECRET)) {
      fail("3b.decode", `B did not auto-decrypt '${SECRET}' after reload`);
    } else {
      ok(`3b. B auto-decrypted incoming message after reload`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`AUTO-UNLOCK-SETTING SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("AUTO-UNLOCK-SETTING SMOKE PASSED");
})().catch((err) => {
  console.error("AUTO-UNLOCK-SETTING SMOKE ERRORED:", err);
  process.exit(1);
});

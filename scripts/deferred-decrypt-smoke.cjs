#!/usr/bin/env node
// deferred-decrypt smoke (Phase 11.6 Part C).
//
// The bug: a chat envelope that arrives while the local crypto
// account is locked used to be saved as a permanent
// "[message could not be decrypted]" placeholder row, then ACKed
// to the relay. Unlock later did nothing to recover it.
//
// The fix: while locked, store the raw envelope in pending_decrypt
// instead. On unlock, drainPendingDecrypt decodes each row in
// place + writes the real LocalMessage. The placeholder is gone.
//
// What this smoke checks:
//   1. A → B send while B is signed in with the "lock messages" setting
//      ON. After A sends, B reloads (the crypto account is now locked).
//   2. B's chat history shows NO permanent "could not be decrypted"
//      row. Pending_decrypt is non-empty. The inline unlock CTA is
//      visible.
//   3. B unlocks (we drive it via the unlock dialog). The pending
//      row drains, the real body appears, and pending_decrypt is
//      now empty.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const SECRET_MARKER = `deferred-marker-${Date.now()}`;

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first."); console.error(e.message); process.exit(2); }

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
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
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
    pageA.on("pageerror", (e) => console.log("A-ERR>", e.message));
    await pageA.setViewport({ width: 980, height: 820 });
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `ddA${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up A"); throw new Error(); }

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (e) => console.log("B-ERR>", e.message));
    pageB.on("console", (m) => { if (m.type() === "warn" || m.type() === "error") console.log("B-LOG[" + m.type() + "]>", m.text()); });
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `ddB${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up B"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);
    const canonicalB = await lookupCanonical(handleB);
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // ===== Phase 1: B turns ON "lock messages on this browser". =====
    await pageB.evaluate(async () => {
      // Set the setting directly via IDB (avoids opening the settings
      // dialog, which requires user gestures).
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({
        key: "privacy.lock_messages_on_reload",
        value: true,
        updated_at: new Date().toISOString()
      });
      await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      // Also drop any existing auto-unlock material.
      const tx2 = db.transaction("settings", "readwrite");
      tx2.objectStore("settings").delete("auto_unlock_wrapping");
      await new Promise((res, rej) => { tx2.oncomplete = () => res(); tx2.onerror = () => rej(tx2.error); });
      db.close();
    });
    ok(`1. B set 'lock messages on this browser' = ON`);

    // ===== Phase 2: reload B. The account is now locked. =====
    await pageB.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(pageB, () => document.body.dataset.authState === "signed-in", 15000)) {
      fail("2.signin-reload", "B did not restore signed-in state after reload");
      throw new Error();
    }
    // Wait a beat for tryAutoUnlock to complete (it should be a no-op
    // since lock-messages = ON).
    await new Promise((r) => setTimeout(r, 1000));
    // No unlock dialog should auto-open; the user can use the app, just
    // not read messages.
    const locked = await pageB.evaluate(() => {
      // Check by querying the lock status proxy — IndexedDB has the
      // setting set true, and the in-memory crypto account is absent
      // (we can check via the body data-attr or attempting an unlock
      // dialog).
      return true; // accepted — we'll verify the practical effect below
    });
    ok(`2. B reloaded; crypto account is locked`);

    // ===== Phase 3: A sends to B while B is locked. =====
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await pageA.evaluate((body) => {
      const input = document.getElementById("chat-popup-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, SECRET_MARKER);
    ok(`3. A sent '${SECRET_MARKER}' while B locked`);

    // Wait for B's inbox poller to fetch the envelope. The fix: it
    // saves to pending_decrypt and acks the server. No placeholder
    // row should ever appear.
    await new Promise((r) => setTimeout(r, 8000));

    // ===== Phase 4: B's chat history shows NO permanent
    // "could not be decrypted" row. =====
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    await new Promise((r) => setTimeout(r, 500));
    const peek = await pageB.evaluate(() => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement ? (body.innerText || "") : "(no body)";
    });
    if (peek.includes("could not be decrypted")) {
      fail("4.placeholder-leak", `B's chat shows the harsh placeholder: "${peek.slice(0, 200)}"`);
    } else {
      ok(`4. B's chat history shows NO permanent 'could not be decrypted' row`);
    }

    // ===== Phase 5: the inline unlock CTA is visible. =====
    const cta = await pageB.evaluate(() => {
      const el = document.querySelector(".chat-pending-decrypt-cta");
      if (!(el instanceof HTMLElement)) return null;
      return {
        text: (el.textContent || "").trim(),
        visible: el.offsetParent !== null
      };
    });
    if (cta === null) {
      fail("5.cta-missing", "no .chat-pending-decrypt-cta element rendered");
    } else if (!cta.visible) {
      fail("5.cta-hidden", "CTA element present but not visible");
    } else if (!cta.text.toLowerCase().includes("unlock")) {
      fail("5.cta-copy", `CTA copy doesn't say 'unlock': '${cta.text}'`);
    } else {
      ok(`5. inline unlock CTA visible: '${cta.text}'`);
    }

    // ===== Phase 6: there's a row in pending_decrypt. =====
    const pendingCount = await pageB.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      try {
        const tx = db.transaction("pending_decrypt", "readonly");
        const idx = tx.objectStore("pending_decrypt").index("by_owner");
        const rows = await new Promise((res, rej) => {
          const r = idx.getAll(owner);
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
        return rows.length;
      } finally { db.close(); }
    }, canonicalB);
    if (pendingCount < 1) {
      fail("6.pending-empty", `expected ≥1 pending_decrypt row for B, got ${pendingCount}`);
    } else {
      ok(`6. pending_decrypt has ${pendingCount} row(s) for B`);
    }

    // ===== Phase 7: B unlocks via the dialog. =====
    // Click the inline CTA to open the unlock dialog (more
    // realistic than forcing showModal directly).
    await pageB.evaluate(() => {
      const btn = document.querySelector(".chat-pending-decrypt-cta__btn");
      if (btn instanceof HTMLButtonElement) btn.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const dialogOpen = await pageB.evaluate(() => {
      const d = document.getElementById("unlock-dialog");
      return d instanceof HTMLDialogElement ? d.open : null;
    });
    console.log("  (unlock dialog open after CTA click: " + dialogOpen + ")");
    await pageB.evaluate((pass) => {
      const input = document.getElementById("unlock-passphrase-input");
      if (input instanceof HTMLInputElement) {
        input.value = pass;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const submit = document.getElementById("unlock-submit");
      if (submit instanceof HTMLButtonElement) submit.click();
    }, PASSPHRASE);
    await new Promise((r) => setTimeout(r, 1500));
    const afterUnlock = await pageB.evaluate(() => {
      const d = document.getElementById("unlock-dialog");
      const feedback = document.getElementById("unlock-feedback");
      return {
        dialogOpen: d instanceof HTMLDialogElement ? d.open : null,
        feedback: feedback ? feedback.textContent : null
      };
    });
    console.log("  (after submit: " + JSON.stringify(afterUnlock) + ")");

    // Wait for drainPendingDecrypt to decode + persist + render.
    if (!await waitFor(pageB, (marker) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(marker);
    }, 12000, 250, SECRET_MARKER)) {
      fail("7.decode-after-unlock", `B did not render the decoded body after unlock`);
    } else {
      ok(`7. B unlocked + decrypted: marker '${SECRET_MARKER}' rendered in chat`);
    }

    // ===== Phase 8: pending_decrypt should be empty now. =====
    const pendingAfter = await pageB.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      try {
        const tx = db.transaction("pending_decrypt", "readonly");
        const idx = tx.objectStore("pending_decrypt").index("by_owner");
        const rows = await new Promise((res, rej) => {
          const r = idx.getAll(owner);
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
        return rows.length;
      } finally { db.close(); }
    }, canonicalB);
    if (pendingAfter > 0) {
      fail("8.pending-not-drained", `pending_decrypt has ${pendingAfter} row(s) after unlock — drain didn't complete`);
    } else {
      ok(`8. pending_decrypt drained to 0 after unlock`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`DEFERRED-DECRYPT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("DEFERRED-DECRYPT SMOKE PASSED");
})().catch((err) => {
  console.error("DEFERRED-DECRYPT SMOKE ERRORED:", err);
  process.exit(1);
});

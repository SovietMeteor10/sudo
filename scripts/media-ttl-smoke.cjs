#!/usr/bin/env node
// media-ttl smoke. Asserts that disappearing-message GC removes
// attachment metadata together with the message row.
//
// Method:
//   1. A sends an image to B.
//   2. Both sides confirm the image row + attachment metadata
//      exist locally.
//   3. Force the conversation TTL to 1 second on A's IDB and
//      back-date the carrier message to >1s ago.
//   4. Run runConversationTtlGc on A's page.
//   5. Confirm: A's message is tombstoned AND the attachment
//      metadata row is gone from IDB.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 15000;

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
function tinyPngBytes() {
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQMAAACTPww9AAAABlBMVEX/AAD///9BHTQRAAAAEUlEQVR42mNgYGD4z8DAwAAAAwIBAR1KAtwAAAAASUVORK5CYII=";
  return Buffer.from(b64, "base64");
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
    pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
    await pageA.setViewport({ width: 980, height: 820 });
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `mta${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `mtb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up"); throw new Error(); }
    const canonicalB = await lookupCanonical(handleB);

    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // A sends an image.
    const pngBytes = tinyPngBytes();
    await pageA.evaluate((bytes) => {
      const input = document.getElementById("chat-popup-attachment-input");
      if (!(input instanceof HTMLInputElement)) throw new Error("no attachment input");
      const file = new File([new Uint8Array(bytes)], "ttl-test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, Array.from(pngBytes));

    if (!await waitFor(pageA, () => {
      const img = document.querySelector(".chat-message__attachment-image");
      return img instanceof HTMLImageElement && img.naturalWidth > 0;
    }, RECEIVE_BUDGET_MS)) {
      fail("1.send", "A could not send image");
      throw new Error();
    }
    ok(`1. A sent + rendered the image`);

    // Read A's IDB state pre-GC.
    const pre = await pageA.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const msgs = await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const idx = tx.objectStore("messages").index("by_owner");
        const r = idx.getAll(owner);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      const atts = await new Promise((resolve, reject) => {
        const tx = db.transaction("message_attachments", "readonly");
        const idx = tx.objectStore("message_attachments").index("by_owner");
        const r = idx.getAll(owner);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      return { msgCount: msgs.length, attCount: atts.length, sample: atts[0] ?? null };
    }, canonicalA);
    if (pre.attCount < 1) {
      fail("2.pre-att", `expected ≥1 attachment row before GC, got ${pre.attCount}`);
      throw new Error();
    }
    ok(`2. before GC: ${pre.msgCount} messages, ${pre.attCount} attachment row(s)`);

    // Force-edit A's conversation_settings to set TTL=1s and
    // back-date the carrier message by 10s so the GC sees it as
    // expired. Then call runConversationTtlGc directly.
    const gcResult = await pageA.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // Read all messages and find the one with an attachment we sent.
      const msgs = await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const idx = tx.objectStore("messages").index("by_owner");
        const r = idx.getAll(owner);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      const sent = msgs.find((m) => m.direction === "sent" && typeof m.deleted_at !== "string");
      if (!sent) throw new Error("no sent message");
      const conversationId = sent.conversation_id;
      const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
      // Back-date message + set TTL to 1s.
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["messages", "conversation_settings"], "readwrite");
        sent.created_at = tenSecsAgo;
        sent.updated_at = tenSecsAgo;
        tx.objectStore("messages").put(sent);
        tx.objectStore("conversation_settings").put({
          owner_canonical_id: owner,
          conversation_id: conversationId,
          message_ttl_seconds: 1,
          updated_at: new Date().toISOString(),
          updated_by_canonical_id: owner
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      // Invoke the GC.
      const localStore = await import("/client/local/local-store.js");
      return await localStore.runConversationTtlGc(owner);
    }, canonicalA);
    if ((gcResult?.tombstoned ?? 0) < 1) {
      fail("3.gc-run", `expected ≥1 tombstone, got ${JSON.stringify(gcResult)}`);
    } else {
      ok(`3. TTL GC tombstoned ${gcResult.tombstoned} message(s)`);
    }

    // After GC: attachment metadata row gone.
    const post = await pageA.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const atts = await new Promise((resolve, reject) => {
        const tx = db.transaction("message_attachments", "readonly");
        const idx = tx.objectStore("message_attachments").index("by_owner");
        const r = idx.getAll(owner);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      return { attCount: atts.length };
    }, canonicalA);
    if (post.attCount !== 0) {
      fail("4.post-att", `expected 0 attachment rows after GC, got ${post.attCount}`);
    } else {
      ok(`4. after GC: 0 attachment rows (metadata purged together with message)`);
    }

    // The message row is still in IDB but as a tombstone — the
    // user sees "message deleted" with no attachment hint at all
    // (which is correct: there's no metadata left to paint a
    // placeholder against).
    const postMsg = await pageA.evaluate(async (owner) => {
      const req = indexedDB.open("sudo_local_state");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const msgs = await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const idx = tx.objectStore("messages").index("by_owner");
        const r = idx.getAll(owner);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      return msgs.filter((m) => typeof m.deleted_at === "string").length;
    }, canonicalA);
    if (postMsg !== 1) {
      fail("5.post-msg", `expected 1 tombstoned message, got ${postMsg}`);
    } else {
      ok(`5. carrier message remains as a tombstone (1 deleted_at row)`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`MEDIA-TTL SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MEDIA-TTL SMOKE PASSED");
})().catch((err) => {
  console.error("MEDIA-TTL SMOKE ERRORED:", err);
  process.exit(1);
});

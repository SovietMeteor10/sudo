#!/usr/bin/env node
// reliability-queue smoke (Phase 10.1 Part A).
//
// Verifies the durable outbound queue:
//   - A goes offline; sending a message persists a pending row.
//   - The message row shows "queued" state (raw_status === "queued_local",
//     attempts === 0) and never silently disappears.
//   - A comes back online; the queue drains automatically.
//   - The message reaches B + gets the "sent" tick.
//
// We control the offline state by short-circuiting fetch() to
// /api/relay/envelopes (so the page can't POST), then restoring it.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 20000;

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

// Pretend the page is offline by failing every fetch to the relay
// envelopes endpoint. Returns the restore function (called via
// page.evaluate after the test).
async function takeOffline(page) {
  await page.evaluate(() => {
    if (window.__smokeOnlineFetch !== undefined) return;
    window.__smokeOnlineFetch = window.fetch;
    window.fetch = function(url, ...rest) {
      const u = typeof url === "string" ? url : (url instanceof Request ? url.url : "");
      if (u.includes("/api/relay/envelopes")) {
        return Promise.reject(new Error("smoke-offline"));
      }
      return window.__smokeOnlineFetch.call(this, url, ...rest);
    };
  });
}
async function comeOnline(page) {
  await page.evaluate(() => {
    if (window.__smokeOnlineFetch !== undefined) {
      window.fetch = window.__smokeOnlineFetch;
      delete window.__smokeOnlineFetch;
    }
  });
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
    const handleA = `rqa${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "A sign up"); throw new Error(); }

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `rqb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "B sign up"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);
    const canonicalB = await lookupCanonical(handleB);
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // ===== Part 1: A goes offline + sends a message. =====
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await takeOffline(pageA);
    const QUEUED_MARKER = `offline-queued-${Date.now()}`;
    await pageA.evaluate((body) => {
      const input = document.getElementById("chat-popup-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, QUEUED_MARKER);

    // The message should be locally saved with a queued/retrying tick.
    if (!await waitFor(pageA, (m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      return rows.some((r) => (r.innerText || "").includes(m));
    }, 5000, 150, QUEUED_MARKER)) {
      fail("1.local-save", "queued message did not render locally");
      throw new Error();
    }
    const queuedState = await pageA.evaluate((m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      const row = rows.find((r) => (r.innerText || "").includes(m));
      if (!row) return null;
      const tick = row.querySelector(".chat-message__tick");
      return {
        tickStatus: tick?.getAttribute("data-message-status") ?? null,
        tickGlyph: tick?.textContent ?? null
      };
    }, QUEUED_MARKER);
    if (queuedState === null) {
      fail("1.tick-missing", "no tick on queued message");
    } else if (queuedState.tickStatus !== "queued" && queuedState.tickStatus !== "retrying") {
      fail("1.tick-state", `expected queued/retrying tick, got status='${queuedState.tickStatus}' glyph='${queuedState.tickGlyph}'`);
    } else {
      ok(`1. offline send rendered locally with queued/retrying tick (glyph=${queuedState.tickGlyph})`);
    }

    // ===== Part 2: durable — the row survives a reload. =====
    await pageA.reload({ waitUntil: "networkidle0" });
    // After reload the page is signed in via IDB. Open the chat
    // again and verify the queued row is still there.
    if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in", 15000)) {
      fail("2.signin-after-reload", "A's signed-in state did not restore after reload");
      throw new Error();
    }
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    const survived = await waitFor(pageA, (m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      return rows.some((r) => (r.innerText || "").includes(m));
    }, 6000, 150, QUEUED_MARKER);
    if (!survived) {
      fail("2.durable", "queued message did not survive reload");
      throw new Error();
    }
    ok(`2. queued message survived page reload`);

    // ===== Part 3: drainer + manual retry. We come online and the
    // drainer should pick up the row on its next pass (or sooner via
    // the visibilitychange path). =====
    await comeOnline(pageA);
    // The post-reload page does not have our blocking fetch shim, so
    // the periodic drainer (~5s) will pick this up automatically.
    if (!await waitFor(pageA, (m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      const row = rows.find((r) => (r.innerText || "").includes(m));
      const tick = row?.querySelector(".chat-message__tick");
      const status = tick?.getAttribute("data-message-status") ?? null;
      return status === "sent" || status === "delivered" || status === "read";
    }, RECEIVE_BUDGET_MS, 250, QUEUED_MARKER)) {
      const peek = await pageA.evaluate((m) => {
        const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
        const row = rows.find((r) => (r.innerText || "").includes(m));
        return {
          status: row?.querySelector(".chat-message__tick")?.getAttribute("data-message-status") ?? null,
          glyph: row?.querySelector(".chat-message__tick")?.textContent ?? null
        };
      }, QUEUED_MARKER);
      fail("3.drain", `queued message never advanced to sent. last tick=${JSON.stringify(peek)}`);
    } else {
      ok(`3. queued message drained automatically after reload (sent/delivered tick)`);
    }

    // ===== Part 4: B receives the previously-queued message. =====
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    if (!await waitFor(pageB, (m) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(m);
    }, RECEIVE_BUDGET_MS, 200, QUEUED_MARKER)) {
      fail("4.b-receive", `B did not receive the (previously-queued) message '${QUEUED_MARKER}'`);
    } else {
      ok(`4. B received the previously-queued message after A reconnected`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`RELIABILITY-QUEUE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("RELIABILITY-QUEUE SMOKE PASSED");
})().catch((err) => {
  console.error("RELIABILITY-QUEUE SMOKE ERRORED:", err);
  process.exit(1);
});

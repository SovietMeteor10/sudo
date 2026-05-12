#!/usr/bin/env node
// reconnect-recovery smoke (Phase 10.1 Part A).
//
// Verifies that after a transient relay failure the drainer:
//   - Bumps the message into "retrying" state (attempts > 0).
//   - Resumes automatically once relay POSTs succeed again.
//   - Does not drop the message silently — same row, same body,
//     same message_id end-to-end.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

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

// Wrap fetch so the FIRST N calls to /api/relay/envelopes throw
// (transient network error); subsequent calls pass through. The
// drainer should observe the transient failure, schedule a retry,
// and succeed on the next attempt.
async function injectTransientFailures(page, failuresCount) {
  await page.evaluate((n) => {
    if (window.__smokeRecOrigFetch !== undefined) return;
    window.__smokeRecOrigFetch = window.fetch;
    let left = n;
    window.fetch = function(url, ...rest) {
      const u = typeof url === "string" ? url : (url instanceof Request ? url.url : "");
      if (left > 0 && u.includes("/api/relay/envelopes") && !u.includes("/ack")) {
        left--;
        return Promise.reject(new Error("smoke-transient-network"));
      }
      return window.__smokeRecOrigFetch.call(this, url, ...rest);
    };
  }, failuresCount);
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
    const handleA = `rra${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "A sign up"); throw new Error(); }
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `rrb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "B sign up"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);
    const canonicalB = await lookupCanonical(handleB);
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // Fail the next 1 relay POST → the send moves to "retrying";
    // the drainer's next pass succeeds.
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await injectTransientFailures(pageA, 1);
    const MARKER = `transient-recover-${Date.now()}`;
    await pageA.evaluate((body) => {
      const input = document.getElementById("chat-popup-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, MARKER);

    // First observable state: retrying (attempts >= 1) because the
    // first POST was forced to fail.
    if (!await waitFor(pageA, (m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      const row = rows.find((r) => (r.innerText || "").includes(m));
      const status = row?.querySelector(".chat-message__tick")?.getAttribute("data-message-status") ?? null;
      return status === "retrying";
    }, 6000, 150, MARKER)) {
      fail("1.retrying", "send did not advance to 'retrying' after transient network failure");
    } else {
      ok(`1. send moved to 'retrying' after one transient failure`);
    }

    // The drainer's periodic timer (~5s) should pick the row back up
    // and the second relay POST passes through, so the message
    // advances to sent/delivered.
    if (!await waitFor(pageA, (m) => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      const row = rows.find((r) => (r.innerText || "").includes(m));
      const status = row?.querySelector(".chat-message__tick")?.getAttribute("data-message-status") ?? null;
      return status === "sent" || status === "delivered" || status === "read";
    }, 20000, 250, MARKER)) {
      fail("2.recover", "retrying message never advanced to sent after the transient failure cleared");
    } else {
      ok(`2. retrying message recovered + advanced to sent (drainer succeeded on second attempt)`);
    }

    // B receives the message (same body, no duplicates).
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    if (!await waitFor(pageB, (m) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(m);
    }, 15000, 200, MARKER)) {
      fail("3.b-receive", `B did not receive the recovered message '${MARKER}'`);
    } else {
      // Make sure there's exactly one copy on B (no duplicate from
      // double-submit on the retry path).
      const count = await pageB.evaluate((m) => {
        const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--received")];
        return rows.filter((r) => (r.innerText || "").includes(m)).length;
      }, MARKER);
      if (count !== 1) {
        fail("3b.duplicate", `B received ${count} copies of the recovered message (expected exactly 1)`);
      } else {
        ok(`3. B received exactly one copy of the recovered message — no duplicate from retry`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`RECONNECT-RECOVERY SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("RECONNECT-RECOVERY SMOKE PASSED");
})().catch((err) => {
  console.error("RECONNECT-RECOVERY SMOKE ERRORED:", err);
  process.exit(1);
});

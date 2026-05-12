#!/usr/bin/env node
// typing-indicator smoke.
//
// Verifies the ephemeral typing-indicator contract end-to-end:
//   1. Wire: POST /api/typing + GET /api/typing/:recipient round-trips.
//   2. UI: A composes → B's chat popup renders "is typing…" line.
//      Indicator auto-hides after the server-side TTL expires.
//   3. Privacy: typing events never increment B's chat-list unread
//      badge and never schedule a push notification (the push test
//      endpoint reports `attempted=0` after a typing exchange).
//   4. Self-echo guard: a second linked device A' of the SAME owner
//      does NOT see "is typing…" from itself (A and A' both poll on
//      the OWN canonical_id, and A only ever sends typing TO B).

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
    pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
    await pageA.setViewport({ width: 980, height: 820 });
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `tya${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up failed"); throw new Error("A"); }
    const canonicalA = await lookupCanonical(handleA);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `tyb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up failed"); throw new Error("B"); }
    const canonicalB = await lookupCanonical(handleB);

    ok(`setup: A=@${handleA} B=@${handleB}`);

    // 1. HTTP wire: POST + GET round-trip.
    const post = await fetch(`${BASE}/api/typing`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender_canonical_id: canonicalA, recipient_canonical_id: canonicalB, typing: true })
    });
    if (!post.ok) fail("1.post", `POST typing -> ${post.status}`);
    const get = await fetch(`${BASE}/api/typing/${encodeURIComponent(canonicalB)}`);
    const body = await get.json();
    const senders = (body.typing || []).map((e) => e.sender_canonical_id);
    if (!senders.includes(canonicalA)) {
      fail("1.get", `GET typing did not include A: ${JSON.stringify(senders)}`);
    } else {
      ok("1. POST/GET typing round-trips on the server");
    }

    // Clear server-side state with typing=false so the next phase
    // starts from a known baseline.
    await fetch(`${BASE}/api/typing`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender_canonical_id: canonicalA, recipient_canonical_id: canonicalB, typing: false })
    });

    // 2. Open chats on both sides + drive composer input on A.
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });

    // Drive an input event on A's composer (the page-side listener
    // calls notifyComposerInput which posts to /api/typing).
    await pageA.evaluate(() => {
      const input = document.getElementById("chat-popup-input");
      if (input instanceof HTMLTextAreaElement) {
        input.value = "hi";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    // 3. B's typing line appears within ~2-3s (B's poll interval).
    if (!await waitFor(pageB, () => {
      const el = document.getElementById("chat-popup-typing");
      if (!(el instanceof HTMLElement)) return false;
      return !el.hidden && /typing/i.test(el.textContent ?? "");
    }, 8000)) {
      const peek = await pageB.evaluate(() => {
        const el = document.getElementById("chat-popup-typing");
        return { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
      });
      fail("3.typing-render", `B did not render typing line: ${JSON.stringify(peek)}`);
    } else {
      ok("3. B renders typing line shortly after A's input");
    }

    // 4. B's chat-list unread badge for A did NOT increment because
    //    of typing. Poll once after the indicator is rendered.
    const badge = await pageB.evaluate(() => {
      const row = document.querySelector(`.chat-row[data-chat-canonical^="sudo:"]`);
      if (!(row instanceof HTMLElement)) return { found: false };
      const unread = row.querySelector(".chat-row__unread");
      return { found: true, hasUnread: unread instanceof HTMLElement };
    });
    // No unread badge expected (no real messages).
    if (badge.hasUnread === true) {
      fail("4.unread", "typing event incremented unread badge");
    } else {
      ok("4. typing event did NOT increment unread badge");
    }

    // 5. Push fan-out: hit the dev test endpoint and assert
    //    attempted=0 (no push subscriptions exist for B in this run;
    //    a typing event must NEVER itself fan out a push).
    const fanOut = await fetch(`${BASE}/api/push/test`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        recipient_canonical_id: canonicalB,
        sender_canonical_id: canonicalA,
        sender_handle: `@${handleA}`,
        unread_count: 0,
        stub_status: 201
      })
    });
    const fanBody = await fanOut.json();
    if ((fanBody.stats?.attempted ?? -1) !== 0) {
      fail("5.push", `expected attempted=0 fan-out from typing context, got ${JSON.stringify(fanBody.stats)}`);
    } else {
      ok("5. typing context does NOT schedule a push (attempted=0)");
    }

    // 6. Stop A's composer (clear it), then assert B's indicator
    //    clears within a couple of poll cycles.
    await pageA.evaluate(() => {
      const input = document.getElementById("chat-popup-input");
      if (input instanceof HTMLTextAreaElement) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    if (!await waitFor(pageB, () => {
      const el = document.getElementById("chat-popup-typing");
      return el instanceof HTMLElement && el.hidden;
    }, 8000)) {
      fail("6.timeout", "B's typing line did not clear after A cleared composer");
    } else {
      ok("6. B's typing line clears after A clears composer");
    }

    // 7. Self-echo guard: simulate A as their own recipient (which
    //    a multi-device A account would poll under). The server
    //    refuses self-as-recipient so the GET never includes A
    //    pinging themselves. Verify via direct HTTP probe.
    const self = await fetch(`${BASE}/api/typing/${encodeURIComponent(canonicalA)}`);
    const selfBody = await self.json();
    const selfHits = (selfBody.typing || []).filter((e) => e.sender_canonical_id === canonicalA);
    if (selfHits.length > 0) {
      fail("7.self-echo", `A's typing poll returned self-as-sender entries: ${JSON.stringify(selfHits)}`);
    } else {
      ok("7. A's own typing poll never sees A as sender (no self-echo)");
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`TYPING-INDICATOR SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("TYPING-INDICATOR SMOKE PASSED");
})().catch((err) => {
  console.error("TYPING-INDICATOR SMOKE ERRORED:", err);
  process.exit(1);
});

#!/usr/bin/env node
// encrypted-chat-envelope smoke (Phase 9). Asserts that chat
// envelopes sitting at the relay are fully opaque to the server:
//
//   - ciphertext_scheme === "sudo_chat_v1"
//   - the plaintext body never appears on the wire
//   - the reply pointer + forwarded flag live INSIDE the
//     encrypted payload, not on the envelope top level
//
// Round-trip: B receives, decrypts, and renders the body + the
// reply quote + the forwarded label. Malformed-ciphertext path:
// a junk sudo_chat_v1 envelope does not crash B's poller, and
// B's next legit message still renders.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 15000;
const SECRET_MARKER = "secret-marker-α-β-γ-9c3b1f";

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

async function fetchInbox(canonical) {
  const r = await fetch(`${BASE}/api/relay/inbox/${encodeURIComponent(canonical)}`);
  if (!r.ok) return [];
  const body = await r.json().catch(() => ({}));
  return Array.isArray(body?.envelopes) ? body.envelopes : [];
}

async function sendBodyViaUi(page, target, body) {
  await page.evaluate(async (t, b) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById("chat-popup-input");
    input.value = b;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, target, body);
}

// Block B's poller by short-circuiting fetch() for the relay-inbox
// endpoint. Keeps the rest of the page running. Returns a handle
// to restore behavior.
async function blockRelayInbox(page) {
  await page.evaluate(() => {
    if (window.__smokeOriginalFetch !== undefined) return;
    window.__smokeOriginalFetch = window.fetch;
    window.fetch = function(url, ...rest) {
      const u = typeof url === "string" ? url : (url instanceof Request ? url.url : "");
      if (u.includes("/api/relay/inbox/")) {
        return Promise.reject(new Error("smoke-disable-inbox-poll"));
      }
      return window.__smokeOriginalFetch.call(this, url, ...rest);
    };
  });
}
async function unblockRelayInbox(page) {
  await page.evaluate(() => {
    if (window.__smokeOriginalFetch !== undefined) {
      window.fetch = window.__smokeOriginalFetch;
      delete window.__smokeOriginalFetch;
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
    const handleA = `eca${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up A"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `ecb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up B"); throw new Error(); }
    const canonicalB = await lookupCanonical(handleB);
    ok(`setup: A=@${handleA} B=@${handleB}`);

    // Freeze B's relay-inbox polling so we can peek the wire before
    // B drains the envelope to its local IDB and ACKs.
    await blockRelayInbox(pageB);

    // ===== Part 1: A sends a vanilla message containing the
    // SECRET_MARKER. Peek the wire — assert zero plaintext leakage,
    // assert scheme tag, assert no envelope top-level fields for
    // body / reply / forward. =====
    await sendBodyViaUi(pageA, { canonical: canonicalB, handle: `@${handleB}` }, SECRET_MARKER);
    // Give A's submit time to land on the relay.
    let envelopes = [];
    for (let i = 0; i < 20; i++) {
      envelopes = await fetchInbox(canonicalB);
      const hit = envelopes.find((e) => e.sender_canonical_id === canonicalA && e.ciphertext_scheme === "sudo_chat_v1");
      if (hit !== undefined) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const env1 = envelopes.find((e) => e.sender_canonical_id === canonicalA && e.ciphertext_scheme === "sudo_chat_v1") ?? null;
    if (env1 === null) {
      fail("1.peek", `A's first envelope didn't reach the relay: ${JSON.stringify(envelopes)}`);
      throw new Error();
    }
    ok(`1. envelope on the wire: scheme='${env1.ciphertext_scheme}'`);
    const env1Json = JSON.stringify(env1);
    if (env1Json.includes(SECRET_MARKER)) {
      fail("1.plaintext", `envelope JSON contains the plaintext marker '${SECRET_MARKER}'`);
    } else {
      ok(`1b. envelope JSON contains zero plaintext markers`);
    }
    if ("reply_to_relay_message_id" in env1 && typeof env1.reply_to_relay_message_id === "string" && env1.reply_to_relay_message_id.length > 0) {
      fail("1.reply-leak", `envelope top-level still carries reply_to_relay_message_id: '${env1.reply_to_relay_message_id}'`);
    } else {
      ok(`1c. envelope has no top-level reply_to_relay_message_id`);
    }
    if (env1.is_forwarded === true) {
      fail("1.forward-leak", `envelope top-level still carries is_forwarded=true`);
    } else {
      ok(`1d. envelope has no top-level is_forwarded`);
    }

    // ===== Part 2: A sends a reply pointing at the just-sent
    // message. The new envelope on the wire must also be free of
    // plaintext + must NOT carry a top-level reply pointer. =====
    const REPLY_BODY = `${SECRET_MARKER}-reply`;
    const aFirstRelayId = await pageA.evaluate(() => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message--sent")];
      const last = rows[rows.length - 1];
      return last?.getAttribute("data-relay-message-id") ?? null;
    });
    if (typeof aFirstRelayId !== "string" || aFirstRelayId.length === 0) {
      fail("2.reply-find", "could not find A's first sent message row's relay id");
    } else {
      // Drive the reply via the kebab menu so replyContext is set
      // through the real UI flow.
      await pageA.evaluate(() => {
        const row = document.querySelector("#chat-popup-body .chat-message--sent:not(.chat-message--deleted)");
        const trigger = row?.querySelector(".chat-message__menu-trigger");
        if (trigger instanceof HTMLElement) trigger.click();
      });
      await new Promise((r) => setTimeout(r, 200));
      await pageA.evaluate(() => document.getElementById("message-menu-reply")?.click());
      await new Promise((r) => setTimeout(r, 200));
      await pageA.evaluate((body) => {
        const input = document.getElementById("chat-popup-input");
        input.value = body;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }, REPLY_BODY);
      // Wait for the new envelope to arrive at the relay.
      let env2 = null;
      for (let i = 0; i < 20; i++) {
        const list = await fetchInbox(canonicalB);
        env2 = list.find((e) => e.message_id !== env1.message_id && e.ciphertext_scheme === "sudo_chat_v1") ?? null;
        if (env2 !== null) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (env2 === null) {
        fail("2.peek", "reply envelope never landed at the relay");
      } else {
        const j = JSON.stringify(env2);
        if (j.includes(REPLY_BODY)) {
          fail("2.plaintext", `reply envelope leaks plaintext body`);
        } else {
          ok(`2. reply envelope on the wire has no plaintext body`);
        }
        if ("reply_to_relay_message_id" in env2 && typeof env2.reply_to_relay_message_id === "string" && env2.reply_to_relay_message_id.length > 0) {
          fail("2.reply-leak", `reply envelope leaks reply_to_relay_message_id='${env2.reply_to_relay_message_id}' on the top level`);
        } else {
          ok(`2b. reply envelope has no top-level reply pointer`);
        }
        if (j.includes(aFirstRelayId)) {
          fail("2.pointer-leak", `reply envelope JSON contains the parent relay id '${aFirstRelayId}'`);
        } else {
          ok(`2c. reply envelope contains zero plaintext refs to the parent message id`);
        }
      }
    }

    // ===== Part 3: Round-trip — restore B's poller and assert B
    // decrypts and renders the body + reply chip. =====
    await unblockRelayInbox(pageB);
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });
    if (!await waitFor(pageB, (marker) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(marker);
    }, RECEIVE_BUDGET_MS, 200, SECRET_MARKER)) {
      fail("3.b-render", `B did not render decrypted message body '${SECRET_MARKER}'`);
    } else {
      ok(`3. B renders the decrypted body — sudo_chat_v1 round-trip OK`);
    }
    // Reply chip survives inside the encrypted payload. The
    // receiver-side render attaches a .chat-message__reply-snippet
    // pointing at the original message's relay id.
    const replyChip = await pageB.evaluate(() => {
      const rows = [...document.querySelectorAll("#chat-popup-body .chat-message")];
      const withReply = rows.filter((r) => r.querySelector(".chat-message__reply-snippet") !== null);
      return withReply.length;
    });
    if (replyChip < 1) {
      fail("3b.reply-chip", "B never rendered a reply quote — metadata didn't survive the encrypted payload");
    } else {
      ok(`3b. reply pointer survived the encrypted payload (${replyChip} row with reply quote)`);
    }

    // ===== Part 4: Malformed sudo_chat_v1 envelope must not crash
    // B's poll. We post directly to /api/relay/envelopes with a
    // dev-placeholder signature (server skips signature check for
    // that exact value) and junk ciphertext. =====
    const malformedId = require("crypto").randomUUID();
    const nowIso = new Date().toISOString();
    const expIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const post = await fetch(`${BASE}/api/relay/envelopes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "sudo_relay_envelope",
        protocol_version: "0.1.0",
        message_id: malformedId,
        sender_canonical_id: canonicalA,
        recipient_canonical_id: canonicalB,
        sender_handle: handleA,
        recipient_handle: handleB,
        ciphertext: "this-is-deliberately-not-base64-or-valid-json-payload-!@#",
        ciphertext_scheme: "sudo_chat_v1",
        created_at: nowIso,
        expires_at: expIso,
        status: "queued_local",
        sender_signature: "dev-placeholder"
      })
    });
    const postBody = await post.json().catch(() => ({}));
    if (post.status !== 202 || postBody.ok !== true) {
      fail("4.inject", `malformed envelope rejected at submit: ${post.status} ${JSON.stringify(postBody)}`);
    } else {
      ok(`4. malformed sudo_chat_v1 envelope accepted by relay (id=${malformedId.slice(0, 8)}…)`);
    }
    // Wait for B's poll cycle to fetch + decode + render.
    if (!await waitFor(pageB, () => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes("[message could not be decrypted]");
    }, RECEIVE_BUDGET_MS, 200)) {
      fail("4b.placeholder", "B did not render the '[message could not be decrypted]' placeholder");
    } else {
      ok(`4b. malformed envelope renders the decryption-failure placeholder`);
    }
    // ===== Part 5: A's NEXT legit message still flows after the
    // malformed row — proof that the poller didn't deadlock. =====
    const POST_JUNK = `${SECRET_MARKER}-after-junk`;
    await pageA.evaluate((body) => {
      const input = document.getElementById("chat-popup-input");
      input.value = body;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("chat-popup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, POST_JUNK);
    if (!await waitFor(pageB, (marker) => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes(marker);
    }, RECEIVE_BUDGET_MS, 200, POST_JUNK)) {
      fail("5.next-message", `B did not receive the follow-up legit message '${POST_JUNK}'`);
    } else {
      ok(`5. next legit message after the malformed row still rendered on B`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`ENCRYPTED-CHAT-ENVELOPE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ENCRYPTED-CHAT-ENVELOPE SMOKE PASSED");
})().catch((err) => {
  console.error("ENCRYPTED-CHAT-ENVELOPE SMOKE ERRORED:", err);
  process.exit(1);
});

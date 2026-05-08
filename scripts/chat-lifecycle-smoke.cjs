#!/usr/bin/env node
// Two-account chat lifecycle smoke. Drives a real browser through:
//   create A, create B, A sends to B, B receives within ~6s,
//   B's chat list includes A, B's chat popup auto-opens,
//   B replies, A receives the reply within ~6s.
//
// Both users live in isolated browser contexts so their IndexedDB,
// local storage, and crypto accounts don't bleed between them.
//
// Requires puppeteer-core and a Chrome binary (same setup as the other
// smokes; see docs/SMOKE.md).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const passes = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { passes.push(label); console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 12000; // > one polling cycle (5s) plus crypto/encryption headroom

async function newSignedInContext(browser, handle) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log(`PAGEERR(${handle})>`, e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = await page.evaluate(() => document.body.dataset.authState);
    if (a === "signed-in") return { context, page };
  }
  throw new Error(`signup hung for @${handle}`);
}

async function lookupCanonical(handle) {
  const response = await fetch(`${BASE}/api/identity/handles/${handle.replace(/^@/, "")}`);
  if (response.status !== 200) throw new Error(`identity lookup ${handle} -> ${response.status}`);
  return (await response.json()).canonical_id;
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.toLowerCase());
}

const DEMO_NEEDLES = ["@northcatalog", "@linebreak", "wired the registry", "rss still feels", "finger endpoints", "key continuity"];

async function injectChatTargetAndSend(page, target, body) {
  await page.evaluate(async (t, b) => {
    // Click the chat-popup open by simulating a click on a chat row we
    // inject. The product code only knows how to open popups from chat
    // rows, so we drop one in temporarily.
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button"
        data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""><div class="chat-row__handle">${t.handle}</div></div>`;
    }
    document.querySelector(".chat-row")?.click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.getElementById("chat-popup-input");
    if (!input) throw new Error("chat popup input missing");
    input.value = b;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, target, body);
}

async function waitForPopupBody(page, expected, timeoutMs = RECEIVE_BUDGET_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await page.evaluate(() => ({
      hidden: document.getElementById("chat-popup")?.hidden ?? true,
      handle: document.getElementById("chat-popup-handle")?.textContent ?? "",
      body: document.getElementById("chat-popup-body")?.innerText ?? ""
    }));
    if (!snap.hidden && snap.body.includes(expected)) return { ok: true, snap, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 200));
  }
  const snap = await page.evaluate(() => ({
    hidden: document.getElementById("chat-popup")?.hidden ?? true,
    body: document.getElementById("chat-popup-body")?.innerText ?? ""
  }));
  return { ok: false, snap, elapsed: Date.now() - start };
}

async function relayInboxLength(canonical) {
  const response = await fetch(`${BASE}/api/relay/inbox/${encodeURIComponent(canonical)}`);
  if (response.status !== 200) return -1;
  const body = await response.json();
  return Array.isArray(body.envelopes) ? body.envelopes.length : 0;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
  });

  const handleA = "alice" + Date.now().toString().slice(-6);
  const handleB = "bob" + Date.now().toString().slice(-6);

  const { context: ctxA, page: pageA } = await newSignedInContext(browser, handleA);
  ok(`account A created: @${handleA}`);
  const { context: ctxB, page: pageB } = await newSignedInContext(browser, handleB);
  ok(`account B created: @${handleB}`);

  const canonicalA = await lookupCanonical(handleA);
  const canonicalB = await lookupCanonical(handleB);

  // 1. fresh feeds must contain no demo posts on either side
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    const text = await bodyText(page);
    const seen = DEMO_NEEDLES.filter((needle) => text.includes(needle.toLowerCase()));
    if (seen.length > 0) fail(`fresh-feed-${label}`, `demo content visible: ${seen.join(", ")}`);
    else ok(`fresh feed for ${label} contains no demo content`);
    if (!text.includes("no posts yet") && !text.includes("post")) {
      // not strictly fatal — just informative
      console.log(`note: ${label} feed text: ${text.slice(0, 200)}`);
    }
  }
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    const chats = await page.evaluate(() => document.getElementById("chat-list")?.innerText.toLowerCase() ?? "");
    if (!/no chats yet/.test(chats)) fail(`fresh-chats-${label}`, `expected 'no chats yet': '${chats}'`);
    else ok(`${label} chat list shows 'no chats yet'`);
  }

  // 2. A sends to B
  const messageAtoB = `hello bob, this is alice ${Date.now()}`;
  await injectChatTargetAndSend(pageA, { canonical: canonicalB, handle: `@${handleB}` }, messageAtoB);
  ok("A submitted message to B");

  // 3. B should receive within budget; popup auto-opens with the message
  const recvB = await waitForPopupBody(pageB, messageAtoB);
  if (!recvB.ok) fail("B-receive", `expected message in popup within ${RECEIVE_BUDGET_MS}ms; popup hidden=${recvB.snap.hidden} body='${recvB.snap.body.slice(0, 200)}'`);
  else ok(`B popup received message in ${recvB.elapsed}ms`);

  // 3b. Bubble alignment: B's view of A's message must be a `received` bubble
  // pinned to the LEFT of the popup body.
  const incomingShape = await pageB.evaluate(() => {
    const node = document.querySelector(".chat-message--received");
    const bodyRect = document.getElementById("chat-popup-body")?.getBoundingClientRect();
    if (!node || !bodyRect) return { ok: false };
    const r = node.getBoundingClientRect();
    return {
      ok: true,
      leftOffset: Math.round(r.left - bodyRect.left),
      bodyWidth: Math.round(bodyRect.width),
      msgWidth: Math.round(r.width)
    };
  });
  if (!incomingShape.ok) fail("incoming-align", "no received bubble found in B");
  else if (incomingShape.leftOffset > Math.max(40, incomingShape.bodyWidth * 0.3)) {
    fail("incoming-align", `received bubble not left-aligned: leftOffset=${incomingShape.leftOffset}, bodyWidth=${incomingShape.bodyWidth}`);
  } else ok(`3b. received bubble left-aligned (offset=${incomingShape.leftOffset}px)`);

  // 3c. Honest relay status appears on the popup header.
  const popupRelay = await pageB.evaluate(() => document.getElementById("chat-popup-relay")?.textContent ?? "");
  if (!/https fallback|encrypted, not onion-routed|onion|unavailable/i.test(popupRelay)) {
    fail("popup-relay", `popup header missing relay status: '${popupRelay}'`);
  } else if (/onion-routed/i.test(popupRelay) && !/not onion-routed/i.test(popupRelay)) {
    fail("popup-relay", `popup claims onion routing without onion transport: '${popupRelay}'`);
  } else ok(`3c. popup relay status: '${popupRelay}'`);

  // 4. B's chat list shows A
  const bChatList = await pageB.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  if (!new RegExp(handleA, "i").test(bChatList)) fail("B-chat-list", `chat list does not include sender: '${bChatList}'`);
  else ok("B chat list now includes A");

  // 5. relay should be empty after ACK
  await new Promise((r) => setTimeout(r, 500));
  const remaining = await relayInboxLength(canonicalB);
  if (remaining > 0) fail("B-ack", `relay inbox still has ${remaining} envelopes after ACK`);
  else ok("B ACKed relay envelope (inbox empty)");

  // 6. B replies to A
  const messageBtoA = `hi alice, got it ${Date.now()}`;
  await pageB.evaluate(async (b) => {
    const input = document.getElementById("chat-popup-input");
    if (!input) throw new Error("popup input missing");
    input.value = b;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, messageBtoA);
  ok("B submitted reply to A");

  // 7. A should see reply in its popup
  const recvA = await waitForPopupBody(pageA, messageBtoA);
  if (!recvA.ok) fail("A-receive", `expected reply in popup within ${RECEIVE_BUDGET_MS}ms; popup hidden=${recvA.snap.hidden} body='${recvA.snap.body.slice(0, 200)}'`);
  else ok(`A popup received reply in ${recvA.elapsed}ms`);

  // 7b. A's view: outgoing bubble (sent) must be on the RIGHT, B's reply on the LEFT.
  const aBubbles = await pageA.evaluate(() => {
    const bodyEl = document.getElementById("chat-popup-body");
    if (!bodyEl) return { ok: false };
    const bodyRect = bodyEl.getBoundingClientRect();
    const sent = bodyEl.querySelector(".chat-message--sent");
    const received = bodyEl.querySelector(".chat-message--received");
    if (!sent || !received) return { ok: false, reason: "missing sent or received bubble" };
    const sR = sent.getBoundingClientRect();
    const rR = received.getBoundingClientRect();
    return {
      ok: true,
      sentRightOffset: Math.round(bodyRect.right - sR.right),
      receivedLeftOffset: Math.round(rR.left - bodyRect.left),
      bodyWidth: Math.round(bodyRect.width),
      sentWidth: Math.round(sR.width),
      receivedWidth: Math.round(rR.width)
    };
  });
  if (!aBubbles.ok) fail("A-align", aBubbles.reason || "could not measure bubbles in A");
  else if (aBubbles.sentRightOffset > Math.max(40, aBubbles.bodyWidth * 0.3)) {
    fail("A-align", `sent bubble not right-aligned: rightOffset=${aBubbles.sentRightOffset}`);
  } else if (aBubbles.receivedLeftOffset > Math.max(40, aBubbles.bodyWidth * 0.3)) {
    fail("A-align", `received bubble not left-aligned: leftOffset=${aBubbles.receivedLeftOffset}`);
  } else ok(`7b. A bubbles aligned (sent right=${aBubbles.sentRightOffset}px, received left=${aBubbles.receivedLeftOffset}px)`);

  // 8. A's chat list now shows B
  const aChatList = await pageA.evaluate(() => document.getElementById("chat-list")?.innerText ?? "");
  if (!new RegExp(handleB, "i").test(aChatList)) fail("A-chat-list", `chat list does not include reply sender: '${aChatList}'`);
  else ok("A chat list now includes B");

  await ctxA.close();
  await ctxB.close();
  await browser.close();

  console.log(`\nresults: ${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("CHAT LIFECYCLE SMOKE FAILED:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("CHAT LIFECYCLE SMOKE PASSED");
})().catch((error) => { console.error("CHAT LIFECYCLE SMOKE ERROR", error); process.exit(2); });

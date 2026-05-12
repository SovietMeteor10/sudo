#!/usr/bin/env node
// message-reactions smoke.
//
// End-to-end across two browser contexts:
//   1. A signs up, B signs up.
//   2. A sends a message to B.
//   3. B reacts 👍 to A's message via the in-page reaction picker.
//   4. A sees a 👍 1 pill below the message.
//   5. B changes reaction to ❤️ via the picker; A's view updates
//      to ❤️ 1 and the 👍 pill is gone.
//   6. B toggles ❤️ off (clicks the picker emoji again — "same
//      emoji removes"); A's view shows no reaction pill.
//   7. Tombstoned-message guard: A deletes their own sent message.
//      Opening the kebab on the tombstoned row shows the react
//      entry as disabled (no picker can open).
//
// We can't smoke linked-device C inheriting the aggregate without
// driving the full pair flow; that's covered indirectly by the
// message-reaction slice projector (registered via the coordinator)
// which is exercised by message-sync.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 10000;

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

async function openChat(page, target, message) {
  await page.evaluate((t, b) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
    if (b !== null) {
      // Defer send so the popup body has time to mount.
      setTimeout(() => {
        const input = document.getElementById("chat-popup-input");
        if (input instanceof HTMLTextAreaElement) {
          input.value = b;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }, 250);
    }
  }, target, message ?? null);
}

// Drive the reaction picker: open the kebab on a target row, click
// "react", then click the emoji.
async function reactOn(page, relayMessageId, emoji) {
  return page.evaluate(async (rid, em) => {
    const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
    if (!(row instanceof HTMLElement)) throw new Error("no row for relay id");
    const trigger = row.querySelector(".chat-message__menu-trigger");
    if (trigger instanceof HTMLElement) trigger.click();
    await new Promise((r) => setTimeout(r, 100));
    const reactItem = document.getElementById("message-menu-react");
    if (!(reactItem instanceof HTMLButtonElement) || reactItem.disabled) {
      return { ok: false, reason: "react menu item disabled or missing" };
    }
    reactItem.click();
    await new Promise((r) => setTimeout(r, 100));
    const picker = document.getElementById("reaction-picker");
    if (!(picker instanceof HTMLElement) || picker.hidden) {
      return { ok: false, reason: "picker did not open" };
    }
    const button = picker.querySelector(`[data-reaction-emoji="${em}"]`);
    if (!(button instanceof HTMLElement)) return { ok: false, reason: "emoji not in picker" };
    button.click();
    return { ok: true };
  }, relayMessageId, emoji);
}

async function readPillsForRelayId(page, relayMessageId) {
  return page.evaluate((rid) => {
    const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
    if (!(row instanceof HTMLElement)) return null;
    const pills = [...row.querySelectorAll(".chat-message__reaction-pill")].map((p) => ({
      text: (p.textContent ?? "").trim(),
      emoji: p instanceof HTMLElement ? p.dataset.reactionEmoji : null,
      isMine: p.classList.contains("is-mine"),
      disabled: p instanceof HTMLButtonElement ? p.disabled : false
    }));
    return pills;
  }, relayMessageId);
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
    const handleA = `rxa${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up failed"); throw new Error("A"); }
    const canonicalA = await lookupCanonical(handleA);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `rxb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up failed"); throw new Error("B"); }
    const canonicalB = await lookupCanonical(handleB);

    ok(`setup: A=@${handleA} B=@${handleB}`);

    // A → B initial message.
    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` }, "hello b");
    // Open B's chat with A so B's popup is wired up.
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` }, null);
    // Wait for B to receive A's message.
    if (!await waitFor(pageB, () => {
      const rows = [...document.querySelectorAll(".chat-message--received:not(.chat-message--deleted)")];
      return rows.length > 0;
    }, RECEIVE_BUDGET_MS)) {
      fail("setup.deliver", "B did not receive A's hello message");
      throw new Error("deliver");
    }
    ok("setup: A→B 'hello b' delivered");

    // Capture the relay_message_id of A's message on B's side.
    const relayId = await pageB.evaluate(() => {
      const row = document.querySelector(".chat-message--received");
      return row instanceof HTMLElement ? row.dataset.relayMessageId ?? null : null;
    });
    if (typeof relayId !== "string" || relayId.length === 0) {
      fail("setup.relay-id", "no relay_message_id on B's row");
      throw new Error("relay-id");
    }
    ok(`setup: target relay_message_id=${relayId.slice(0, 8)}…`);

    // 1. B reacts 👍.
    let r = await reactOn(pageB, relayId, "👍");
    if (r.ok !== true) { fail("1.react", `B could not react: ${r.reason}`); throw new Error("react"); }
    ok("1. B clicked 👍 in reaction picker");

    // 1b. B's own UI shows the 👍 pill marked as mine.
    if (!await waitFor(pageB, (rid) => {
      const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
      if (!(row instanceof HTMLElement)) return false;
      const pill = row.querySelector(".chat-message__reaction-pill.is-mine");
      return pill instanceof HTMLElement && (pill.textContent ?? "").includes("👍");
    }, 4000, 100, relayId)) {
      fail("1b.b-self", "B's own UI did not paint 👍 pill is-mine");
    } else {
      ok("1b. B's own UI paints 👍 pill marked is-mine");
    }

    // 2. A receives the reaction over the relay (within budget).
    if (!await waitFor(pageA, (rid) => {
      const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
      if (!(row instanceof HTMLElement)) return false;
      const pill = row.querySelector(".chat-message__reaction-pill");
      return pill instanceof HTMLElement && (pill.textContent ?? "").includes("👍");
    }, RECEIVE_BUDGET_MS, 200, relayId)) {
      const peek = await readPillsForRelayId(pageA, relayId);
      fail("2.a-render", `A did not render B's 👍 pill. Pills: ${JSON.stringify(peek)}`);
    } else {
      ok("2. A renders B's 👍 1 pill");
    }

    // 3. B switches to ❤️ (picking a different emoji should REPLACE
    //    the prior 👍, leaving the row with only ❤️).
    r = await reactOn(pageB, relayId, "❤️");
    if (r.ok !== true) { fail("3.react", `B could not react ❤️: ${r.reason}`); throw new Error("react"); }
    if (!await waitFor(pageA, (rid) => {
      const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
      if (!(row instanceof HTMLElement)) return false;
      const pills = [...row.querySelectorAll(".chat-message__reaction-pill")];
      const heart = pills.find((p) => (p.textContent ?? "").includes("❤️"));
      const thumbs = pills.find((p) => (p.textContent ?? "").includes("👍"));
      return heart !== undefined && thumbs === undefined;
    }, RECEIVE_BUDGET_MS, 200, relayId)) {
      const peek = await readPillsForRelayId(pageA, relayId);
      fail("3.replace", `A still shows 👍 after B switched to ❤️. Pills: ${JSON.stringify(peek)}`);
    } else {
      ok("3. A's view replaces 👍 with ❤️ after B switches emoji");
    }

    // 4. B clicks ❤️ AGAIN in the picker → same-emoji removes.
    r = await reactOn(pageB, relayId, "❤️");
    if (r.ok !== true) { fail("4.react", `B could not re-react ❤️: ${r.reason}`); throw new Error("react"); }
    if (!await waitFor(pageA, (rid) => {
      const row = document.querySelector(`.chat-message[data-relay-message-id="${rid}"]`);
      if (!(row instanceof HTMLElement)) return false;
      return row.querySelectorAll(".chat-message__reaction-pill").length === 0;
    }, RECEIVE_BUDGET_MS, 200, relayId)) {
      const peek = await readPillsForRelayId(pageA, relayId);
      fail("4.toggle-off", `A still shows reaction pill after B toggled ❤️ off. Pills: ${JSON.stringify(peek)}`);
    } else {
      ok("4. picking the same emoji again removes B's reaction (A sees no pill)");
    }

    // 5. Tombstoned-message guard. A deletes their own sent message
    //    (the same one). The message-menu "react" entry on a
    //    tombstoned row must be disabled.
    await pageA.evaluate(() => {
      const row = document.querySelector(".chat-message--sent:not(.chat-message--deleted)");
      const trigger = row?.querySelector(".chat-message__menu-trigger");
      if (trigger instanceof HTMLElement) trigger.click();
    });
    await new Promise((r) => setTimeout(r, 150));
    await pageA.evaluate(() => document.getElementById("message-menu-delete")?.click());
    if (!await waitFor(pageA, () => {
      return document.querySelector(".chat-message--sent.chat-message--deleted") !== null;
    }, 4000)) {
      fail("5.delete-setup", "could not tombstone A's message");
      throw new Error("delete");
    }
    await pageA.evaluate(() => {
      const row = document.querySelector(".chat-message--sent.chat-message--deleted");
      const trigger = row?.querySelector(".chat-message__menu-trigger");
      if (trigger instanceof HTMLElement) trigger.click();
    });
    await new Promise((r) => setTimeout(r, 150));
    const reactDisabledOnTomb = await pageA.evaluate(() => {
      const btn = document.getElementById("message-menu-react");
      return btn instanceof HTMLButtonElement ? btn.disabled : false;
    });
    if (!reactDisabledOnTomb) {
      fail("5.tomb-disabled", "react menu item not disabled on tombstoned row");
    } else {
      ok("5. react menu item disabled on tombstoned message");
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`MESSAGE-REACTIONS SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MESSAGE-REACTIONS SMOKE PASSED");
})().catch((err) => {
  console.error("MESSAGE-REACTIONS SMOKE ERRORED:", err);
  process.exit(1);
});

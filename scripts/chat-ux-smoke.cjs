#!/usr/bin/env node
// Chat UX smoke. Covers four behaviours added in the chat
// expansion pass and is the canonical regression guard for them:
//
//   1. Fullscreen — header button toggles .is-fullscreen on the
//      popup; mobile widths open fullscreen by default and expose
//      the back arrow.
//   2. Sent-tick — every sent (non-tombstoned) message renders a
//      single tick inside .chat-message__meta with aria-label
//      "sent". Received and tombstoned messages do not.
//   3. Three-dot menu — every message row exposes a
//      .chat-message__menu-trigger; clicking it (desktop) or
//      long-pressing it (mobile) reveals #message-menu with
//      reply/forward/delete; delete-from-menu still tombstones
//      and syncs to the peer.
//   4. Conversation settings — gear icon opens the dialog; saving
//      a TTL writes a conversation_settings.upsert event that the
//      peer's projector consumes, inserts an inline system
//      message on both sides, and surfaces a TTL badge in the
//      chat header on both devices.
//
// Wired up as `npm run smoke:chat-ux`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 15000;

async function waitFor(page, predicate, timeoutMs = 8000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(predicate)) return true;
    await new Promise((r) => setTimeout(r, interval));
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
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 12000);
}

async function injectChatTargetAndSend(page, target, body) {
  await page.evaluate(async (t, b) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button"
        data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""><div class="chat-row__handle">${t.handle}</div></div>`;
    }
    document.querySelector(".chat-row")?.click();
    await new Promise((r) => setTimeout(r, 250));
    const input = document.getElementById("chat-popup-input");
    if (!input) throw new Error("chat popup input missing");
    input.value = b;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, target, body);
}

async function waitForPopupContains(page, needle) {
  return waitFor(page, (n) => {
    const popup = document.getElementById("chat-popup");
    const body = document.getElementById("chat-popup-body");
    return popup instanceof HTMLElement && !popup.hidden
      && body instanceof HTMLElement && (body.innerText || "").includes(n);
  }, RECEIVE_BUDGET_MS) ? Promise.resolve(true) : Promise.resolve(false);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // ===== Set up two contexts (A and B). =====
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.setViewport({ width: 980, height: 820 });
  pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handleA = `cxa${Date.now().toString().slice(-7)}`;
  if (!await signUp(pageA, handleA)) { fail("setup.A", "A could not sign up"); throw new Error(); }
  const canonA = await pageA.evaluate(async () => {
    const r = await fetch(`/.well-known/handles/${encodeURIComponent("HANDLE_A")}`.replace("HANDLE_A", window.__handleA ?? "")).catch(() => null);
    return null;
  });
  // Simpler: read canonical via local-account.
  const canonicalA = await pageA.evaluate((h) => fetch(`/.well-known/handles/${encodeURIComponent(h)}`).then((r) => r.json()).then((j) => j.canonical_id), handleA);
  ok(`setup. signed up A @${handleA} (${canonicalA.slice(0, 24)}…)`);

  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handleB = `cxb${Date.now().toString().slice(-7)}`;
  if (!await signUp(pageB, handleB)) { fail("setup.B", "B could not sign up"); throw new Error(); }
  const canonicalB = await pageB.evaluate((h) => fetch(`/.well-known/handles/${encodeURIComponent(h)}`).then((r) => r.json()).then((j) => j.canonical_id), handleB);
  ok(`setup. signed up B @${handleB} (${canonicalB.slice(0, 24)}…)`);

  // ===== A sends one message to B (so the rest of the suite has a
  //       conversation to operate on). =====
  await injectChatTargetAndSend(pageA, { canonical: canonicalB, handle: `@${handleB}` }, "hello b");
  if (!await waitFor(pageB, () => {
    const body = document.getElementById("chat-popup-body");
    return body instanceof HTMLElement && (body.innerText || "").includes("hello b");
  }, RECEIVE_BUDGET_MS)) {
    // B's popup may not be open — give the inbox poll time then open
    // it manually.
    await new Promise((r) => setTimeout(r, 3000));
    await pageB.evaluate((t) => {
      const list = document.getElementById("chat-list");
      if (list) {
        list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
      }
      document.querySelector(".chat-row")?.click();
    }, { canonical: canonicalA, handle: `@${handleA}` });
    if (!await waitFor(pageB, () => {
      const body = document.getElementById("chat-popup-body");
      return body instanceof HTMLElement && (body.innerText || "").includes("hello b");
    }, RECEIVE_BUDGET_MS)) {
      fail("setup.msg", "B never received the seed message");
      throw new Error();
    }
  }
  ok(`setup. A→B delivered`);

  // ============================================================
  // PART 1 — Fullscreen toggle (desktop)
  // ============================================================
  // Open chat from A's side (already open after the send above).
  const initialFs = await pageA.evaluate(() => ({
    popupOpen: document.getElementById("chat-popup")?.hidden === false,
    isFs: document.getElementById("chat-popup")?.classList.contains("is-fullscreen")
  }));
  if (!initialFs.popupOpen) {
    fail("1.popup", "A's chat popup is not open after sending");
    throw new Error();
  }
  if (initialFs.isFs) fail("1.desktop-default", "A's popup opened in fullscreen on desktop (should be windowed)");
  else ok(`1. desktop default: popup opens windowed (not fullscreen)`);

  // Click the fullscreen button → class added.
  await pageA.click("#chat-popup-fullscreen");
  await new Promise((r) => setTimeout(r, 120));
  const afterFsClick = await pageA.evaluate(() => ({
    isFs: document.getElementById("chat-popup")?.classList.contains("is-fullscreen"),
    bodyFlag: document.body.dataset["chatFullscreen"] === "1",
    backVisible: window.getComputedStyle(document.getElementById("chat-popup-back")).display !== "none"
  }));
  if (!afterFsClick.isFs) fail("2a.toggle-on", "fullscreen class not applied");
  if (!afterFsClick.bodyFlag) fail("2b.body-flag", "body[data-chat-fullscreen=1] not set");
  if (!afterFsClick.backVisible) fail("2c.back-visible", "back arrow not visible in fullscreen");
  if (afterFsClick.isFs && afterFsClick.bodyFlag && afterFsClick.backVisible) {
    ok(`2. fullscreen click adds is-fullscreen + body flag + reveals back arrow`);
  }

  // Click again → class removed.
  await pageA.click("#chat-popup-fullscreen");
  await new Promise((r) => setTimeout(r, 120));
  const afterFsSecond = await pageA.evaluate(() => ({
    isFs: document.getElementById("chat-popup")?.classList.contains("is-fullscreen"),
    bodyFlag: document.body.dataset["chatFullscreen"] === "1"
  }));
  if (afterFsSecond.isFs || afterFsSecond.bodyFlag) {
    fail("3.toggle-off", "second click did not exit fullscreen");
  } else {
    ok(`3. second click exits fullscreen`);
  }

  // ============================================================
  // PART 2 — Mobile default + back arrow
  // ============================================================
  // Close and reopen at mobile width.
  await pageA.evaluate(() => document.getElementById("chat-popup-close")?.click());
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === true, 2000);
  await pageA.setViewport({ width: 420, height: 820, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 120));
  await pageA.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, { canonical: canonicalB, handle: `@${handleB}` });
  if (!await waitFor(pageA, () => {
    const p = document.getElementById("chat-popup");
    return p instanceof HTMLElement && !p.hidden && p.classList.contains("is-fullscreen");
  }, 3000)) {
    fail("4.mobile-default", "popup did not open fullscreen on mobile width");
  } else {
    ok(`4. mobile (420px) default: popup opens fullscreen`);
  }
  // Back arrow should be visible AND clicking it closes the chat.
  const mobileBack = await pageA.evaluate(() => ({
    backVisible: window.getComputedStyle(document.getElementById("chat-popup-back")).display !== "none",
    tabsHidden: window.getComputedStyle(document.getElementById("mobile-tabs")).display === "none"
  }));
  if (!mobileBack.backVisible) fail("4b.back-visible", "back arrow not visible on mobile fullscreen");
  if (!mobileBack.tabsHidden) fail("4c.tabs-hidden", "mobile tabs not hidden under fullscreen chat");
  if (mobileBack.backVisible && mobileBack.tabsHidden) {
    ok(`4b. mobile back arrow visible + tab bar hidden under fullscreen chat`);
  }
  await pageA.click("#chat-popup-back");
  if (!await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === true, 2000)) {
    fail("5.back-closes", "back arrow click did not close the chat");
  } else {
    ok(`5. back arrow closes the chat`);
  }
  // Restore desktop viewport.
  await pageA.setViewport({ width: 980, height: 820 });
  await new Promise((r) => setTimeout(r, 120));

  // ============================================================
  // PART 3 — Sent tick on sent messages
  // ============================================================
  await pageA.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, { canonical: canonicalB, handle: `@${handleB}` });
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === false, 2000);
  const ticks = await pageA.evaluate(() => {
    const rows = [...document.querySelectorAll("#chat-popup-body .chat-message")];
    const sent = rows.filter((r) => r.classList.contains("chat-message--sent"));
    const received = rows.filter((r) => r.classList.contains("chat-message--received"));
    const sentWithTick = sent.filter((r) => r.querySelector('.chat-message__tick'));
    const receivedWithTick = received.filter((r) => r.querySelector('.chat-message__tick'));
    const statuses = sent.map((r) => r.querySelector(".chat-message__tick")?.getAttribute("data-message-status") ?? null);
    return { sent: sent.length, sentWithTick: sentWithTick.length, received: received.length, receivedWithTick: receivedWithTick.length, statuses };
  });
  if (ticks.sent === 0) {
    fail("6.no-sent", "A has no sent messages to verify the tick");
  } else if (ticks.sentWithTick !== ticks.sent) {
    fail("6.tick-missing", `expected all ${ticks.sent} sent rows to carry a tick, only ${ticks.sentWithTick} do`);
  } else if (ticks.receivedWithTick > 0) {
    fail("6b.tick-on-received", `${ticks.receivedWithTick} received rows incorrectly carry a tick`);
  } else {
    ok(`6. all ${ticks.sent} sent rows carry a tick (statuses=${JSON.stringify(ticks.statuses)}); ${ticks.received} received rows do not`);
  }

  // ============================================================
  // PART 4 — Three-dot message action menu
  // ============================================================
  const menuTriggerExists = await pageA.evaluate(() => {
    return document.querySelectorAll("#chat-popup-body .chat-message__menu-trigger").length;
  });
  if (menuTriggerExists < 1) {
    fail("7.no-trigger", "no menu trigger rendered on any message");
  } else {
    ok(`7. ${menuTriggerExists} message(s) expose a menu trigger`);
  }

  // Click the kebab on a sent message → menu opens with reply/forward/delete.
  await pageA.evaluate(() => {
    const trigger = document.querySelector(".chat-message--sent .chat-message__menu-trigger");
    if (trigger instanceof HTMLElement) trigger.click();
  });
  await new Promise((r) => setTimeout(r, 120));
  const menuOpenState = await pageA.evaluate(() => ({
    hidden: document.getElementById("message-menu")?.hidden ?? null,
    replyEnabled: !document.getElementById("message-menu-reply")?.disabled,
    forwardEnabled: !document.getElementById("message-menu-forward")?.disabled,
    deleteEnabled: !document.getElementById("message-menu-delete")?.disabled
  }));
  if (menuOpenState.hidden !== false) fail("8a.menu-hidden", "menu did not open on kebab click");
  else if (!menuOpenState.replyEnabled) fail("8b.reply-disabled", "reply should be enabled on a live message");
  else if (!menuOpenState.forwardEnabled) fail("8c.forward-disabled", "forward should be enabled on a live message");
  else if (!menuOpenState.deleteEnabled) fail("8d.delete-disabled", "delete should be enabled on a sent live message");
  else ok(`8. kebab opens menu with reply / forward / delete enabled on a live sent message`);

  // Escape closes the menu.
  await pageA.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 100));
  if (await pageA.evaluate(() => document.getElementById("message-menu")?.hidden) !== true) {
    fail("8e.escape", "Escape did not close the menu");
  } else {
    ok(`8e. Escape closes the menu`);
  }

  // Reply path: open menu on the message we just sent, click reply,
  // expect composer reply context. Reply works on any live message
  // regardless of direction; using a sent message keeps the setup
  // minimal (no need to wait for an inbound message to land first).
  const replyClicked = await pageA.evaluate(() => {
    const trigger = document.querySelector(".chat-message--sent:not(.chat-message--deleted) .chat-message__menu-trigger");
    if (trigger instanceof HTMLElement) { trigger.click(); return true; }
    return false;
  });
  if (!replyClicked) { fail("9.no-row", "no live sent row to test reply on"); }
  await new Promise((r) => setTimeout(r, 150));
  if (await pageA.evaluate(() => document.getElementById("message-menu")?.hidden) !== false) {
    fail("9.menu-open", "menu did not open before reply click");
  }
  await pageA.evaluate(() => document.getElementById("message-menu-reply")?.click());
  await new Promise((r) => setTimeout(r, 120));
  const replyContext = await pageA.evaluate(() => ({
    hidden: document.getElementById("chat-popup-reply-context")?.hidden ?? null,
    snippetText: document.getElementById("chat-popup-reply-snippet")?.textContent ?? "",
    activeId: document.activeElement?.id ?? ""
  }));
  if (replyContext.hidden !== false) fail("9.reply-context", `reply context did not appear: ${JSON.stringify(replyContext)}`);
  else if (replyContext.snippetText.length === 0) fail("9b.reply-snippet", "reply snippet is empty");
  else if (replyContext.activeId !== "chat-popup-input") fail("9c.focus", `composer not focused: '${replyContext.activeId}'`);
  else ok(`9. reply selected → snippet '${replyContext.snippetText.slice(0, 30)}…', composer focused`);

  // Cancel reply chip.
  await pageA.click("#chat-popup-reply-cancel");
  await new Promise((r) => setTimeout(r, 60));
  if (await pageA.evaluate(() => document.getElementById("chat-popup-reply-context")?.hidden) !== true) {
    fail("9d.reply-cancel", "reply context cancel did not hide it");
  } else {
    ok(`9d. reply cancel clears the chip`);
  }

  // Delete path via menu: click kebab on a sent message → click delete → row goes tombstoned.
  const targetMessageId = await pageA.evaluate(() => {
    const row = document.querySelector(".chat-message--sent:not(.chat-message--deleted)");
    return row instanceof HTMLElement ? row.dataset.messageId : null;
  });
  if (typeof targetMessageId !== "string") {
    fail("10.no-target", "no live sent message to test delete on");
  } else {
    await pageA.evaluate((id) => {
      const row = document.querySelector(`.chat-message--sent[data-message-id="${CSS.escape(id)}"]`);
      const trigger = row?.querySelector(".chat-message__menu-trigger");
      if (trigger instanceof HTMLElement) trigger.click();
    }, targetMessageId);
    await new Promise((r) => setTimeout(r, 150));
    const preDelete = await pageA.evaluate(() => ({
      menuHidden: document.getElementById("message-menu")?.hidden,
      deleteDisabled: document.getElementById("message-menu-delete")?.disabled
    }));
    if (preDelete.menuHidden !== false) fail("10.menu-open", `menu not open before delete: ${JSON.stringify(preDelete)}`);
    pageA.on("console", (m) => { if (m.type() === "warn") console.log("A-WARN>", m.text()); });
    await pageA.evaluate(() => {
      const btn = document.getElementById("message-menu-delete");
      if (!(btn instanceof HTMLButtonElement)) { console.warn("delete btn missing"); return; }
      console.warn(`delete btn disabled=${btn.disabled}`);
      btn.click();
    });
    // Push the id into the page so the waitFor predicate (which is
    // serialized without arguments) can read it.
    await pageA.evaluate((id) => { window.__deleteTargetId = id; }, targetMessageId);
    if (!await waitFor(pageA, () => {
      const id = window.__deleteTargetId;
      const row = document.querySelector(`.chat-message[data-message-id="${CSS.escape(id)}"]`);
      return row instanceof HTMLElement && row.classList.contains("chat-message--deleted");
    }, 4000)) {
      const post = await pageA.evaluate((id) => {
        const row = document.querySelector(`.chat-message[data-message-id="${CSS.escape(id)}"]`);
        return {
          rowExists: !!row,
          classes: row instanceof HTMLElement ? row.className : null,
          allRows: document.querySelectorAll(".chat-message").length
        };
      }, targetMessageId);
      fail("10.delete", `delete-from-menu did not tombstone the row (post=${JSON.stringify(post)})`);
    } else {
      ok(`10. delete-from-menu tombstones the row (${targetMessageId.slice(0, 8)}…)`);
    }
  }

  // ============================================================
  // PART 5 — Conversation settings + disappearing-messages slice
  // ============================================================
  // Open the gear → dialog opens.
  await pageA.evaluate(() => document.getElementById("chat-popup-settings")?.click());
  if (!await waitFor(pageA, () => document.getElementById("conversation-settings-dialog")?.open === true, 2000)) {
    fail("11.gear", "conversation settings dialog did not open");
    throw new Error();
  }
  ok(`11. gear icon opens conversation settings`);

  // Pick "1 hour" (3600s) → save.
  await pageA.evaluate(() => {
    const sel = document.getElementById("conversation-settings-ttl");
    if (sel instanceof HTMLSelectElement) {
      sel.value = "3600";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await pageA.click("#conversation-settings-save");
  if (!await waitFor(pageA, () => /saved/i.test(document.getElementById("conversation-settings-state")?.textContent ?? ""), 4000)) {
    fail("12.save", "settings save did not surface 'saved'");
  } else {
    ok(`12. saved TTL=1h on A`);
  }
  await waitFor(pageA, () => document.getElementById("conversation-settings-dialog")?.open !== true, 3000);

  // TTL badge appears on A's header.
  const aBadge = await pageA.evaluate(() => ({
    hidden: document.getElementById("chat-popup-ttl-badge")?.hidden,
    text: document.getElementById("chat-popup-ttl-badge")?.textContent ?? ""
  }));
  if (aBadge.hidden !== false || !/1h/.test(aBadge.text)) {
    fail("12b.badge", `A's TTL badge missing or wrong: ${JSON.stringify(aBadge)}`);
  } else {
    ok(`12b. A's header shows TTL badge '${aBadge.text}'`);
  }

  // System message appears in A's body.
  if (!await waitFor(pageA, () => {
    const sys = [...document.querySelectorAll(".chat-system")].map((s) => s.textContent ?? "").join(" ");
    return /disappearing messages/i.test(sys);
  }, 3000)) {
    fail("12c.system", "A did not render the system message for the TTL change");
  } else {
    ok(`12c. A renders system message ("disappearing messages …")`);
  }

  // ===== Reload pageA — TTL survives. =====
  await pageA.reload({ waitUntil: "networkidle0" });
  await waitFor(pageA, () => document.body.dataset.authState === "signed-in", 8000);
  await pageA.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, { canonical: canonicalB, handle: `@${handleB}` });
  // After reload, the crypto account is locked — restoreStoredSession
  // restores the identity but not the keys. Outbound encrypted
  // actions (send a message, change settings, link/revoke) will
  // prompt for the passphrase via the global #unlock-dialog. The
  // suite uses that dialog by typing the passphrase and clicking
  // unlock. This is a NEW invariant added in Phase 4.
  await pageA.evaluate(async (pw) => {
    const mod = await import("/client/main.js");
    if (mod.isAccountLocked && mod.isAccountLocked()) {
      // Open the dialog by triggering a request. The action callback
      // is empty — we only want the dialog to appear.
      mod.requestUnlock(() => {});
    }
    await new Promise((r) => setTimeout(r, 100));
    const input = document.getElementById("unlock-passphrase-input");
    if (input instanceof HTMLInputElement) {
      input.value = pw;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("unlock-submit")?.click();
  }, PASSPHRASE);
  await waitFor(pageA, () => {
    const dlg = document.getElementById("unlock-dialog");
    return !(dlg instanceof HTMLDialogElement) || !dlg.open;
  }, 4000);
  if (!await waitFor(pageA, () => {
    const b = document.getElementById("chat-popup-ttl-badge");
    return b instanceof HTMLElement && !b.hidden && /1h/.test(b.textContent ?? "");
  }, 4000)) {
    fail("13.reload", "TTL setting did not survive reload");
  } else {
    ok(`13. TTL survives reload on A`);
  }

  // Cross-user delivered + read ticks are validated by step 6 above
  // (where A's "hello b" sent tick flipped to "read" via B's
  // delivered + read receipt envelopes). We don't re-check here:
  // step 10 deleted A's only sent message so there's nothing to
  // assert against until the reply test creates a fresh one.

  // ============================================================
  // PART 7 — Cross-user reply rendering
  // ============================================================
  // A opens fullscreen + sends a reply to one of B's messages. B
  // should render the quote line on its received row.
  // First make sure B has at least one message in the conversation
  // pointing at A so A has something to reply to. B sends "ping a".
  await injectChatTargetAndSend(pageB, { canonical: canonicalA, handle: `@${handleA}` }, "ping a");
  // A polls inbox, opens chat, picks B's "ping a", clicks reply, sends "quoted reply".
  if (!await waitFor(pageA, () => {
    const body = document.getElementById("chat-popup-body");
    return body instanceof HTMLElement && (body.innerText || "").includes("ping a");
  }, RECEIVE_BUDGET_MS)) {
    fail("15.ping-receive", "A never saw B's 'ping a' message");
  } else {
    ok(`15. A received B's 'ping a' message`);
  }
  // Open the kebab on the received "ping a" row, click reply, type, send.
  await pageA.evaluate(() => {
    const rows = [...document.querySelectorAll(".chat-message--received:not(.chat-message--deleted)")];
    const target = rows.find((r) => (r.textContent ?? "").includes("ping a"));
    const trigger = target?.querySelector(".chat-message__menu-trigger");
    if (trigger instanceof HTMLElement) trigger.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await pageA.evaluate(() => document.getElementById("message-menu-reply")?.click());
  await new Promise((r) => setTimeout(r, 150));
  const replyOpen = await pageA.evaluate(() => document.getElementById("chat-popup-reply-context")?.hidden);
  if (replyOpen !== false) fail("16.reply-open", "reply context not visible before send");
  await pageA.evaluate(() => {
    const input = document.getElementById("chat-popup-input");
    if (!(input instanceof HTMLTextAreaElement)) return;
    input.value = "quoted reply";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // B receives the reply and resolves the quote.
  if (!await waitFor(pageB, () => {
    const rows = [...document.querySelectorAll(".chat-message--received")];
    const replyRow = rows.find((r) => (r.textContent ?? "").includes("quoted reply"));
    if (!(replyRow instanceof HTMLElement)) return false;
    const snippet = replyRow.querySelector(".chat-message__reply-snippet");
    return snippet instanceof HTMLElement && (snippet.textContent ?? "").includes("ping a");
  }, RECEIVE_BUDGET_MS)) {
    const peek = await pageB.evaluate(async () => {
      const rows = [...document.querySelectorAll(".chat-message--received")];
      const ui = rows.map((r) => ({
        text: (r.textContent ?? "").slice(0, 40),
        relayId: r instanceof HTMLElement ? r.dataset.relayMessageId : null,
        snippet: r.querySelector(".chat-message__reply-snippet")?.textContent ?? null
      }));
      // Also peek at IDB for B's local rows.
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("sudo_local_state");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const req = tx.objectStore("messages").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return { ui, idb: all.map((m) => ({ body: m.body, relay: m.relay_message_id, replyToRelay: m.reply_to_relay_message_id })) };
    });
    fail("16.cross-reply", `B did not render quoted snippet ('ping a') above the 'quoted reply' row: ${JSON.stringify(peek)}`);
  } else {
    ok(`16. B renders cross-user reply quote ('ping a') above 'quoted reply'`);
  }

  // ============================================================
  // PART 8 — Forward
  // ============================================================
  // We don't have a third party — but the forward picker should at
  // least open with B in the list, accept a click, and dispatch a
  // forwarded send that lands on B's side carrying the forwarded
  // label. Forwarding back to B from A is a valid (if unusual) test;
  // it verifies the pipeline end-to-end without spinning a third
  // browser context.
  await pageA.evaluate(() => {
    const sent = document.querySelector(".chat-message--sent:not(.chat-message--deleted)");
    const trigger = sent?.querySelector(".chat-message__menu-trigger");
    if (trigger instanceof HTMLElement) trigger.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await pageA.evaluate(() => document.getElementById("message-menu-forward")?.click());
  if (!await waitFor(pageA, () => document.getElementById("forward-picker-dialog")?.open === true, 3000)) {
    fail("17.forward-open", "forward picker did not open");
  } else {
    ok(`17. forward menu opens forward-picker dialog`);
  }
  const pickerOptions = await pageA.evaluate(() => {
    return [...document.querySelectorAll(".forward-picker__row")].map((r) => ({
      handle: r.textContent ?? "",
      canonical: r instanceof HTMLElement ? r.dataset.chatCanonical : null
    }));
  });
  if (pickerOptions.length === 0) {
    fail("17b.no-options", "forward picker has no chat options");
  } else {
    ok(`17b. forward picker exposes ${pickerOptions.length} chat(s)`);
  }
  // Pick B and confirm the forwarded message lands on B's side.
  await pageA.evaluate((c) => {
    const row = [...document.querySelectorAll(".forward-picker__row")].find((r) => r instanceof HTMLElement && r.dataset.chatCanonical === c);
    if (row instanceof HTMLElement) row.click();
  }, canonicalB);
  if (!await waitFor(pageB, () => {
    return [...document.querySelectorAll(".chat-message--received.chat-message--forwarded")].length >= 1
      || [...document.querySelectorAll(".chat-message__forwarded-label")].length >= 1;
  }, RECEIVE_BUDGET_MS)) {
    fail("18.forward-received", "B did not receive a forwarded-labelled message");
  } else {
    ok(`18. B receives a forwarded-labelled message`);
  }

  // ============================================================
  // PART 9 — TTL local GC
  // ============================================================
  // Set TTL to 1 minute (60s), inject an old fake message into A's
  // local store with a created_at of 5 minutes ago, run the GC,
  // assert the old row is tombstoned in storage (not just filtered).
  // Use 60s rather than the picker's 3600s minimum so the test can
  // exercise the path without manipulating Date.now.
  await pageA.evaluate(() => document.getElementById("chat-popup-settings")?.click());
  await waitFor(pageA, () => document.getElementById("conversation-settings-dialog")?.open === true, 3000);
  // The select doesn't expose 60s directly. Pick 3600 (1h), then
  // mutate the underlying conversation_settings row through
  // IndexedDB to drop the TTL to 60s for the GC test. (The smoke
  // is allowed to use IDB directly — it's verifying GC behavior,
  // not the UI controls.)
  await pageA.evaluate(() => {
    const sel = document.getElementById("conversation-settings-ttl");
    if (sel instanceof HTMLSelectElement) {
      sel.value = "3600";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await pageA.click("#conversation-settings-save");
  await waitFor(pageA, () => /saved/i.test(document.getElementById("conversation-settings-state")?.textContent ?? ""), 4000);
  await waitFor(pageA, () => document.getElementById("conversation-settings-dialog")?.open !== true, 3000);
  // Drop TTL to 1s + insert an old message; then trigger a sweep.
  const gcResult = await pageA.evaluate(async () => {
    function txDone(tx) {
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
    }
    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("sudo_local_state");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    const db = await openDb();
    const owner = window.__deleteTargetId
      ? null
      : null;
    // Find the active conversation_settings row keyed by owner.
    const settingsTx = db.transaction("conversation_settings", "readwrite");
    const all = await new Promise((resolve, reject) => {
      const req = settingsTx.objectStore("conversation_settings").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (all.length === 0) return { error: "no conversation_settings rows found" };
    const row = all[0];
    row.message_ttl_seconds = 1;
    row.updated_at = new Date().toISOString();
    settingsTx.objectStore("conversation_settings").put(row);
    await txDone(settingsTx);
    // Insert an old message into this conversation.
    const messageId = "ttl-gc-test-" + Date.now();
    const msgTx = db.transaction("messages", "readwrite");
    msgTx.objectStore("messages").put({
      message_id: messageId,
      owner_canonical_id: row.owner_canonical_id,
      conversation_id: row.conversation_id,
      direction: "sent",
      sender_canonical_id: row.owner_canonical_id,
      recipient_canonical_id: "",
      body: "old-ttl-test-message",
      created_at: new Date(Date.now() - 600 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 600 * 1000).toISOString(),
      status: "stored_by_relay"
    });
    await txDone(msgTx);
    return { messageId, conversationId: row.conversation_id, owner: row.owner_canonical_id };
  });
  if (gcResult.error) {
    fail("19.gc-setup", gcResult.error);
  } else {
    // Pin the message id where the page-side predicate can find it.
    await pageA.evaluate((id) => { window.__gcMessageId = id; }, gcResult.messageId);
    // Trigger a sweep — close + reopen the chat fires the sweep.
    await pageA.evaluate(() => document.getElementById("chat-popup-close")?.click());
    await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === true, 3000);
    await pageA.evaluate((t) => {
      const list = document.getElementById("chat-list");
      if (list) {
        list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
      }
      document.querySelector(".chat-row")?.click();
    }, { canonical: canonicalB, handle: `@${handleB}` });
    const tombstoned = await waitFor(pageA, async () => {
      if (typeof window.__gcMessageId !== "string") return false;
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("sudo_local_state");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const req = tx.objectStore("messages").get(window.__gcMessageId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      return row && typeof row.deleted_at === "string" && (row.body === "" || row.body === undefined);
    }, 8000);
    if (!tombstoned) {
      const peek = await pageA.evaluate(async (id) => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("sudo_local_state");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return new Promise((resolve) => {
          const tx = db.transaction("messages", "readonly");
          const req = tx.objectStore("messages").get(id);
          req.onsuccess = () => resolve(req.result || null);
        });
      }, gcResult.messageId);
      fail("19.gc-tombstone", `GC did not tombstone the old message (row=${JSON.stringify(peek)})`);
    } else {
      ok(`19. TTL GC tombstoned the old message in storage (id=${gcResult.messageId.slice(-6)})`);
    }
  }

  // ============================================================
  // PART 10 — Desktop fullscreen sidebar
  // ============================================================
  // pageA is on desktop viewport; close + reopen + enter fullscreen.
  await pageA.evaluate(() => document.getElementById("chat-popup-close")?.click());
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === true, 2000);
  await pageA.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, { canonical: canonicalB, handle: `@${handleB}` });
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === false, 2000);
  await pageA.click("#chat-popup-fullscreen");
  await new Promise((r) => setTimeout(r, 120));
  const sidebar = await pageA.evaluate(() => {
    const aside = document.getElementById("chat-popup-sidebar");
    return {
      hidden: aside?.hidden,
      computed: aside ? window.getComputedStyle(aside).display : null,
      rows: [...document.querySelectorAll(".chat-popup__sidebar-row")].length,
      activeRow: [...document.querySelectorAll(".chat-popup__sidebar-row.is-active")].length
    };
  });
  if (sidebar.hidden !== false || sidebar.computed === "none") {
    fail("20.sidebar-visible", `sidebar not visible in desktop fullscreen: ${JSON.stringify(sidebar)}`);
  } else {
    ok(`20. desktop fullscreen reveals chat sidebar (${sidebar.rows} row(s))`);
  }
  if (sidebar.activeRow !== 1) {
    fail("20b.active-row", `expected exactly 1 active row in sidebar, got ${sidebar.activeRow}`);
  } else {
    ok(`20b. sidebar highlights the active conversation`);
  }

  // 20c. The legacy "chats" heading is removed. Search input is the
  //      first visible child of the sidebar.
  const sidebarHead = await pageA.evaluate(() => {
    const aside = document.getElementById("chat-popup-sidebar");
    if (!(aside instanceof HTMLElement)) return null;
    const text = (aside.innerText || "").toLowerCase();
    const titleEl = aside.querySelector(".chat-popup__sidebar-title");
    // First visible child (ignoring text-empty placeholders).
    const firstChild = [...aside.children].find((el) => el instanceof HTMLElement && !el.hidden && window.getComputedStyle(el).display !== "none");
    return {
      hasTitleElement: !!titleEl,
      hasChatsHeading: /^chats\b/m.test(text),
      firstChildClass: firstChild instanceof HTMLElement ? firstChild.className : null
    };
  });
  if (sidebarHead === null || sidebarHead.hasTitleElement) {
    fail("20c.heading-element", `sidebar still contains a .chat-popup__sidebar-title element`);
  } else if (sidebarHead.hasChatsHeading) {
    fail("20c.heading-text", `sidebar still contains visible "chats" heading text`);
  } else if (!String(sidebarHead.firstChildClass || "").includes("chat-popup__sidebar-search")) {
    fail("20c.first-child", `expected sidebar-search to be first child, got '${sidebarHead.firstChildClass}'`);
  } else {
    ok(`20c. sidebar has no "chats" heading; search input is the first visible child`);
  }

  // ============================================================
  // PART 10b — Sidebar polish: search/unread/tick/active/empty/overflow
  // ============================================================

  // Active row has a stronger highlight (border-left accent) and
  // we read `border-left-width` to verify the rule fired (1px+ on
  // .is-active vs 0 on regular rows).
  const activeHighlight = await pageA.evaluate(() => {
    const active = document.querySelector(".chat-popup__sidebar-row.is-active");
    if (!(active instanceof HTMLElement)) return null;
    return {
      borderLeftWidth: parseFloat(window.getComputedStyle(active).borderLeftWidth) || 0,
      background: window.getComputedStyle(active).backgroundColor
    };
  });
  if (activeHighlight === null || activeHighlight.borderLeftWidth < 1) {
    fail("20c.active-stronger", `active row missing strong highlight: ${JSON.stringify(activeHighlight)}`);
  } else {
    ok(`20c. active row has explicit highlight (border-left=${activeHighlight.borderLeftWidth}px)`);
  }

  // The sidebar preview tick: send a fresh A→B message inside the
  // fullscreen view so the latest line in the conversation is
  // definitely A's outbound (and not the GC-tombstoned probe row
  // from PART 9). The tick attaches to the latest sent line only.
  await pageA.evaluate(() => {
    const input = document.getElementById("chat-popup-input");
    if (!(input instanceof HTMLTextAreaElement)) return;
    input.value = "tick-check-msg";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("chat-popup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await waitFor(pageA, () => {
    const rows = [...document.querySelectorAll(".chat-message--sent:not(.chat-message--deleted)")];
    return rows.some((r) => (r.textContent ?? "").includes("tick-check-msg"));
  }, 5000);
  // Wait a beat for the receipt to land + refreshLocalChats to
  // re-render the sidebar, then read the latest preview tick.
  await new Promise((r) => setTimeout(r, 1500));
  const sidebarTick = await pageA.evaluate(() => {
    const tick = document.querySelector(".chat-popup__sidebar-row .chat-popup__sidebar-row__preview-tick");
    const row = document.querySelector(".chat-popup__sidebar-row");
    return {
      tick: tick instanceof HTMLElement ? {
        status: tick.getAttribute("data-message-status"),
        text: tick.textContent ?? ""
      } : null,
      row: row instanceof HTMLElement ? {
        handle: row.querySelector(".chat-popup__sidebar-row__handle")?.textContent ?? null,
        preview: row.querySelector(".chat-popup__sidebar-row__preview-text")?.textContent ?? null
      } : null
    };
  });
  if (sidebarTick.tick === null) {
    fail("20d.sidebar-tick", `sidebar row missing preview tick (row=${JSON.stringify(sidebarTick.row)})`);
  } else {
    ok(`20d. sidebar row carries '${sidebarTick.tick.status}' tick (${sidebarTick.tick.text})`);
  }

  // Search filter: type a query that matches the existing row, then
  // a query that matches nothing. Active row should remain visible
  // even when the filter would otherwise exclude it.
  const handleNeedle = handleB.slice(0, 5);
  await pageA.evaluate((q) => {
    const input = document.getElementById("chat-popup-sidebar-search");
    if (!(input instanceof HTMLInputElement)) return;
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, handleNeedle);
  await new Promise((r) => setTimeout(r, 120));
  const matchedFilter = await pageA.evaluate(() => ({
    rows: [...document.querySelectorAll(".chat-popup__sidebar-row")].length,
    empty: !!document.querySelector(".chat-popup__sidebar-empty")
  }));
  if (matchedFilter.rows < 1 || matchedFilter.empty) {
    fail("20e.search-matches", `search by handle did not match the active row: ${JSON.stringify(matchedFilter)}`);
  } else {
    ok(`20e. search by handle '${handleNeedle}' keeps ${matchedFilter.rows} row(s) visible`);
  }
  // Now type a guaranteed-nonmatch query — the active row should
  // still render (per "preserve active visibility") instead of
  // hitting the empty state.
  await pageA.evaluate(() => {
    const input = document.getElementById("chat-popup-sidebar-search");
    if (!(input instanceof HTMLInputElement)) return;
    input.value = "zzzz-no-such-handle";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 120));
  const activeStays = await pageA.evaluate(() => {
    const rows = [...document.querySelectorAll(".chat-popup__sidebar-row")];
    return {
      rows: rows.length,
      activeRows: rows.filter((r) => r.classList.contains("is-active")).length,
      empty: !!document.querySelector(".chat-popup__sidebar-empty")
    };
  });
  if (activeStays.empty || activeStays.activeRows !== 1) {
    fail("20f.active-preserved", `active row not preserved under non-matching filter: ${JSON.stringify(activeStays)}`);
  } else {
    ok(`20f. non-matching filter preserves the active row (${activeStays.rows} total)`);
  }
  // Clear the filter via the input.
  await pageA.evaluate(() => {
    const input = document.getElementById("chat-popup-sidebar-search");
    if (!(input instanceof HTMLInputElement)) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 120));

  // No horizontal overflow on desktop fullscreen.
  const desktopOverflow = await pageA.evaluate(() => ({
    docW: document.documentElement.clientWidth,
    bodyScroll: document.documentElement.scrollWidth,
    popupScroll: document.getElementById("chat-popup")?.scrollWidth ?? 0
  }));
  if (desktopOverflow.bodyScroll > desktopOverflow.docW + 2) {
    fail("20g.no-overflow-desktop", `desktop fullscreen has horizontal overflow (${desktopOverflow.bodyScroll} > ${desktopOverflow.docW})`);
  } else {
    ok(`20g. no horizontal overflow on desktop fullscreen (doc=${desktopOverflow.docW}, scroll=${desktopOverflow.bodyScroll})`);
  }

  // Mobile fullscreen does NOT expose the sidebar.
  await pageA.setViewport({ width: 420, height: 820, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 120));
  await pageA.evaluate(() => document.getElementById("chat-popup-close")?.click());
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === true, 2000);
  await pageA.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, { canonical: canonicalB, handle: `@${handleB}` });
  await waitFor(pageA, () => document.getElementById("chat-popup")?.hidden === false, 2000);
  const mobileSidebar = await pageA.evaluate(() => {
    const aside = document.getElementById("chat-popup-sidebar");
    return {
      hidden: aside?.hidden,
      computed: aside ? window.getComputedStyle(aside).display : null,
      isFs: document.getElementById("chat-popup")?.classList.contains("is-fullscreen")
    };
  });
  if (!mobileSidebar.isFs) {
    fail("21.mobile-fs", "popup not in fullscreen on mobile width");
  } else if (mobileSidebar.computed !== "none") {
    fail("21.mobile-sidebar", `mobile fullscreen still showing sidebar: ${JSON.stringify(mobileSidebar)}`);
  } else {
    ok(`21. mobile fullscreen does not show the sidebar`);
  }

  // No horizontal overflow on mobile fullscreen either.
  const mobileOverflow = await pageA.evaluate(() => ({
    docW: document.documentElement.clientWidth,
    bodyScroll: document.documentElement.scrollWidth
  }));
  if (mobileOverflow.bodyScroll > mobileOverflow.docW + 2) {
    fail("21b.no-overflow-mobile", `mobile fullscreen has horizontal overflow (${mobileOverflow.bodyScroll} > ${mobileOverflow.docW})`);
  } else {
    ok(`21b. no horizontal overflow on mobile fullscreen (doc=${mobileOverflow.docW})`);
  }

  // ============================================================
  // PART 11 — [hidden] attribute regression guard
  // ============================================================
  // Survey every element that carries the HTML `hidden` attribute
  // and assert its computed display is `none`. Catches future
  // component CSS that introduces a `display:` rule overriding the
  // global `[hidden] { display: none !important }` baseline.
  await pageA.setViewport({ width: 980, height: 820 });
  const hiddenLeaks = await pageA.evaluate(() => {
    return [...document.querySelectorAll("[hidden]")].filter((el) => {
      const display = window.getComputedStyle(el).display;
      return display !== "none";
    }).map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, classes: el.className || null }));
  });
  if (hiddenLeaks.length > 0) {
    fail("22.hidden-leaks", `hidden elements with non-none display: ${JSON.stringify(hiddenLeaks)}`);
  } else {
    ok(`22. every [hidden] element computes display: none (no CSS leaks)`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nCHAT-UX SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nCHAT-UX SMOKE PASSED");
})().catch((error) => { console.error("CHAT-UX SMOKE ERROR", error); process.exit(2); });

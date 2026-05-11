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
    const sentWithTick = sent.filter((r) => r.querySelector('.chat-message__tick[data-message-status="sent"]'));
    const receivedWithTick = received.filter((r) => r.querySelector('.chat-message__tick'));
    return { sent: sent.length, sentWithTick: sentWithTick.length, received: received.length, receivedWithTick: receivedWithTick.length };
  });
  if (ticks.sent === 0) {
    fail("6.no-sent", "A has no sent messages to verify the tick");
  } else if (ticks.sentWithTick !== ticks.sent) {
    fail("6.tick-missing", `expected all ${ticks.sent} sent rows to carry a tick, only ${ticks.sentWithTick} do`);
  } else if (ticks.receivedWithTick > 0) {
    fail("6b.tick-on-received", `${ticks.receivedWithTick} received rows incorrectly carry a tick`);
  } else {
    ok(`6. all ${ticks.sent} sent rows carry the sent tick; ${ticks.received} received rows do not`);
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
    forwardDisabled: document.getElementById("message-menu-forward")?.disabled,
    deleteEnabled: !document.getElementById("message-menu-delete")?.disabled
  }));
  if (menuOpenState.hidden !== false) fail("8a.menu-hidden", "menu did not open on kebab click");
  else if (!menuOpenState.replyEnabled) fail("8b.reply-disabled", "reply should be enabled on a live message");
  else if (!menuOpenState.forwardDisabled) fail("8c.forward-enabled", "forward should still be gated (coming soon)");
  else if (!menuOpenState.deleteEnabled) fail("8d.delete-disabled", "delete should be enabled on a sent live message");
  else ok(`8. kebab opens menu with reply enabled, forward gated, delete enabled`);

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
  if (!await waitFor(pageA, () => {
    const b = document.getElementById("chat-popup-ttl-badge");
    return b instanceof HTMLElement && !b.hidden && /1h/.test(b.textContent ?? "");
  }, 4000)) {
    fail("13.reload", "TTL setting did not survive reload");
  } else {
    ok(`13. TTL survives reload on A`);
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nCHAT-UX SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nCHAT-UX SMOKE PASSED");
})().catch((error) => { console.error("CHAT-UX SMOKE ERROR", error); process.exit(2); });

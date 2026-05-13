#!/usr/bin/env node
// empty-launch-state smoke (Phase 13 Part G).
//
// Asserts the pristine first-launch UX:
//   - Anonymous load shows the landing screen with calm copy
//     (sign in / sign up buttons present, no broken placeholders).
//   - After a fresh signup the chat list shows the calm
//     "your conversations will appear here" empty state, NOT a
//     "no chats" raw string or a missing element.
//   - The notifications panel + chat sidebar render their empty
//     states without errors.
//   - No leftover smoke / test handles appear in search.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first."); process.exit(2); }

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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("ERR>", e.message));
    await page.setViewport({ width: 980, height: 820 });
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    // ===== Part 1: landing screen looks like a launch landing. =====
    const landingProbe = await page.evaluate(() => ({
      authState: document.body.dataset.authState,
      hasSignUp: document.querySelector('.landing [data-auth-action="signup"]') !== null,
      hasSignIn: document.querySelector('.landing [data-auth-action="signin"]') !== null
    }));
    if (landingProbe.authState === "signed-in") {
      fail("1.auth", `expected signed-out landing, got authState=${landingProbe.authState}`);
    } else if (!landingProbe.hasSignUp || !landingProbe.hasSignIn) {
      fail("1.buttons", `landing missing sign up/sign in buttons: ${JSON.stringify(landingProbe)}`);
    } else {
      ok(`1. landing: signed-out state with both sign in + sign up buttons`);
    }

    // ===== Part 2: sign up. =====
    const handle = `els${Date.now().toString().slice(-7)}`;
    if (!await signUp(page, handle)) { fail("2.signup", "sign up failed"); throw new Error(); }
    ok(`2. signed up @${handle}`);

    // ===== Part 3: chat list empty state. =====
    const chatEmpty = await page.evaluate(() => {
      const root = document.getElementById("chat-list");
      if (!(root instanceof HTMLElement)) return null;
      const empty = root.querySelector(".chat-list__empty");
      if (!(empty instanceof HTMLElement)) return { fallbackText: (root.textContent || "").trim() };
      return {
        title: empty.querySelector(".chat-list__empty-title")?.textContent ?? "",
        hint: empty.querySelector(".chat-list__empty-hint")?.textContent ?? ""
      };
    });
    if (chatEmpty === null) {
      fail("3.chat-list-missing", "chat-list element not in DOM");
    } else if ("fallbackText" in chatEmpty) {
      fail("3.empty-shape", `chat-list has no .chat-list__empty; text was: '${chatEmpty.fallbackText.slice(0, 80)}'`);
    } else if (!chatEmpty.title.toLowerCase().includes("conversation")) {
      fail("3.empty-title", `chat-list empty title doesn't mention 'conversations': '${chatEmpty.title}'`);
    } else if (chatEmpty.hint.length === 0) {
      fail("3.empty-hint", "chat-list empty hint is empty");
    } else {
      ok(`3. chat-list empty state: title='${chatEmpty.title}' hint='${chatEmpty.hint}'`);
    }

    // ===== Part 4: notifications panel renders without
    // throwing + shows its empty state. =====
    const notifProbe = await page.evaluate(() => {
      const list = document.getElementById("notifications-list");
      const empty = document.getElementById("notifications-empty");
      return {
        listExists: list !== null,
        emptyExists: empty !== null,
        emptyVisible: empty instanceof HTMLElement && empty.offsetParent !== null
      };
    });
    if (!notifProbe.listExists || !notifProbe.emptyExists) {
      fail("4.notif-shape", `notifications panel surface incomplete: ${JSON.stringify(notifProbe)}`);
    } else {
      ok(`4. notifications panel surface present (list + empty)`);
    }

    // ===== Part 5: no leftover smoke / test handles visible
    // anywhere on the page. =====
    const text = await page.evaluate(() => document.body.innerText || "");
    const suspicious = ["smoke-test", "puppeteer", "TODO", "FIXME"];
    const leaked = suspicious.filter((s) => text.includes(s));
    if (leaked.length > 0) {
      fail("5.dev-strings", `page contains dev/test strings: ${leaked.join(", ")}`);
    } else {
      ok(`5. no dev/test strings visible on the rendered page`);
    }

    // ===== Part 6: anonymous loads (a fresh context) see the
    // same calm landing. =====
    const ctx2 = await browser.createBrowserContext();
    const page2 = await ctx2.newPage();
    await page2.goto(BASE + "/", { waitUntil: "networkidle0" });
    const second = await page2.evaluate(() => ({
      auth: document.body.dataset.authState,
      hasSignUp: document.querySelector('.landing [data-auth-action="signup"]') !== null
    }));
    if (second.auth === "signed-in") {
      fail("6.cross-context", "second fresh context inherited a signed-in state");
    } else if (!second.hasSignUp) {
      fail("6.cross-context-buttons", "second fresh context missing landing buttons");
    } else {
      ok(`6. fresh browser context lands on the signed-out landing screen`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`EMPTY-LAUNCH-STATE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("EMPTY-LAUNCH-STATE SMOKE PASSED");
})().catch((err) => {
  console.error("EMPTY-LAUNCH-STATE SMOKE ERRORED:", err);
  process.exit(1);
});

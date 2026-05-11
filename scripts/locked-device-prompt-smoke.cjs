#!/usr/bin/env node
// Inline passphrase prompt smoke. Covers the post-reload path: the
// user's identity is restored from the session token but the in-
// memory crypto account is locked — clicking a device action must
// surface an inline passphrase prompt (not legacy "unlock your
// account first" copy) and then replay the action after unlock.
//
// Wired up as `npm run smoke:locked-device-prompt`.
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const puppeteer = require(PUPPETEER_CORE_PATH);

const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const failures = [];
const fail = (l, m) => { failures.push(`${l}: ${m}`); console.error("FAIL:", l, "-", m); };
const ok = (l) => console.log("ok:", l);
async function waitFor(page, p, t=15000) { const s=Date.now(); while (Date.now()-s<t) { if (await page.evaluate(p)) return true; await new Promise(r=>setTimeout(r,80)); } return false; }

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: "new", args: ["--no-sandbox"] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 980, height: 820 });
  page.on("pageerror", (e) => console.log("PAGE-ERR>", e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handle = `pp${Date.now().toString().slice(-7)}`;
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise(r=>setTimeout(r,200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in")) { fail("signup","no signin"); throw new Error(); }
  ok(`1. signed up @${handle}`);

  // Reload the page so the session restores but the crypto account is locked.
  await page.reload({ waitUntil: "networkidle0" });
  if (!await waitFor(page, () => document.body.dataset.authState === "signed-in")) { fail("reload-signin","no signin after reload"); throw new Error(); }
  ok(`2. session restored (crypto account is locked)`);

  // Open devices dialog.
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(page, () => document.getElementById("devices-dialog")?.open === true);
  ok(`3. devices dialog opened`);

  // Inline prompt and pairing card both hidden by default.
  const initial = await page.evaluate(() => ({
    passprompt: document.getElementById("device-passphrase-prompt")?.hidden,
    pairing: document.getElementById("pairing-card")?.hidden,
    feedback: document.getElementById("device-panel-feedback")?.textContent ?? ""
  }));
  if (initial.passprompt !== true || initial.pairing !== true || /unlock your account first/i.test(initial.feedback)) {
    fail("4.initial-hidden", `unexpected initial state: ${JSON.stringify(initial)}`);
  } else {
    ok(`4. passphrase + pairing panels hidden on open; no 'unlock your account first' copy`);
  }

  // Click 'link another device' — should reveal passphrase prompt, not pairing card.
  await page.evaluate(() => document.getElementById("device-link-start")?.click());
  await new Promise(r=>setTimeout(r,200));
  const afterLinkClick = await page.evaluate(() => ({
    passprompt: document.getElementById("device-passphrase-prompt")?.hidden,
    pairing: document.getElementById("pairing-card")?.hidden,
    feedback: document.getElementById("device-panel-feedback")?.textContent ?? ""
  }));
  if (afterLinkClick.passprompt !== false || afterLinkClick.pairing !== false) {
    // pairing card might be hidden, prompt shown
  }
  if (afterLinkClick.passprompt !== false) {
    fail("5.prompt-visible", `passphrase prompt did not appear: ${JSON.stringify(afterLinkClick)}`);
  } else if (afterLinkClick.pairing !== true) {
    fail("5.pairing-hidden", `pairing card should still be hidden until passphrase is entered: ${JSON.stringify(afterLinkClick)}`);
  } else if (/unlock your account first/i.test(afterLinkClick.feedback)) {
    fail("5.no-locked-copy", `forbidden 'unlock your account first' copy appeared`);
  } else {
    ok(`5. clicking 'link another device' while locked reveals inline passphrase prompt`);
  }

  // Submit passphrase — should unlock and surface the pairing card.
  await page.type("#device-passphrase-input", PASSPHRASE);
  await page.click("#device-passphrase-submit");
  if (!await waitFor(page, () => {
    const card = document.getElementById("pairing-card");
    const code = document.getElementById("pairing-card-code")?.textContent?.trim() ?? "";
    return card instanceof HTMLElement && !card.hidden && /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code);
  }, 15000)) {
    fail("6.unlock-link", "pairing card never appeared after passphrase submit");
  } else {
    const after = await page.evaluate(() => ({
      passprompt: document.getElementById("device-passphrase-prompt")?.hidden,
      code: document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""
    }));
    if (after.passprompt !== true) {
      fail("6.prompt-hidden", `passphrase prompt did not hide after unlock: ${JSON.stringify(after)}`);
    } else {
      ok(`6. passphrase submit unlocked + revealed pairing card with code ${after.code}`);
    }
  }

  await browser.close();
  if (failures.length > 0) {
    console.error(`FAILED (${failures.length})`); process.exit(1);
  }
  console.log("LOCKED-DEVICE-PROMPT SMOKE PASSED");
})().catch((e) => { console.error(e); process.exit(2); });

#!/usr/bin/env node
// Phase 14C copy audit smoke. Locks in the in-app calm-copy contract:
//
//   - The static landing + signed-in shell HTML contains no visible
//     "identity document" string and no visible "canonical id" label.
//   - "collect account" is gone; "link this device" / "link another
//     device" is used instead.
//   - The directory card renders the resolved user's bio under their
//     handle when the bio is set.
//   - When the resolved user has NO bio, no "no bio" placeholder text
//     appears under the handle.
//   - The lookup-card advanced disclosure says "advanced details",
//     not "advanced identity details".
//   - The settings dialog no longer carries the redundant bio editor.
//   - The account dialog's bio editor is wired to the server (so
//     setting a bio in-app surfaces on /u/<handle>).
//
// Wired up as `npm run smoke:copy-audit`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first.\n" + e.message); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => console.log("ok:", label);

async function waitFor(page, predicate, timeoutMs = 8000, intervalMs = 100, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

(async () => {
  // ---- Static markup audit: fetch / and check banned strings.
  const indexResp = await fetch(`${BASE}/`);
  const indexBody = await indexResp.text();
  // Banned visible-text strings on the static landing markup.
  const visibleBanned = [
    ["identity document", /identity document/i],
    ["collect account", /collect account/i],
    ["canonical id", /canonical id/i]
  ];
  for (const [label, re] of visibleBanned) {
    if (re.test(indexBody)) {
      // Allow "canonical id" inside the account dialog's "advanced"
      // disclosure — actually NO, we relabeled it. So fully banned.
      const matches = indexBody.match(re);
      fail(`1.banned-${label.replace(/\s+/g, "-")}`, `"${label}" still appears in index.html (match: ${matches?.[0]})`);
    } else {
      ok(`1. index.html has no "${label}" visible string`);
    }
  }

  // ---- Settings dialog no longer carries the bio editor (moved to
  //      account dialog).
  const hasOldSettingsBio = /id="settings-bio"|id="settings-bio-counter"|id="settings-bio-save"|id="settings-bio-clear"/.test(indexBody);
  if (hasOldSettingsBio) fail("1a.settings-bio-cleanup", "settings dialog still has bio editor ids; should live in account dialog only");
  else ok("1a. settings dialog has no bio editor (consolidated into account dialog)");

  const hasAccountBio = /id="account-bio"|id="account-save-bio"/.test(indexBody);
  if (!hasAccountBio) fail("1b.account-bio", "account dialog missing bio editor");
  else ok("1b. account dialog has bio editor");

  // ---- Boot a browser; sign up two users; verify directory card.
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  async function signUpFresh(handle) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1024, height: 800 });
    page.on("pageerror", (e) => console.log(`PAGEERR(${handle})>`, e.message));
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });
    await page.click('.landing [data-auth-action="signup"]');
    await new Promise((r) => setTimeout(r, 200));
    await page.type("#signup-handle", handle);
    await page.type("#signup-password", PASSPHRASE);
    await page.type("#signup-password-confirm", PASSPHRASE);
    await page.click('#signup-form button[type="submit"]');
    if (!await waitFor(page, () => document.body.dataset.authState === "signed-in", 20000)) {
      throw new Error(`signup ${handle} never signed in`);
    }
    return { ctx, page };
  }

  const aHandle = `ca${Date.now().toString().slice(-7)}`;
  const bHandle = `cb${Date.now().toString().slice(-6)}`;
  const a = await signUpFresh(aHandle);
  const b = await signUpFresh(bHandle);

  // A: open account dialog, type bio, save. Tests the consolidated
  // account-dialog bio editor that writes through the server.
  const newBio = "calm sentences about a calm app.";
  await a.page.evaluate(() => document.getElementById("account-button")?.click());
  await new Promise((r) => setTimeout(r, 120));
  await a.page.evaluate(() => document.getElementById("account-menu-account")?.click());
  if (!await waitFor(a.page, () => document.getElementById("account-dialog")?.open === true)) {
    fail("2.account-open", "account dialog never opened for A");
  } else ok("2. account dialog opens");
  await a.page.evaluate((value) => {
    const ta = document.getElementById("account-bio");
    if (ta instanceof HTMLTextAreaElement) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, newBio);
  await a.page.evaluate(() => document.getElementById("account-save-bio")?.click());
  const saved = await waitFor(a.page, () => /saved/i.test(document.getElementById("account-state")?.textContent ?? ""), 6000);
  if (!saved) {
    const obs = await a.page.evaluate(() => document.getElementById("account-state")?.textContent);
    fail("2a.account-bio-save", `expected "saved" in account state, got '${obs}'`);
  } else ok(`2a. account dialog bio save reports "saved"`);

  // Public profile reflects the new bio (proof the in-app editor
  // wrote through to /api/identity/bio, not just local profile-sync).
  const pubResp = await fetch(`${BASE}/u/${encodeURIComponent(aHandle)}`);
  const pubBody = await pubResp.text();
  if (!pubBody.includes(newBio)) fail("2b.public-bio", `/u/${aHandle} doesn't carry the new bio yet`);
  else ok(`2b. /u/${aHandle} reflects the bio set via account dialog`);

  // B: search for A via the directory. Verify the bio renders under
  // @handle and no banned text leaks.
  await b.page.evaluate((q) => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) {
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, `@${aHandle}`);
  const cardReady = await waitFor(b.page, () => {
    const root = document.getElementById("lookup-result");
    return root !== null && root.querySelector(".lookup-card") !== null;
  }, 6000);
  if (!cardReady) {
    fail("3.directory-card", `directory card never appeared for @${aHandle}`);
  } else {
    const cardMeta = await b.page.evaluate(() => {
      const card = document.querySelector("#lookup-result .lookup-card");
      const bio = card?.querySelector(".lookup-card__bio")?.textContent ?? null;
      const closed = card?.querySelector(".lookup-card__advanced[open]") === null;
      // Capture only text visible BEFORE the user opens "advanced details".
      const visibleText = (() => {
        if (!card) return "";
        const clone = card.cloneNode(true);
        // Remove the advanced details disclosure from the clone so
        // the audit only inspects default-visible copy.
        clone.querySelector(".lookup-card__advanced")?.remove();
        return clone.textContent ?? "";
      })();
      const advSummary = card?.querySelector(".lookup-card__advanced-summary")?.textContent ?? "";
      return { bio, closed, visibleText, advSummary };
    });
    if (cardMeta.bio !== newBio) fail("3a.bio-rendered", `expected bio "${newBio}", got "${cardMeta.bio}"`);
    else ok(`3a. directory card renders bio under @handle`);
    if (/identity document/i.test(cardMeta.visibleText)) fail("3b.no-identity-document", `card visible text contains "identity document"`);
    else ok(`3b. directory card has no visible "identity document" copy`);
    if (/canonical id/i.test(cardMeta.visibleText)) fail("3c.no-canonical-id", `card visible text contains "canonical id" (advanced disclosure excluded)`);
    else ok(`3c. directory card has no default-visible "canonical id" copy`);
    if (!/advanced details$/i.test(cardMeta.advSummary.trim())) fail("3d.advanced-label", `expected "advanced details" summary, got "${cardMeta.advSummary}"`);
    else ok(`3d. lookup card advanced disclosure says "advanced details"`);
  }

  // ---- B: lookup another handle that has NO bio set. Use the
  //      second account (we never set a bio on it). Verify the card
  //      omits the bio element entirely.
  await b.page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // Sign up a third fresh user with no bio.
  const cHandle = `cc${Date.now().toString().slice(-6)}`;
  const c = await signUpFresh(cHandle);
  await c.page.close();
  await c.ctx.close();

  await b.page.evaluate((q) => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) {
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, `@${cHandle}`);
  const noBioCardReady = await waitFor(b.page, () => {
    const root = document.getElementById("lookup-result");
    const handle = root?.querySelector(".lookup-card__handle")?.textContent ?? "";
    return handle.includes("@") && !handle.includes("@" + new URLSearchParams({ q: "" }).toString());
  }, 6000);
  if (!noBioCardReady) {
    fail("4.no-bio-card", `directory card never appeared for @${cHandle}`);
  } else {
    const meta = await b.page.evaluate(() => {
      const card = document.querySelector("#lookup-result .lookup-card");
      return {
        hasBioEl: card?.querySelector(".lookup-card__bio") !== null,
        bioText: card?.querySelector(".lookup-card__bio")?.textContent ?? null,
        visibleText: (() => {
          if (!card) return "";
          const clone = card.cloneNode(true);
          clone.querySelector(".lookup-card__advanced")?.remove();
          return clone.textContent ?? "";
        })()
      };
    });
    if (meta.hasBioEl) fail("4a.no-bio-element", `bio element rendered for user with no bio (text: "${meta.bioText}")`);
    else ok(`4a. directory card for unset bio omits .lookup-card__bio element`);
    if (/no bio yet/i.test(meta.visibleText)) fail("4b.no-bio-placeholder", `placeholder "no bio yet" leaked into directory card`);
    else ok(`4b. no "no bio yet" placeholder when bio is empty`);
  }

  // ---- CSP violations during the run.
  for (const { page } of [a, b]) {
    const v = await page.evaluate(() => (window.__smokeCspViolations || []).slice()).catch(() => []);
    if (Array.isArray(v) && v.length > 0) fail("5.csp", `CSP violations: ${JSON.stringify(v)}`);
  }
  ok(`5. no CSP violations across signup + account + directory flows`);

  await a.page.close(); await a.ctx.close();
  await b.page.close(); await b.ctx.close();
  await browser.close();

  if (failures.length > 0) {
    console.error(`COPY-AUDIT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("COPY-AUDIT SMOKE PASSED");
})().catch((err) => { console.error("COPY-AUDIT SMOKE ERRORED:", err); process.exit(1); });

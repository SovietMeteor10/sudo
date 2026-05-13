#!/usr/bin/env node
// incognito-linking-copy smoke (Phase 11.5).
//
// Asserts:
//   - the collect-account dialog surfaces the private-window note.
//   - the temporary-passcode pairing card also surfaces a private-
//     window note.
//   - the copy avoids technical terms (IndexedDB, localStorage,
//     "browser storage", etc.).
//   - the landing page does NOT show the note (over-emphasis on
//     the auth screen).

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

const FORBIDDEN_TERMS = ["indexeddb", "localstorage", "local storage", "browser storage", "idb", "private-window-detected", "navigator.storage"];

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
    page.on("pageerror", (err) => console.log("ERR>", err.message));
    await page.setViewport({ width: 980, height: 820 });
    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    // ===== Part 1: landing page does NOT show the note. The note
    // is a contextual hint for linking surfaces, not the landing. =====
    const landingHas = await page.evaluate(() => {
      const note = document.getElementById("link-device-private-note");
      // The element is inside the link-device dialog which is closed
      // on landing. We check that it's not visible in the layout.
      if (!(note instanceof HTMLElement)) return false;
      const rect = note.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (landingHas) {
      fail("1.landing-leak", "private-window note is visible on landing");
    } else {
      ok(`1. landing page does not show the private-window note`);
    }

    // ===== Part 2: open the collect-account flow. The "link" button
    // lives inside the signin dialog (sign-in screen), so we open
    // the dialog directly via the DOM hook rather than navigating
    // through signin. =====
    await page.evaluate(() => {
      const d = document.getElementById("link-device-dialog");
      if (d instanceof HTMLDialogElement && !d.open) d.showModal();
    });
    if (!await waitFor(page, () => {
      const d = document.getElementById("link-device-dialog");
      return d instanceof HTMLDialogElement && d.open;
    }, 4000)) {
      fail("2.open-link", "link-device dialog did not open");
      throw new Error();
    }
    const collectNote = await page.evaluate(() => {
      const note = document.getElementById("link-device-private-note");
      if (!(note instanceof HTMLElement)) return null;
      const cs = getComputedStyle(note);
      return {
        text: (note.textContent || "").trim(),
        visible: cs.display !== "none" && cs.visibility !== "hidden"
      };
    });
    if (collectNote === null) {
      fail("2.collect-missing", "link-device-private-note element absent from DOM");
    } else if (!collectNote.visible) {
      fail("2.collect-hidden", "link-device-private-note not visible");
    } else if (!collectNote.text.toLowerCase().includes("private") && !collectNote.text.toLowerCase().includes("incognito")) {
      fail("2.collect-copy", `note copy does not mention private/incognito: '${collectNote.text}'`);
    } else {
      ok(`2. collect-account dialog shows private-window note: '${collectNote.text.slice(0, 60)}...'`);
    }
    // Check no forbidden terms.
    const lower = (collectNote?.text ?? "").toLowerCase();
    const leaks = FORBIDDEN_TERMS.filter((t) => lower.includes(t));
    if (leaks.length > 0) {
      fail("2b.tech-terms", `collect-account note contains forbidden technical terms: ${leaks.join(", ")}`);
    } else {
      ok(`2b. collect-account note uses no technical terms (no ${FORBIDDEN_TERMS.slice(0, 3).join("/")}/...)`);
    }

    // Close the dialog.
    await page.evaluate(() => document.getElementById("link-device-dialog")?.close());
    await new Promise((r) => setTimeout(r, 200));

    // ===== Part 3: sign up, open Settings → Linked devices →
    // generate pairing code, verify the pairing-card note is
    // present. =====
    const handle = `inc${Date.now().toString().slice(-7)}`;
    if (!await signUp(page, handle)) { fail("3.signup", "sign up failed"); throw new Error(); }
    // Close the onboarding dialog (auto-suppressed by webdriver, but
    // be defensive).
    await page.evaluate(() => {
      const d = document.getElementById("onboarding-dialog");
      if (d instanceof HTMLDialogElement && d.open) d.close();
    });
    // The pairing card lives inside the linked-devices dialog. We
    // check the DOM directly rather than driving through the
    // unlock-passphrase prompt.
    const pairingNote = await page.evaluate(() => {
      const note = document.getElementById("pairing-card-private-note");
      if (!(note instanceof HTMLElement)) return null;
      return { text: (note.textContent || "").trim() };
    });
    if (pairingNote === null) {
      fail("3.pairing-missing", "pairing-card-private-note element absent");
    } else if (!pairingNote.text.toLowerCase().includes("private") && !pairingNote.text.toLowerCase().includes("incognito")) {
      fail("3.pairing-copy", `pairing-card note doesn't mention private/incognito: '${pairingNote.text}'`);
    } else {
      ok(`3. temporary-passcode card carries a private-window note`);
    }
    const pairingLower = (pairingNote?.text ?? "").toLowerCase();
    const pairingLeaks = FORBIDDEN_TERMS.filter((t) => pairingLower.includes(t));
    if (pairingLeaks.length > 0) {
      fail("3b.pairing-tech", `pairing-card note contains forbidden terms: ${pairingLeaks.join(", ")}`);
    } else {
      ok(`3b. pairing-card note uses no technical terms`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`INCOGNITO-LINKING-COPY SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("INCOGNITO-LINKING-COPY SMOKE PASSED");
})().catch((err) => {
  console.error("INCOGNITO-LINKING-COPY SMOKE ERRORED:", err);
  process.exit(1);
});

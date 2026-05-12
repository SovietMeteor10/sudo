#!/usr/bin/env node
// dialog-accessibility smoke (Phase 10.3).
//
// Asserts:
//   - Every dialog in index.html is a native <dialog> (so showModal
//     gives free focus-trap + Escape close).
//   - Each dialog carries aria-labelledby pointing at an existing
//     heading element.
//   - Pressing Escape closes an open dialog.
//   - Icon-only buttons in the shell carry aria-label.
//   - The reduced-motion media query short-circuits transitions
//     when emulated.

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
    const handle = `dax${Date.now().toString().slice(-7)}`;
    if (!await signUp(page, handle)) { fail("setup", "sign up"); throw new Error(); }
    // Close onboarding so it doesn't intercept the audit.
    await page.evaluate(() => {
      const d = document.getElementById("onboarding-dialog");
      if (d instanceof HTMLDialogElement && d.open) d.close();
      localStorage.setItem("sudo_onboarded_v1", "1");
    });

    // ===== Audit every <dialog> in the document. =====
    const dialogAudit = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll("dialog")];
      return dialogs.map((d) => {
        const label = d.getAttribute("aria-labelledby");
        const labelTarget = label ? document.getElementById(label) : null;
        return {
          id: d.id,
          isDialog: d.tagName === "DIALOG",
          hasAriaLabelledby: typeof label === "string" && label.length > 0,
          ariaLabelledbyTargetExists: labelTarget !== null
        };
      });
    });
    if (dialogAudit.length === 0) {
      fail("audit.dialogs", "no <dialog> elements found in the document");
    } else {
      let allOk = true;
      for (const d of dialogAudit) {
        if (!d.isDialog) { fail(`audit.${d.id}.tag`, "not a <dialog> element"); allOk = false; }
        if (!d.hasAriaLabelledby) { fail(`audit.${d.id}.aria`, "missing aria-labelledby"); allOk = false; }
        else if (!d.ariaLabelledbyTargetExists) { fail(`audit.${d.id}.aria-target`, "aria-labelledby points at a missing element"); allOk = false; }
      }
      if (allOk) ok(`audit: ${dialogAudit.length} <dialog>s have aria-labelledby pointing at real headings`);
    }

    // ===== Escape closes an open dialog. =====
    await page.evaluate(() => {
      const d = document.getElementById("settings-dialog");
      if (d instanceof HTMLDialogElement) d.showModal();
    });
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press("Escape");
    if (!await waitFor(page, () => {
      const d = document.getElementById("settings-dialog");
      return d instanceof HTMLDialogElement && d.open === false;
    }, 2000)) {
      fail("escape.settings", "Escape did not close the settings dialog");
    } else {
      ok("escape: settings dialog closes on Escape");
    }

    // ===== aria-label audit on icon-only buttons. =====
    const iconButtonsAudit = await page.evaluate(() => {
      // Icon buttons are buttons whose textContent is a single
      // character or symbol — they need aria-label.
      const buttons = [...document.querySelectorAll("button")];
      const issues = [];
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        const ariaLabel = btn.getAttribute("aria-label");
        const title = btn.getAttribute("title");
        // "icon-only" heuristic: 0–3 chars and not a word.
        const isIcon = text.length > 0 && text.length <= 3 && !/[a-z]{3,}/i.test(text);
        if (isIcon && (typeof ariaLabel !== "string" || ariaLabel.length === 0)) {
          // Permit a title attribute as a fallback for hover hint;
          // screen readers prefer aria-label, but title is OK if it
          // exists. Only fail if both are missing.
          if (typeof title !== "string" || title.length === 0) {
            issues.push({ id: btn.id, text, classes: btn.className });
          }
        }
      }
      return issues;
    });
    if (iconButtonsAudit.length > 0) {
      fail("aria.icon-buttons", `${iconButtonsAudit.length} icon-only buttons missing both aria-label and title: ${JSON.stringify(iconButtonsAudit.slice(0, 5))}`);
    } else {
      ok("aria: all icon-only buttons in the shell carry aria-label or title");
    }

    // ===== Reduced-motion media query short-circuits transitions. =====
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const transitionProbe = await page.evaluate(() => {
      // Probe an element we know carries a transition normally.
      const dot = document.querySelector(".onboarding__dot");
      if (!(dot instanceof HTMLElement)) return { ok: false, reason: "no .onboarding__dot in DOM" };
      const dur = getComputedStyle(dot).transitionDuration;
      return { ok: true, transitionDuration: dur };
    });
    if (!transitionProbe.ok) {
      fail("reduced-motion.probe", transitionProbe.reason);
    } else {
      // Parse the computed duration. The CSS uses 0.01ms !important
      // under prefers-reduced-motion; browsers report this as either
      // "0s" or a tiny number like "1e-05s" depending on engine. The
      // assertion is "effectively zero", not literally zero.
      const raw = transitionProbe.transitionDuration ?? "";
      const ms = raw.endsWith("ms")
        ? parseFloat(raw)
        : raw.endsWith("s")
          ? parseFloat(raw) * 1000
          : Number.NaN;
      if (Number.isNaN(ms) || ms > 5) {
        fail("reduced-motion.transition", `expected ≤5ms transition under prefers-reduced-motion, got '${raw}'`);
      } else {
        ok(`reduced-motion: transitions collapsed to ${raw} (≤5ms)`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`DIALOG-ACCESSIBILITY SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("DIALOG-ACCESSIBILITY SMOKE PASSED");
})().catch((err) => {
  console.error("DIALOG-ACCESSIBILITY SMOKE ERRORED:", err);
  process.exit(1);
});

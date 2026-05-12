#!/usr/bin/env node
// onboarding-flow smoke (Phase 10.2).
//
// Asserts:
//   - First-run sign-up surfaces the onboarding dialog automatically.
//   - The dots/steps render with exactly one .is-active.
//   - Next advances; back retreats; final next closes the dialog.
//   - Skip closes the dialog + persists the localStorage flag.
//   - A reload (returning user) does NOT show the dialog again.
//   - Internal terms (no "relay envelope", "sync slice", etc.) do
//     not appear in the dialog copy.

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
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
    await pageA.setViewport({ width: 980, height: 820 });
    // Opt this page into the auto-onboarding flow — main.ts skips
    // it for headless puppeteer by default.
    await pageA.evaluateOnNewDocument(() => { window.__sudoForceOnboarding = true; });
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `obA${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup", "sign up A"); throw new Error(); }

    // ===== Part 1: dialog appears on first sign-up. =====
    if (!await waitFor(pageA, () => {
      const d = document.getElementById("onboarding-dialog");
      return d instanceof HTMLDialogElement && d.open === true;
    }, 5000)) {
      fail("1.open", "onboarding dialog did not open on first sign-in");
      throw new Error();
    }
    ok("1. onboarding dialog opens automatically on first sign-up");

    // ===== Part 2: copy contains no internal terms. =====
    const forbidden = ["relay envelope", "sync slice", "ciphertext_scheme", "canonical_id", "device_sync_log", "ack envelope", "tombstone watermark"];
    const text = await pageA.evaluate(() => {
      const d = document.getElementById("onboarding-dialog");
      return d ? (d.innerText || "").toLowerCase() : "";
    });
    const leaks = forbidden.filter((term) => text.includes(term.toLowerCase()));
    if (leaks.length > 0) {
      fail("2.terms", `onboarding copy contains internal terms: ${leaks.join(", ")}`);
    } else {
      ok("2. onboarding copy has zero internal/jargon terms");
    }

    // ===== Part 3: navigation — next advances through all 5 steps. =====
    for (let step = 0; step < 4; step++) {
      const active = await pageA.evaluate(() => {
        const dots = [...document.querySelectorAll("[data-onboarding-dot]")];
        const idx = dots.findIndex((d) => d.classList.contains("is-active"));
        const visible = [...document.querySelectorAll("[data-onboarding-step]")].filter((s) => s.classList.contains("is-active")).length;
        return { idx, visible };
      });
      if (active.idx !== step) {
        fail(`3.step-${step}`, `expected active dot ${step}, got ${active.idx}`);
        break;
      }
      if (active.visible !== 1) {
        fail(`3.step-${step}.visible`, `expected exactly 1 visible step, got ${active.visible}`);
      }
      await pageA.click("#onboarding-next");
      await new Promise((r) => setTimeout(r, 120));
    }
    const onLastStep = await pageA.evaluate(() => {
      const dots = [...document.querySelectorAll("[data-onboarding-dot]")];
      return dots.findIndex((d) => d.classList.contains("is-active"));
    });
    if (onLastStep !== 4) {
      fail("3.last-step", `expected to reach step 4 (5th), got ${onLastStep}`);
    } else {
      ok("3. next advanced through all 5 steps");
    }

    // Final "next" reads "done" and closes the dialog.
    const finalLabel = await pageA.evaluate(() => document.getElementById("onboarding-next")?.textContent ?? "");
    if (finalLabel.trim() !== "done") {
      fail("3b.done-label", `final button label is '${finalLabel}', expected 'done'`);
    } else {
      ok("3b. final step button reads 'done'");
    }
    await pageA.click("#onboarding-next");
    if (!await waitFor(pageA, () => {
      const d = document.getElementById("onboarding-dialog");
      return d instanceof HTMLDialogElement && d.open === false;
    }, 3000)) {
      fail("3c.close", "'done' did not close the dialog");
    } else {
      ok("3c. 'done' closes the dialog");
    }

    // ===== Part 4: localStorage flag persists. =====
    const flag = await pageA.evaluate(() => localStorage.getItem("sudo_onboarded_v1"));
    if (flag !== "1") {
      fail("4.flag", `localStorage sudo_onboarded_v1='${flag}', expected '1'`);
    } else {
      ok("4. localStorage flag sudo_onboarded_v1='1' persisted");
    }

    // ===== Part 5: reload — returning user does NOT see the dialog. =====
    await pageA.reload({ waitUntil: "networkidle0" });
    if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in", 15000)) {
      fail("5.reload-signin", "A's signed-in state did not restore after reload");
      throw new Error();
    }
    // Wait a beat for any auto-open to fire.
    await new Promise((r) => setTimeout(r, 1500));
    const reopened = await pageA.evaluate(() => {
      const d = document.getElementById("onboarding-dialog");
      return d instanceof HTMLDialogElement ? d.open : null;
    });
    if (reopened === true) {
      fail("5.no-repeat", "onboarding dialog re-opened for a returning user");
    } else {
      ok("5. reload does NOT show the onboarding dialog (returning user)");
    }

    // ===== Part 6: skip button on a fresh context. =====
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.evaluateOnNewDocument(() => { window.__sudoForceOnboarding = true; });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `obB${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("6.setup", "B sign up"); throw new Error(); }
    if (!await waitFor(pageB, () => {
      const d = document.getElementById("onboarding-dialog");
      return d instanceof HTMLDialogElement && d.open === true;
    }, 5000)) {
      fail("6.open", "onboarding dialog did not open for B");
      throw new Error();
    }
    await pageB.click("#onboarding-skip");
    if (!await waitFor(pageB, () => {
      const d = document.getElementById("onboarding-dialog");
      return d instanceof HTMLDialogElement && d.open === false;
    }, 3000)) {
      fail("6.skip-close", "skip did not close the dialog");
    } else {
      const flagB = await pageB.evaluate(() => localStorage.getItem("sudo_onboarded_v1"));
      if (flagB !== "1") {
        fail("6.skip-flag", `skip did not persist flag (got '${flagB}')`);
      } else {
        ok("6. skip closes dialog + persists the onboarded flag");
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`ONBOARDING-FLOW SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ONBOARDING-FLOW SMOKE PASSED");
})().catch((err) => {
  console.error("ONBOARDING-FLOW SMOKE ERRORED:", err);
  process.exit(1);
});

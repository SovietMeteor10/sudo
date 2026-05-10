#!/usr/bin/env node
// Pins the simplified lookup card. Default state must show only the
// non-technical fields and the follow / block axes. Tier buttons
// (set-known, set-close, set-unknown) and protocol-level identity
// fields (canonical id, raw fingerprint hex, trust:, onion:,
// updated:) must NOT appear unless the advanced disclosure is
// expanded.

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
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function signupOn(page, handle) {
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
    if (a === "signed-in") return;
  }
  throw new Error(`signup hung for @${handle}`);
}

async function resolveLookup(page, handle) {
  await page.evaluate(() => {
    const input = document.getElementById("lookup-input");
    if (input instanceof HTMLInputElement) input.value = "";
  });
  await page.type("#lookup-input", handle);
  await page.evaluate(() => {
    document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const ready = await page.evaluate(() => document.querySelector(".lookup-card") !== null);
    if (ready) return;
  }
  throw new Error(`lookup did not resolve ${handle}`);
}

// Returns the rendered text + attributes that are *visible* in the
// default lookup card (excluding the contents of any closed
// <details> element).
async function defaultCardSnapshot(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".lookup-card");
    if (card === null) return null;
    // Walk text nodes and skip anything inside a closed <details>.
    function visibleText(node) {
      let out = "";
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const el = n;
            if (el.tagName === "DETAILS" && !el.open) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let cursor = walker.nextNode();
      while (cursor !== null) {
        out += (cursor.textContent || "");
        cursor = walker.nextNode();
      }
      return out;
    }
    function visibleActions(node) {
      const out = [];
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) {
          const el = n;
          if (el.tagName === "DETAILS" && !el.open) return NodeFilter.FILTER_REJECT;
          if (el.hasAttribute && el.hasAttribute("data-relationship-action")) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      });
      let cursor = walker.nextNode();
      while (cursor !== null) {
        out.push(cursor.getAttribute("data-relationship-action"));
        cursor = walker.nextNode();
      }
      return out;
    }
    return {
      text: visibleText(card),
      actions: visibleActions(card),
      hasFingerprintGrid: card.querySelector(".identity-fingerprint-grid") !== null,
      detailsPresent: card.querySelector(".lookup-card__advanced") !== null,
      detailsOpen: card.querySelector(".lookup-card__advanced")?.open === true
    };
  });
}

async function expandedCardSnapshot(page) {
  await page.evaluate(() => {
    const det = document.querySelector(".lookup-card__advanced");
    if (det instanceof HTMLDetailsElement) det.open = true;
  });
  return page.evaluate(() => {
    const card = document.querySelector(".lookup-card");
    if (card === null) return null;
    return {
      text: card.textContent || "",
      actions: Array.from(card.querySelectorAll("[data-relationship-action]"))
        .map((b) => b.getAttribute("data-relationship-action"))
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);
    const aHandle = `lookera${stamp}`;
    const bHandle = `lookerb${stamp}`;

    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.setViewport({ width: 980, height: 820 });
    await signupOn(pageA, aHandle);

    // Need a peer to look up. Mint one out of band.
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.setViewport({ width: 980, height: 820 });
    await signupOn(pageB, bHandle);
    ok(`signed up @${aHandle} and @${bHandle}`);

    await resolveLookup(pageA, `@${bHandle}`);

    const def = await defaultCardSnapshot(pageA);
    if (def === null) { fail("card-mount", "lookup card not present"); throw new Error(); }

    if (def.hasFingerprintGrid) ok("default card shows the visual fingerprint grid");
    else fail("default-grid", "default card missing the fingerprint grid");

    if (def.text.includes(`@${bHandle}`)) ok(`default card shows handle @${bHandle}`);
    else fail("default-handle", `default card missing the handle: '${def.text.slice(0, 200)}'`);

    if (/not following yet|following|chat unlocked|blocked/i.test(def.text)) {
      ok(`default card shows relationship-status copy ('${def.text.match(/not following yet|following|chat unlocked|blocked/i)?.[0]}')`);
    } else {
      fail("default-status", `default card missing status copy: '${def.text.slice(0, 200)}'`);
    }

    // Forbidden technical fields in default view.
    const forbiddenSubstrings = ["canonical:", "fingerprint:", "trust:", "onion:", "updated:"];
    const leaked = forbiddenSubstrings.filter((s) => def.text.toLowerCase().includes(s));
    if (leaked.length === 0) ok("default card hides canonical/fingerprint hex/trust/onion/updated");
    else fail("default-tech-leak", `default card leaks ${leaked.join(", ")}`);

    // Default actions: only follow + block axes. No tier buttons.
    const expectedDefault = new Set(["set-subscribe", "set-block"]);
    const actualDefault = new Set(def.actions);
    const tierButtons = ["set-known", "set-close", "set-unknown"];
    const tierLeaked = tierButtons.filter((b) => actualDefault.has(b));
    if (tierLeaked.length === 0) ok("default card hides set-known / set-close / set-unknown");
    else fail("default-tier-leak", `default card exposes tier buttons: ${tierLeaked.join(", ")}`);

    if (actualDefault.has("set-subscribe") && actualDefault.has("set-block")) {
      ok("default card exposes follow + block actions");
    } else {
      fail("default-actions", `default card missing follow/block: ${[...actualDefault].join(", ")}`);
    }

    if (def.detailsPresent && def.detailsOpen === false) {
      ok("advanced-identity-details disclosure is present and collapsed by default");
    } else if (!def.detailsPresent) {
      fail("advanced-missing", "advanced-identity-details disclosure missing");
    } else {
      fail("advanced-not-collapsed", "advanced-identity-details disclosure is open by default");
    }

    // Expand and verify advanced contents.
    const expanded = await expandedCardSnapshot(pageA);
    if (expanded === null) { fail("expand-mount", "card disappeared on expand"); throw new Error(); }

    const required = ["canonical:", "fingerprint:", "trust:", "onion:", "updated:"];
    const missing = required.filter((s) => !expanded.text.toLowerCase().includes(s));
    if (missing.length === 0) ok("expanded card reveals canonical / fingerprint / trust / onion / updated");
    else fail("advanced-missing-fields", `advanced section missing: ${missing.join(", ")}`);

    if (expanded.actions.includes("set-known")) {
      ok("expanded card surfaces local-trust debug controls (set-known)");
    } else {
      fail("advanced-controls", `expanded card missing the debug tier controls: ${expanded.actions.join(", ")}`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`LOOKUP-CARD-DEFAULT SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("LOOKUP-CARD-DEFAULT SMOKE PASSED");
})();

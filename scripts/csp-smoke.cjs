#!/usr/bin/env node
// CSP smoke. Loads the landing page in a real browser and asserts:
//   - the Content-Security-Policy response header is present
//   - the page's auth-state advances past "restoring", which can only
//     happen if /client/main.js loaded AND the @chenglou/pretext
//     importmap entry resolved (i.e. CSP did not block the inline
//     importmap script)
//   - the browser reports zero securitypolicyviolation events
//   - no console errors mention CSP

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

(async () => {
  // Header assertion via plain HTTP first.
  const resp = await fetch(BASE + "/", { redirect: "manual" });
  const csp = resp.headers.get("content-security-policy");
  if (!csp) {
    fail("csp-header", "Content-Security-Policy header missing");
  } else if (!csp.includes("'sha256-")) {
    fail("csp-header", `header present but no sha256 importmap hash: ${csp}`);
  } else {
    ok(`csp-header includes sha256 hash`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 980, height: 820 });

    const cspViolations = [];
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.evaluateOnNewDocument(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          sample: e.sample
        });
      });
    });

    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    // Page can only reach "menu" or anything past "restoring" if
    // /client/main.js executed AND it imported @chenglou/pretext via
    // the importmap. If the inline importmap script was blocked by
    // CSP, the bare specifier import fails and the page hangs.
    let authState = "";
    for (let i = 0; i < 50; i++) {
      authState = await page.evaluate(() => document.body.dataset.authState || "");
      if (authState && authState !== "restoring") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (authState && authState !== "restoring") {
      ok(`auth-state advanced to '${authState}' (importmap resolved under CSP)`);
    } else {
      fail("auth-state", `stuck at '${authState}' — likely CSP blocked /client/main.js or the importmap`);
    }

    const violations = await page.evaluate(() => window.__cspViolations || []);
    if (violations.length === 0) {
      ok("zero securitypolicyviolation events");
    } else {
      fail("csp-violations", `${violations.length} CSP violation(s): ${JSON.stringify(violations)}`);
    }

    const cspConsoleErrors = consoleErrors.filter((m) => /Content Security Policy|CSP/i.test(m));
    if (cspConsoleErrors.length === 0) {
      ok("zero CSP-related console errors");
    } else {
      fail("csp-console", `${cspConsoleErrors.length} CSP console error(s): ${cspConsoleErrors.join(" | ")}`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error("CSP SMOKE FAILED");
    process.exit(1);
  }
  console.log("CSP SMOKE PASSED");
})();

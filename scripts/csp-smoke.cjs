#!/usr/bin/env node
// CSP smoke. Loads the landing page in a real browser and asserts:
//   - the Content-Security-Policy response header is present
//   - the policy contains the Phase 2 directive set:
//       default-src 'self'
//       script-src  'self' <importmap-hash>
//       style-src   'self' 'unsafe-inline' (or hashes)
//       connect-src 'self'
//       img-src     'self' data:
//       font-src    'self'
//       object-src  'none'
//       base-uri    'none'
//       frame-ancestors 'none'
//       worker-src  'self'
//       manifest-src 'self'
//   - the page's auth-state advances past "restoring", which can only
//     happen if /client/main.js loaded AND the @chenglou/pretext
//     importmap entry resolved (i.e. CSP did not block the inline
//     importmap script)
//   - the browser reports zero securitypolicyviolation events
//     across each dialog the smoke programmatically opens (signin /
//     signup / restore / forward picker / settings / devices /
//     conversation-settings / remove-connection / link-device).
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
  // Phase 2: explicit directive checks.
  const required = [
    /default-src\s+'self'/,
    /script-src\s+'self'\s+'sha256-/,
    /style-src\s+'self'\s+'unsafe-inline'/,
    /connect-src\s+'self'/,
    /img-src\s+'self'\s+data:\s+blob:/,
    /media-src\s+'self'\s+blob:/,
    /font-src\s+'self'/,
    /worker-src\s+'self'/,
    /manifest-src\s+'self'/,
    /object-src\s+'none'/,
    /frame-ancestors\s+'none'/,
    /base-uri\s+'none'/,
    /form-action\s+'self'/
  ];
  for (const re of required) {
    if (!re.test(csp || "")) fail("csp-directive", `missing: ${re}`);
    else ok(`csp-directive present: ${re}`);
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

    // Initial-load violations (importmap, main.js, styles.css, etc.).
    let violations = await page.evaluate(() => window.__cspViolations || []);
    if (violations.length === 0) {
      ok("zero securitypolicyviolation events on initial load");
    } else {
      fail("csp-violations", `${violations.length} CSP violation(s) on load: ${JSON.stringify(violations)}`);
    }

    // Open each dialog programmatically and assert no new violations
    // are emitted. Dialogs that aren't reachable in the signed-out
    // landing (devices, account settings, conversation settings,
    // forward picker) are still presentable via showModal() in JS as
    // long as their <dialog> element exists in the DOM. Any CSS or
    // inline-style violation that comes with opening the modal would
    // fire on .showModal().
    const dialogIds = [
      "signin-dialog",
      "signup-dialog",
      "restore-dialog",
      "forward-picker-dialog",
      "conversation-settings-dialog",
      "remove-connection-dialog",
      "devices-dialog",
      "link-device-dialog",
      "settings-dialog",
      "account-dialog"
    ];
    for (const id of dialogIds) {
      const result = await page.evaluate(async (id) => {
        const dlg = document.getElementById(id);
        if (!(dlg instanceof HTMLDialogElement)) return { found: false };
        try {
          if (!dlg.open) dlg.showModal();
          await new Promise((r) => setTimeout(r, 30));
          if (dlg.open) dlg.close();
        } catch (e) { return { found: true, error: String(e && e.message) }; }
        return { found: true };
      }, id);
      if (!result.found) fail(`dialog-${id}-missing`, "dialog element not in DOM");
      else if (result.error) fail(`dialog-${id}-error`, result.error);
      else ok(`opened ${id} without DOM error`);
    }

    // Also exercise the chat-popup section (not a <dialog>) by un-hiding it.
    await page.evaluate(() => {
      const popup = document.getElementById("chat-popup");
      if (popup) { popup.hidden = false; popup.classList.add("is-minimized"); }
      const pairing = document.getElementById("pairing-card");
      if (pairing) { pairing.hidden = false; }
      const qr = document.getElementById("qr-scanner-panel");
      if (qr) { qr.hidden = false; }
      const notif = document.getElementById("notifications-panel");
      if (notif) notif.style.display = ""; // already visible, just exercise the style mutation
    });
    await new Promise((r) => setTimeout(r, 50));

    violations = await page.evaluate(() => window.__cspViolations || []);
    if (violations.length === 0) {
      ok("zero securitypolicyviolation events across all dialogs + dynamic surfaces");
    } else {
      fail("csp-violations-dialogs", `${violations.length} CSP violation(s): ${JSON.stringify(violations)}`);
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

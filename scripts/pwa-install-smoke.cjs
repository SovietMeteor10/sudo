#!/usr/bin/env node
// PWA install smoke. Asserts the static install scaffolding is in place
// so a browser meeting Chrome's install criteria can offer the prompt.
//
// HTTP-only checks:
//   - GET /manifest.webmanifest -> 200 + application/manifest+json + no-store
//   - the manifest JSON has the required fields: name, short_name,
//     start_url, scope, display ∈ {standalone, fullscreen, minimal-ui},
//     and an icons[] entry with sizes >= 192 AND >= 512, plus a
//     maskable variant
//   - GET /sw.js -> 200 + application/javascript + no-store
//   - GET /icons/icon-192.png and /icons/icon-512.png -> 200 image/png
//   - index.html contains <link rel="manifest"> and the theme-color meta
//   - CSP response header includes worker-src 'self' and manifest-src 'self'
//   - sw.js contains a versioned cache name + activate-time eviction
//     of old caches (so a redeploy reliably replaces the shell)
//
// Browser-driven (puppeteer-core) checks:
//   - navigator.serviceWorker.register('/sw.js') resolves to a
//     ServiceWorkerRegistration whose .active eventually transitions to
//     state === 'activated' (i.e. install + activate succeeded)
//   - navigator.serviceWorker.controller becomes non-null after a
//     reload (proves the SW actually controls the page)
//   - the page reports zero securitypolicyviolation events relating to
//     'worker-src' or 'manifest-src'

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

function noStore(value) {
  if (!value) return false;
  const v = value.toLowerCase();
  return v.includes("no-store") || v.includes("no-cache");
}

async function checkHttp() {
  // Manifest
  {
    const r = await fetch(BASE + "/manifest.webmanifest");
    if (r.status !== 200) {
      fail("manifest-status", `expected 200, got ${r.status}`);
      return null;
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/manifest+json")) {
      fail("manifest-content-type", `expected application/manifest+json, got '${ct}'`);
    } else {
      ok("manifest content-type is application/manifest+json");
    }
    if (!noStore(r.headers.get("cache-control"))) {
      fail("manifest-cache", `expected no-store, got '${r.headers.get("cache-control")}'`);
    } else {
      ok("manifest is no-store");
    }
    let manifest;
    try { manifest = await r.json(); }
    catch (e) { fail("manifest-json", `body not JSON: ${e.message}`); return null; }
    const required = ["name", "short_name", "start_url", "scope", "display", "icons"];
    for (const k of required) {
      if (manifest[k] === undefined) fail("manifest-shape", `missing required field '${k}'`);
    }
    const displays = ["standalone", "fullscreen", "minimal-ui"];
    if (!displays.includes(manifest.display)) {
      fail("manifest-display", `display='${manifest.display}', need one of ${displays.join(", ")}`);
    } else {
      ok(`manifest display='${manifest.display}'`);
    }
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const sizes = icons.map((i) => String(i.sizes || "")).join(" ");
    if (!/192x192/.test(sizes)) fail("manifest-icon-192", "no 192x192 icon listed");
    if (!/512x512/.test(sizes)) fail("manifest-icon-512", "no 512x512 icon listed");
    const hasMaskable = icons.some((i) => /maskable/.test(String(i.purpose || "")));
    if (!hasMaskable) fail("manifest-maskable", "no maskable icon entry");
    else ok("manifest has 192, 512, and maskable icons");
  }

  // Service worker
  {
    const r = await fetch(BASE + "/sw.js");
    if (r.status !== 200) {
      fail("sw-status", `expected 200, got ${r.status}`);
    } else {
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("javascript")) fail("sw-content-type", `expected javascript, got '${ct}'`);
      else ok("sw.js content-type is javascript");
      if (!noStore(r.headers.get("cache-control"))) {
        fail("sw-cache", `expected no-store, got '${r.headers.get("cache-control")}'`);
      } else {
        ok("sw.js is no-store");
      }
      const body = await r.text();
      if (!/CACHE_VERSION\s*=\s*['"]sudo-shell-/.test(body)) {
        fail("sw-version", "sw.js missing versioned CACHE_VERSION constant");
      } else {
        ok("sw.js has versioned cache name");
      }
      if (!/caches\.delete/.test(body)) {
        fail("sw-evict", "sw.js missing old-cache eviction logic");
      } else {
        ok("sw.js evicts old caches on activate");
      }
      if (!/addEventListener\(['"]push['"]/.test(body)) {
        fail("sw-push-handler", "sw.js has no push handler");
      } else {
        ok("sw.js has push handler");
      }
      if (!/addEventListener\(['"]notificationclick['"]/.test(body)) {
        fail("sw-click-handler", "sw.js has no notificationclick handler");
      } else {
        ok("sw.js has notificationclick handler");
      }
    }
  }

  // Icons
  for (const path of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-192.png", "/icons/icon-maskable-512.png"]) {
    const r = await fetch(BASE + path);
    if (r.status !== 200) { fail("icon-status", `${path}: ${r.status}`); continue; }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("image/png")) fail("icon-content-type", `${path}: '${ct}'`);
    else ok(`${path} 200 image/png`);
  }

  // Index.html manifest link + theme-color
  {
    const r = await fetch(BASE + "/");
    const html = await r.text();
    if (!/<link[^>]+rel=["']manifest["']/i.test(html)) {
      fail("index-manifest-link", "missing <link rel=\"manifest\">");
    } else {
      ok("index has <link rel=\"manifest\">");
    }
    if (!/<meta[^>]+name=["']theme-color["']/i.test(html)) {
      fail("index-theme-color", "missing <meta name=\"theme-color\">");
    } else {
      ok("index has theme-color meta");
    }
    const csp = r.headers.get("content-security-policy") || "";
    if (!/worker-src\s+'self'/.test(csp)) fail("csp-worker-src", `worker-src 'self' missing from CSP: ${csp}`);
    else ok("CSP allows worker-src 'self'");
    if (!/manifest-src\s+'self'/.test(csp)) fail("csp-manifest-src", `manifest-src 'self' missing from CSP: ${csp}`);
    else ok("CSP allows manifest-src 'self'");
  }

  return true;
}

async function checkBrowser() {
  let puppeteer;
  try {
    puppeteer = require(PUPPETEER_CORE_PATH);
  } catch (error) {
    console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
    console.error(error.message);
    process.exit(2);
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
    page.on("console", (msg) => { /* drain */ msg.text(); });
    await page.evaluateOnNewDocument(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI
        });
      });
    });

    await page.goto(BASE + "/", { waitUntil: "networkidle0" });

    const swState = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { supported: false };
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        // Wait up to ~5s for the worker to enter 'activated'.
        const sw = reg.installing || reg.waiting || reg.active;
        if (sw) {
          for (let i = 0; i < 50 && sw.state !== "activated"; i++) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        return {
          supported: true,
          state: (reg.active && reg.active.state) || (sw && sw.state) || null,
          scope: reg.scope
        };
      } catch (e) {
        return { supported: true, error: String(e && e.message) };
      }
    });

    if (!swState.supported) {
      fail("sw-support", "navigator.serviceWorker not available in this browser");
    } else if (swState.error) {
      fail("sw-register", swState.error);
    } else if (swState.state !== "activated") {
      fail("sw-activated", `expected 'activated', got '${swState.state}'`);
    } else {
      ok(`SW activated under scope ${swState.scope}`);
    }

    // Reload to confirm the SW actually controls the page.
    await page.reload({ waitUntil: "networkidle0" });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if (!controlled) {
      fail("sw-controller", "navigator.serviceWorker.controller still null after reload");
    } else {
      ok("page is controlled by SW after reload");
    }

    const violations = await page.evaluate(() => window.__cspViolations || []);
    const swCspViolations = violations.filter((v) => /worker-src|manifest-src/.test(v.violatedDirective || ""));
    if (swCspViolations.length === 0) {
      ok("zero CSP violations for worker-src / manifest-src");
    } else {
      fail("csp-violations", JSON.stringify(swCspViolations));
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`BASE=${BASE}`);
  const httpOk = await checkHttp();
  if (httpOk) {
    await checkBrowser();
  } else {
    console.error("skipping browser check because static assertions failed");
  }
  if (failures.length > 0) {
    console.error(`PWA INSTALL SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("PWA INSTALL SMOKE PASSED");
})().catch((err) => {
  console.error("PWA INSTALL SMOKE ERRORED:", err);
  process.exit(1);
});

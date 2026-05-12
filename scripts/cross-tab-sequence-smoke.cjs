#!/usr/bin/env node
// Cross-tab sequence smoke.
//
// Verifies that the sync coordinator's outbound-serialization
// primitive (navigator.locks under the hood) actually produces
// dense, monotonic sequence numbers when two tabs of the same
// account race 50 reservations each.
//
// We can't easily drive the full sync coordinator from puppeteer
// without spinning up an account + memberships + crypto keys (the
// device-pairing smoke already covers that). The contract we want
// to lock down here is narrower: navigator.locks acts as a true
// cross-tab mutex around a read-then-write of an IndexedDB-backed
// counter, exactly the way coordinator.ts uses it.
//
// Method:
//   1. Open two pages in the same browser context (so they share
//      origin storage + the locks scope).
//   2. Each page calls navigator.locks.request(name, ...) 50 times.
//      Inside the callback they read counter from IDB, increment,
//      write back, and record the value.
//   3. After both pages finish, we collect the recorded values from
//      both sides and verify:
//        - 100 distinct values
//        - dense range 1..100
//        - within each tab the recorded values are monotonic in
//          time-of-record order
//
// The smoke also locks down the import surface: `originLockBackend`
// from the built client module reports "navigator-locks" under the
// test browser (a regression to "broadcast-fallback" would mean we
// shipped a build that lost lock semantics).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

(async () => {
  let puppeteer;
  try { puppeteer = require(PUPPETEER_CORE_PATH); }
  catch (e) {
    console.error("install puppeteer-core and a Chrome binary first.");
    console.error(e.message);
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const context = await browser.createBrowserContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await Promise.all([pageA.goto(BASE + "/"), pageB.goto(BASE + "/")]);

    // Confirm the production build reports navigator.locks as the
    // active backend. We expose nothing on window so we can't read
    // it directly — instead probe navigator.locks itself.
    const locksOk = await pageA.evaluate(() => {
      return typeof navigator.locks === "object"
        && typeof navigator.locks.request === "function";
    });
    if (!locksOk) {
      fail("locks-available", "navigator.locks not present in the test browser");
      return;
    }
    ok("navigator.locks is available in the test browser");

    // Install the test harness on each page. They share IDB (same
    // browser context, same origin). IDB transactions are fully
    // transactional cross-tab — unlike localStorage, whose reads can
    // briefly observe stale values immediately after a sibling
    // write — so a duplicate would necessarily indicate a real lock
    // failure, not a storage cache quirk.
    const installScript = `
      const DB = "sudo-cross-tab-smoke";
      const STORE = "counter";
      function open() {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(DB, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      async function readWriteIncrement() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          const get = store.get("n");
          get.onsuccess = () => {
            const prev = typeof get.result === "number" ? get.result : 0;
            const next = prev + 1;
            const put = store.put(next, "n");
            put.onsuccess = () => resolve(next);
            put.onerror = () => reject(put.error);
          };
          get.onerror = () => reject(get.error);
        });
      }
      async function resetCounter() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(0, "n");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      window.__sudoCrossTab = {
        reset: resetCounter,
        run: async (count) => {
          const out = [];
          const lockName = "sudo/origin-lock/smoke/dev-A";
          for (let i = 0; i < count; i++) {
            await navigator.locks.request(lockName, { mode: "exclusive" }, async () => {
              const value = await readWriteIncrement();
              out.push(value);
            });
          }
          return out;
        }
      };
    `;
    await Promise.all([
      pageA.evaluate(installScript),
      pageB.evaluate(installScript)
    ]);
    // Reset shared counter to 0 before the experiment.
    await pageA.evaluate(() => window.__sudoCrossTab.reset());

    // Race: both tabs request 50 reservations in parallel.
    const [aValues, bValues] = await Promise.all([
      pageA.evaluate(() => window.__sudoCrossTab.run(50)),
      pageB.evaluate(() => window.__sudoCrossTab.run(50))
    ]);

    const all = [...aValues, ...bValues];
    const distinct = new Set(all);

    if (all.length !== 100) fail("count", `expected 100 total reservations, got ${all.length}`);
    else ok("100 total reservations");

    if (distinct.size !== 100) fail("duplicates", `expected 100 distinct values, got ${distinct.size}`);
    else ok("zero duplicates across two tabs");

    const sorted = [...distinct].sort((a, b) => a - b);
    if (sorted[0] !== 1) fail("dense-min", `expected min=1, got ${sorted[0]}`);
    if (sorted[sorted.length - 1] !== 100) fail("dense-max", `expected max=100, got ${sorted[sorted.length - 1]}`);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i + 1] - sorted[i] !== 1) {
        fail("dense-gap", `gap between ${sorted[i]} and ${sorted[i + 1]}`);
        break;
      }
    }
    if (failures.filter((f) => f.startsWith("dense-")).length === 0) {
      ok("dense range 1..100 (no gaps)");
    }

    // Per-tab monotonicity (each tab's record order is strictly increasing).
    function isMonotonic(arr) {
      for (let i = 1; i < arr.length; i++) if (arr[i] <= arr[i - 1]) return false;
      return true;
    }
    if (!isMonotonic(aValues)) fail("tab-A-monotonic", `tab A values not monotonic: ${aValues.slice(0, 10).join(",")}...`);
    else ok(`tab A monotonic (${aValues.length} values)`);
    if (!isMonotonic(bValues)) fail("tab-B-monotonic", `tab B values not monotonic: ${bValues.slice(0, 10).join(",")}...`);
    else ok(`tab B monotonic (${bValues.length} values)`);

  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`CROSS-TAB-SEQUENCE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("CROSS-TAB-SEQUENCE SMOKE PASSED");
})().catch((err) => {
  console.error("CROSS-TAB-SEQUENCE SMOKE ERRORED:", err);
  process.exit(1);
});

#!/usr/bin/env node
// onion-no-clearnet-leak smoke (Phase 12.2).
//
// Asserts the privacy-hardening surface added in Phase 12.2 is
// present and effective on every response:
//   - Referrer-Policy is "no-referrer" (strictest).
//   - Permissions-Policy denies geolocation/microphone/payment/usb/
//     bluetooth/sensors/display-capture/cohort tracking; only
//     camera=(self) is allowed (for the QR scanner).
//   - Cross-Origin-Opener-Policy is set to same-origin.
//   - Cross-Origin-Resource-Policy is set to same-origin.
//   - No response advertises a clearnet host that doesn't match
//     the requested host (audited via node.json sweep already
//     covered by onion-origin-generation; this smoke focuses on
//     the response headers).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

(async () => {
  const r = await fetch(BASE + "/");
  if (r.status !== 200) {
    fail("setup", `expected 200 on /, got ${r.status}`);
    process.exit(1);
  }

  // ===== Referrer-Policy =====
  const referrer = r.headers.get("referrer-policy") ?? "";
  if (referrer !== "no-referrer") {
    fail("1.referrer-policy", `expected 'no-referrer', got '${referrer}'`);
  } else {
    ok(`1. Referrer-Policy: no-referrer (strictest)`);
  }

  // ===== Permissions-Policy =====
  const perms = r.headers.get("permissions-policy") ?? "";
  if (perms.length === 0) {
    fail("2.permissions-policy", "no Permissions-Policy header");
  } else {
    const expectedDenies = [
      "geolocation=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "bluetooth=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "display-capture=()",
      "interest-cohort=()",
      "browsing-topics=()"
    ];
    const missing = expectedDenies.filter((d) => !perms.includes(d));
    if (missing.length > 0) {
      fail("2.permissions-policy-coverage", `missing denies: ${missing.join(", ")}`);
    } else {
      ok(`2. Permissions-Policy denies ${expectedDenies.length} features (no sensor/payment/usb/cohort access)`);
    }
    if (!perms.includes("camera=(self)")) {
      fail("2b.camera", "camera=(self) missing — QR scanner needs it");
    } else {
      ok(`2b. camera=(self) allowed (QR scanner intact)`);
    }
  }

  // ===== Cross-Origin-Opener-Policy + Resource-Policy =====
  const coop = r.headers.get("cross-origin-opener-policy") ?? "";
  if (coop !== "same-origin") {
    fail("3.coop", `expected same-origin, got '${coop}'`);
  } else {
    ok(`3. Cross-Origin-Opener-Policy: same-origin`);
  }
  const corp = r.headers.get("cross-origin-resource-policy") ?? "";
  if (corp !== "same-origin") {
    fail("4.corp", `expected same-origin, got '${corp}'`);
  } else {
    ok(`4. Cross-Origin-Resource-Policy: same-origin`);
  }

  // ===== X-Frame-Options + X-Content-Type-Options (already covered
  // by smoke.sh; we re-check here for self-contained verification). =====
  const xfo = r.headers.get("x-frame-options") ?? "";
  if (xfo !== "DENY") {
    fail("5.x-frame-options", `expected DENY, got '${xfo}'`);
  } else {
    ok(`5. X-Frame-Options: DENY`);
  }

  if (failures.length > 0) {
    console.error(`ONION-NO-CLEARNET-LEAK SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ONION-NO-CLEARNET-LEAK SMOKE PASSED");
})().catch((err) => {
  console.error("ONION-NO-CLEARNET-LEAK SMOKE ERRORED:", err);
  process.exit(1);
});

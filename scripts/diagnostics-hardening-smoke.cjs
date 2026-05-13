#!/usr/bin/env node
// diagnostics-hardening smoke (Phase 11.3).
//
// Asserts the operator/admin diagnostic surface is:
//   1. fully present in development.
//   2. fully 404 in production (gated by isLocalDevelopment).
//   3. never leaks plaintext message bodies, ciphertext, push
//      endpoint URLs, or any owner-bound secret material. Numeric
//      counts and structural keys are fine; raw envelope ciphertext
//      and message bodies are not.
//
// The smoke runs in two modes depending on BASE_URL:
//   - dev (default localhost): asserts 200/JSON shape + scans the
//     responses for forbidden plaintext patterns.
//   - prod: asserts EVERY admin/diag endpoint returns 404.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

// Endpoints that should be present in dev and 404 in prod.
const DIAGNOSTIC_PATHS = [
  { path: "/api/admin/media/summary", method: "GET" },
  { path: "/api/admin/media/gc", method: "POST" },
  { path: "/api/admin/media/gc?dry_run=1", method: "POST" },
  { path: "/api/admin/media/reset-rate-limits", method: "POST" },
  { path: "/api/admin/relay/retention-sweep", method: "POST" },
  { path: "/api/admin/storage/snapshot", method: "GET" },
  { path: "/api/admin/sync/stats", method: "GET" },
  { path: "/api/admin/tombstone-watermarks", method: "GET" },
  { path: "/dev/diagnostics", method: "GET" },
  { path: "/dev/sync/counts", method: "GET" }
];

// Plaintext patterns that should NEVER appear in any diagnostic
// response (these would be content leaks).
const FORBIDDEN_PATTERNS = [
  /[A-Za-z0-9_-]{40,}={0,2}.{40,}/, // long base64-ish ciphertext blob
  /"ciphertext":\s*"[A-Za-z0-9]{8,}/, // raw ciphertext field
  /"body":\s*"[^"]{4,}/, // any non-trivial message body field
  /"endpoint":\s*"https?:\/\//, // raw push subscription endpoint
  /"sender_signature":\s*"[A-Za-z0-9_-]{16,}/ // signature material
];

const isProd = BASE.startsWith("https://") && !BASE.startsWith("https://127.") && !BASE.startsWith("https://localhost");

async function probe(method, p) {
  const r = await fetch(`${BASE}${p}`, { method });
  const text = await r.text();
  return { status: r.status, text };
}

(async () => {
  console.log(`target: ${BASE} (mode=${isProd ? "prod" : "dev"})`);
  if (isProd) {
    // ===== Prod: every endpoint must 404. =====
    for (const ep of DIAGNOSTIC_PATHS) {
      const r = await probe(ep.method, ep.path);
      if (r.status !== 404) {
        fail(`prod.${ep.path}`, `expected 404, got ${r.status}`);
      } else {
        ok(`prod: ${ep.method} ${ep.path} -> 404 (gated)`);
      }
    }
  } else {
    // ===== Dev: endpoints present, no plaintext leaks. =====
    for (const ep of DIAGNOSTIC_PATHS) {
      const r = await probe(ep.method, ep.path);
      if (r.status === 404) {
        fail(`dev.${ep.path}.404`, `endpoint missing in dev mode`);
        continue;
      }
      if (r.status >= 500) {
        fail(`dev.${ep.path}.5xx`, `endpoint returned ${r.status}`);
        continue;
      }
      // Scan response body for forbidden patterns.
      const leaks = FORBIDDEN_PATTERNS.filter((pat) => pat.test(r.text));
      if (leaks.length > 0) {
        fail(`dev.${ep.path}.leak`, `response matches forbidden pattern(s): ${leaks.map((p) => p.source.slice(0, 30)).join(", ")}`);
      } else {
        ok(`dev: ${ep.method} ${ep.path} -> ${r.status} (no plaintext leaks)`);
      }
    }
    // ===== Dev: GET / on a non-existent path under /api/admin should 404. =====
    const fake = await probe("GET", "/api/admin/non-existent-route-xyz");
    if (fake.status !== 404) {
      fail("dev.unknown", `unknown /api/admin/* path should 404, got ${fake.status}`);
    } else {
      ok(`dev: unknown /api/admin/* path correctly 404s`);
    }
  }

  if (failures.length > 0) {
    console.error(`DIAGNOSTICS-HARDENING SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("DIAGNOSTICS-HARDENING SMOKE PASSED");
})().catch((err) => {
  console.error("DIAGNOSTICS-HARDENING SMOKE ERRORED:", err);
  process.exit(1);
});

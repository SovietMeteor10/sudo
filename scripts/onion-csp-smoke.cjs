#!/usr/bin/env node
// onion-csp smoke (Phase 12.1 Part B).
//
// Asserts that the CSP header is origin-relative — i.e. it uses
// 'self' for every source list, never a hardcoded clearnet domain.
// Pinning a specific host would break the page when served on
// .onion (the browser's 'self' would be the .onion origin, not the
// hardcoded clearnet host).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

(async () => {
  const r = await fetch(BASE + "/");
  const csp = r.headers.get("content-security-policy") ?? "";
  if (csp.length === 0) {
    fail("1.missing", "no Content-Security-Policy header on /");
    process.exit(1);
  }
  ok(`1. CSP header present (${csp.length} bytes)`);

  // ===== Part 2: no hardcoded clearnet domain anywhere in CSP. =====
  const forbidden = ["sudochat.xyz", "https://sudochat", "http://sudochat"];
  const leaks = forbidden.filter((d) => csp.includes(d));
  if (leaks.length > 0) {
    fail("2.host-pin", `CSP contains hardcoded clearnet domain(s): ${leaks.join(", ")}`);
  } else {
    ok(`2. CSP has no hardcoded clearnet domain — relative to request origin`);
  }

  // ===== Part 3: every source list is 'self', 'none', or a known
  // safe scheme (data:, blob:). No wildcard origins. =====
  const directives = csp.split(";").map((d) => d.trim());
  const issues = [];
  for (const d of directives) {
    if (d.length === 0) continue;
    const [name, ...sources] = d.split(/\s+/);
    if (typeof name !== "string") continue;
    // We only audit source-list directives, not e.g. report-to.
    const sourceListDirectives = new Set([
      "default-src", "script-src", "style-src", "img-src", "media-src",
      "font-src", "connect-src", "worker-src", "manifest-src",
      "object-src", "frame-ancestors", "base-uri", "form-action", "child-src"
    ]);
    if (!sourceListDirectives.has(name)) continue;
    for (const src of sources) {
      const ok = src === "'self'"
        || src === "'none'"
        || src === "'unsafe-inline'"
        || src.startsWith("'sha256-")
        || src.startsWith("'nonce-")
        || src === "data:"
        || src === "blob:"
        || src === "mediastream:"
        || src === "filesystem:";
      if (!ok) {
        issues.push(`${name} ${src}`);
      }
    }
  }
  if (issues.length > 0) {
    fail("3.unknown-sources", `CSP has non-relative sources: ${issues.join(", ")}`);
  } else {
    ok(`3. CSP uses only 'self' / 'none' / hashes / safe schemes — onion-compatible`);
  }

  // ===== Part 4: frame-ancestors 'none' (no embedding). =====
  if (!csp.includes("frame-ancestors 'none'")) {
    fail("4.frame-ancestors", "frame-ancestors directive missing or not 'none'");
  } else {
    ok(`4. frame-ancestors 'none' — page can't be embedded cross-origin`);
  }

  if (failures.length > 0) {
    console.error(`ONION-CSP SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ONION-CSP SMOKE PASSED");
})().catch((err) => {
  console.error("ONION-CSP SMOKE ERRORED:", err);
  process.exit(1);
});

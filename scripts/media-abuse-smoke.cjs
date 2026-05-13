#!/usr/bin/env node
// media-abuse smoke (Phase 11.2 Part E).
//
// Asserts the abuse-hardening surface:
//   - unknown media classes are rejected with a stable error code
//     (Phase 8 silently fell back to the file cap, Phase 11.2
//     rejects).
//   - oversized uploads short-circuit before they fully land on
//     disk (read after a few KB, stop accepting bytes).
//   - the per-IP upload rate limiter still kicks in.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function upload(opts) {
  const headers = { "content-type": "application/octet-stream" };
  if (opts.mediaClass !== undefined) headers["x-sudo-media-class"] = opts.mediaClass;
  const r = await fetch(`${BASE}/api/media/upload`, {
    method: "POST",
    headers,
    body: opts.bytes
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

(async () => {
  // ===== Part 1: unknown media class is rejected. =====
  const tiny = Buffer.alloc(64, 0x42);
  const bad = await upload({ mediaClass: "garbage-class", bytes: tiny });
  if (bad.status !== 400 || bad.body?.error !== "invalid_media_class") {
    fail("1.bad-class", `expected 400/invalid_media_class, got ${bad.status} ${JSON.stringify(bad.body)}`);
  } else {
    ok(`1. unknown media class 'garbage-class' rejected with 400/invalid_media_class`);
  }
  const empty = await upload({ mediaClass: "", bytes: tiny });
  // Empty class → falls back to "file" via the route's default —
  // intentionally still accepted (the class is omitted, not invalid).
  if (empty.status !== 200) {
    fail("1b.empty-class", `omitted class should default to 'file', got ${empty.status}`);
  } else {
    ok(`1b. omitted media class defaults to 'file' (200 OK)`);
  }

  // ===== Part 2: oversized image. 12 MB > 10 MB image cap. =====
  const oversize = await upload({ mediaClass: "image", bytes: Buffer.alloc(12 * 1024 * 1024, 0x44) });
  if (oversize.status !== 413 || oversize.body?.error !== "payload_too_large") {
    fail("2.oversize", `expected 413/payload_too_large, got ${oversize.status} ${JSON.stringify(oversize.body)}`);
  } else {
    ok(`2. 12MB image rejected with 413/payload_too_large`);
  }

  // ===== Part 3: per-IP burst → 30 uploads/min cap. Send 35 small
  // uploads in tight succession; some should fail with 429. We
  // don't assert exactly which ones, just that at least one 429
  // appears in the tail of the burst. =====
  const burstCount = 35;
  const burstResults = await Promise.all(
    Array.from({ length: burstCount }, () => upload({ mediaClass: "image", bytes: Buffer.alloc(64, 0x33) }))
  );
  const limited = burstResults.filter((r) => r.status === 429);
  if (limited.length === 0) {
    fail("3.burst", `35-upload burst did not trip the per-IP rate limiter (all ${burstCount} returned ${burstResults[0]?.status})`);
  } else {
    ok(`3. per-IP burst limiter tripped: ${limited.length} of ${burstCount} hit 429`);
  }

  if (failures.length > 0) {
    console.error(`MEDIA-ABUSE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MEDIA-ABUSE SMOKE PASSED");
})().catch((err) => {
  console.error("MEDIA-ABUSE SMOKE ERRORED:", err);
  process.exit(1);
});

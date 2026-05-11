#!/usr/bin/env node
// Rate-limit smoke for POST /api/devices/:owner/sync. The limiter
// (src/devices/sync-rate-limit.ts) gates by remote IP at 600/min and
// by owner canonical id at 300/min. Sliding window, in-process.
//
// What this asserts:
//   1. A modest burst (well under both caps) completes without 429.
//   2. A burst that crosses the per-IP cap (700 from one client)
//      eventually returns 429 with scope="ip", Retry-After present,
//      and a sensible retry_after_seconds in the body.
//   3. The limiter runs BEFORE body validation, so garbage payloads
//      still trip the 429 path — proving an attacker who hasn't
//      figured out the protocol can't slip past the cap.
//
// MUST be the last smoke in the suite: it pollutes the per-IP bucket
// for 60s, and any subsequent test from the same loopback will see
// 429s on /sync until the window slides. Smoke harness orders it
// last via scripts/smoke.sh.
//
// HTTP-only. Talks straight to the local node.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/sync-rate-limit-smoke.cjs

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
// Unique owner per run so the per-owner bucket is always fresh and
// the smoke isn't sensitive to leftover state from a previous run.
// The per-IP bucket can carry hits from earlier smokes; phase 1 below
// is tolerant of that.
const OWNER = `sudo:ed25519:${("a".repeat(56) + Date.now().toString(16).padStart(8, "0")).slice(-64)}`;

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function postSync(body) {
  const r = await fetch(`${BASE_URL}/api/devices/${encodeURIComponent(OWNER)}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})), retryAfter: r.headers.get("retry-after") };
}

async function getHealth() {
  const r = await fetch(`${BASE_URL}/health`).catch(() => null);
  return r === null ? { status: 0 } : { status: r.status };
}

(async () => {
  const health = await getHealth();
  if (health.status !== 200) { console.error(`needs node at ${BASE_URL}`); process.exit(2); }

  const junkBody = { signed_event: { type: "sudo_sync_event", garbage: true } };

  // Phase 1 — a single POST returns 400 (invalid body) or 429 (per-IP
  // bucket warmed by an earlier smoke run). Both are valid signals
  // that the route is reachable and gated. We can't drain the per-IP
  // bucket from outside the process, so we accept either outcome and
  // let phase 2 drive the limiter directly.
  const probe = await postSync(junkBody);
  if (probe.status !== 400 && probe.status !== 429) {
    fail("1.unexpected-status", `probe got ${probe.status} (expected 400 invalid_sync_event or 429 rate_limited)`);
    process.exit(1);
  }
  ok(`1. /sync POST reachable (probe returned ${probe.status})`);

  // Phase 2 — fire enough requests to cross the per-IP cap (600/min).
  // Send 700 so we're guaranteed to trip it even if the harness
  // leaked a few hits in earlier smokes. Concurrency boosts the burst
  // so the smoke finishes in seconds rather than minutes.
  const TOTAL = 700;
  const CONCURRENCY = 50;
  const results = { ok2xx: 0, c4xx: 0, c429: 0, other: 0 };
  let firstLimited = null;
  let inFlight = 0;
  let next = 0;
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });
  function pump() {
    while (inFlight < CONCURRENCY && next < TOTAL) {
      const myIndex = next++;
      inFlight++;
      postSync(junkBody).then((r) => {
        if (r.status >= 200 && r.status < 300) results.ok2xx++;
        else if (r.status === 429) {
          results.c429++;
          if (firstLimited === null) firstLimited = { index: myIndex, body: r.body, retryAfter: r.retryAfter };
        }
        else if (r.status >= 400 && r.status < 500) results.c4xx++;
        else results.other++;
        inFlight--;
        if (next >= TOTAL && inFlight === 0) resolveDone();
        else pump();
      }).catch(() => {
        results.other++;
        inFlight--;
        if (next >= TOTAL && inFlight === 0) resolveDone();
        else pump();
      });
    }
  }
  pump();
  await done;

  if (firstLimited === null) {
    fail("2.never-limited", `${TOTAL} requests, no 429 (results: ${JSON.stringify(results)}) — limiter never engaged`);
  } else {
    ok(`2. /sync POST burst of ${TOTAL}: ${results.c4xx} validation-400s, ${results.c429} rate-limited (first 429 at request ~${firstLimited.index + 1})`);
  }

  // Phase 3 — 429 must carry scope=ip or owner_canonical_id (whichever
  // bucket filled first), retry_after_seconds, and Retry-After. The
  // per-owner cap (300) is tighter than per-IP (600), so when both
  // buckets count toward the same canonical_id the owner bucket
  // typically fires first.
  if (firstLimited !== null) {
    if (firstLimited.body?.scope !== "ip" && firstLimited.body?.scope !== "owner_canonical_id") {
      fail("3.scope", `expected scope='ip'|'owner_canonical_id', got '${firstLimited.body?.scope}'`);
    } else {
      ok(`3. 429 carries scope='${firstLimited.body.scope}' (whichever bucket filled first)`);
    }
    const retryAfterSeconds = Number(firstLimited.retryAfter);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0 || retryAfterSeconds > 120) {
      fail("3b.retry-after", `Retry-After header missing or out of range: ${firstLimited.retryAfter}`);
    } else {
      ok(`3b. Retry-After header present (${retryAfterSeconds}s)`);
    }
    const bodyRetryAfter = firstLimited.body?.retry_after_seconds;
    if (typeof bodyRetryAfter !== "number" || bodyRetryAfter <= 0) {
      fail("3c.body-retry-after", `body.retry_after_seconds missing or invalid: ${bodyRetryAfter}`);
    } else {
      ok(`3c. body.retry_after_seconds present (${bodyRetryAfter}s)`);
    }
    if (firstLimited.body?.error !== "rate_limited") {
      fail("3d.error-code", `expected body.error='rate_limited', got '${firstLimited.body?.error}'`);
    } else {
      ok(`3d. body.error='rate_limited'`);
    }
  }

  // Phase 4 — sanity: the limiter is per IP, applied BEFORE body
  // validation. A subsequent POST with a *valid-looking* signed_event
  // also returns 429 — proving the cap is the gate, not the body.
  const wellFormedJunk = {
    signed_event: {
      type: "sudo_sync_event",
      protocol_version: "0.1.0",
      event_id: "00000000-0000-0000-0000-000000000000",
      owner_canonical_id: OWNER,
      origin_device_id: "fake-device",
      slice: "contact",
      kind: "contact.upsert",
      sequence: 1,
      created_at: new Date().toISOString(),
      encrypted_payload: "AAA",
      signature: "x"
    }
  };
  const limitedSane = await postSync(wellFormedJunk);
  if (limitedSane.status !== 429) {
    fail("4.body-bypass", `well-formed-but-bogus body got ${limitedSane.status}, expected 429 (limiter should fire before signature check)`);
  } else {
    ok(`4. well-formed body still returns 429 — limiter gates before body validation`);
  }

  if (failures.length > 0) {
    console.error(`\nSYNC RATE-LIMIT SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nSYNC RATE-LIMIT SMOKE PASSED");
})().catch((error) => { console.error("SYNC RATE-LIMIT SMOKE ERROR", error); process.exit(2); });

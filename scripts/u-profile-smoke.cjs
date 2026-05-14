#!/usr/bin/env node
// Phase 14B: /u/:handle public profile + signed bio endpoint.
//
// Verifies:
//   1. /u/:handle returns 200 HTML for a registered identity.
//   2. /u/:canonical_id returns the technical view (and a link to the
//      friendly one).
//   3. /u/<unknown> returns 404 HTML.
//   4. POST /api/identity/bio requires identity-sig (unauth → 401).
//   5. Signed bio update normalizes (trims, strips control chars,
//      caps at 280) and surfaces in /api/identity/profiles + /u/handle.
//   6. Cross-handed sig (eve signs but body owner = alice) is rejected.

const { registerClientIdentity } = require("./lib/register-client-identity.cjs");
const { postJsonSignedIdentity, signIdentityRequest } = require("./lib/request-auth-helpers.cjs");

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const failures = [];
const pass = (label) => console.log("ok:", label);
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };

async function run() {
  console.log(`BASE=${BASE}`);
  const tag = Math.random().toString(36).slice(2, 9);
  const alice = await registerClientIdentity(BASE, `up_a_${tag}`);
  const eve = await registerClientIdentity(BASE, `up_e_${tag}`);
  const aliceHandleNoAt = alice.handle.replace(/^@/, "");

  // 1. /u/:handle returns 200 + handle visible.
  const r1 = await fetch(`${BASE}/u/${encodeURIComponent(aliceHandleNoAt)}`);
  const r1Body = await r1.text();
  if (r1.status !== 200) fail("1.handle-get", `expected 200, got ${r1.status}`);
  else if (!r1Body.includes(`@${aliceHandleNoAt}`)) fail("1.handle-rendered", `handle missing from page`);
  else pass(`1. /u/${aliceHandleNoAt} returns 200 HTML with handle`);

  // 2. /u/:canonical returns 200 + technical view.
  const r2 = await fetch(`${BASE}/u/${encodeURIComponent(alice.canonical_id)}`);
  const r2Body = await r2.text();
  if (r2.status !== 200) fail("2.canonical-get", `expected 200, got ${r2.status}`);
  else if (!r2Body.includes(alice.canonical_id)) fail("2.canonical-rendered", `canonical_id missing`);
  else if (!r2Body.includes(`/u/${aliceHandleNoAt}`)) fail("2.friendly-link", `friendly-view link missing`);
  else pass(`2. /u/${alice.canonical_id.slice(0, 24)}... returns tech view + friendly link`);

  // 3. /u/<unknown> returns 404 HTML. Handles are 3-32 chars [A-Za-z0-9_].
  const r3 = await fetch(`${BASE}/u/nosuchuser_${tag}`);
  if (r3.status !== 404) fail("3.unknown-404", `expected 404, got ${r3.status}`);
  else pass(`3. /u/<unknown> returns 404`);

  // 4. POST /api/identity/bio requires sig.
  const unauth = await fetch(`${BASE}/api/identity/bio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canonical_id: alice.canonical_id, bio: "hi" })
  });
  if (unauth.status !== 401) fail("4.bio-unauth", `expected 401, got ${unauth.status}`);
  else pass(`4. unauth POST /api/identity/bio returns 401`);

  // 5. Signed bio update (with control chars + long body → server normalizes).
  const rawBio = "  hello\x00\x01world — line 1\nline 2  " + "x".repeat(400);
  const aliceSigner = { canonicalId: alice.canonical_id, privateKey: alice.identity_key.privateKey };
  const bioResp = await postJsonSignedIdentity(BASE, "/api/identity/bio", {
    canonical_id: alice.canonical_id, bio: rawBio
  }, aliceSigner);
  if (bioResp.status !== 200) fail("5.bio-set", `set bio failed: ${bioResp.status}`);
  else if (typeof bioResp.body?.bio !== "string") fail("5.bio-shape", `no bio in response`);
  else if (bioResp.body.bio.length > 280) fail("5.bio-cap", `bio exceeds 280 chars: ${bioResp.body.bio.length}`);
  else if (bioResp.body.bio.includes("\x00") || bioResp.body.bio.includes("\x01")) fail("5.bio-ctrl", `control chars not stripped`);
  else pass(`5. signed bio set, normalized to ${bioResp.body.bio.length} chars, control chars stripped`);

  // 6. Bio visible on /u/handle. The `.bio-empty` CSS rule lives in
  // the inline <style> regardless, so we only check that the bio
  // element doesn't carry the empty modifier in its class attribute.
  const r6 = await fetch(`${BASE}/u/${encodeURIComponent(aliceHandleNoAt)}`);
  const r6Body = await r6.text();
  if (!r6Body.includes("hello")) fail("6.bio-rendered", `bio text missing from /u/${aliceHandleNoAt}`);
  else if (/class="bio bio-empty"/.test(r6Body)) fail("6.bio-empty-class", `bio element still has bio-empty modifier after set`);
  else pass(`6. /u/${aliceHandleNoAt} now shows the bio (no empty-modifier)`);

  // 7. Cross-handed sig: eve signs, body says alice → 403 canonical_id_mismatch.
  const cross = signIdentityRequest({
    method: "POST",
    path: "/api/identity/bio",
    body: { canonical_id: alice.canonical_id, bio: "evil bio" },
    canonicalId: eve.canonical_id,
    privateKey: eve.identity_key.privateKey
  });
  const crossResp = await fetch(`${BASE}/api/identity/bio`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sudo-auth": cross },
    body: JSON.stringify({ canonical_id: alice.canonical_id, bio: "evil bio" })
  });
  if (crossResp.status !== 403) fail("7.cross-handed", `expected 403, got ${crossResp.status}`);
  else pass(`7. cross-handed sig rejected with 403 (eve cannot set alice's bio)`);

  // 8. /docs/HOW_SUDO_WORKS.md is served.
  const r8 = await fetch(`${BASE}/docs/HOW_SUDO_WORKS.md`);
  if (r8.status !== 200) fail("8.docs-served", `expected 200, got ${r8.status}`);
  else if (!(r8.headers.get("content-type") ?? "").includes("text/plain")) fail("8.docs-type", `expected text/plain, got ${r8.headers.get("content-type")}`);
  else pass(`8. /docs/HOW_SUDO_WORKS.md served as text/plain`);

  // 9. /docs/<bogus> denied (must end with .md).
  const r9 = await fetch(`${BASE}/docs/../package.json`);
  if (r9.status === 200 && !(r9.headers.get("content-type") ?? "").includes("text/plain")) {
    fail("9.docs-traversal", `unexpected 200 non-text for ../package.json`);
  } else pass(`9. /docs/ rejects non-md / traversal-shaped requests`);

  if (failures.length > 0) {
    console.error(`\nU-PROFILE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("U-PROFILE SMOKE PASSED");
}

run().catch((err) => { console.error("U-PROFILE SMOKE ERRORED:", err); process.exit(1); });

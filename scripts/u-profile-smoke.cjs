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

  // 6. Bio visible on /u/handle once set. Element should render with
  // the bio class.
  const r6 = await fetch(`${BASE}/u/${encodeURIComponent(aliceHandleNoAt)}`);
  const r6Body = await r6.text();
  if (!r6Body.includes("hello")) fail("6.bio-rendered", `bio text missing from /u/${aliceHandleNoAt}`);
  else if (!/<p class="bio">/.test(r6Body)) fail("6.bio-element", `<p class="bio"> missing in /u/${aliceHandleNoAt}`);
  else pass(`6. /u/${aliceHandleNoAt} now shows the bio`);

  // 6a. Phase 14B polish: no "no bio yet." placeholder anywhere on
  // the friendly page (eve has no bio set).
  const eveHandleNoAt = eve.handle.replace(/^@/, "");
  const r6a = await fetch(`${BASE}/u/${encodeURIComponent(eveHandleNoAt)}`);
  const r6aBody = await r6a.text();
  if (/no bio yet/i.test(r6aBody)) fail("6a.no-placeholder", `friendly page still shows "no bio yet" placeholder`);
  else if (/<p class="bio[^>]*>/.test(r6aBody)) fail("6a.empty-bio-element", `friendly page rendered an empty <p class="bio"> element for an unset bio`);
  else pass(`6a. friendly page omits bio entirely when none is set`);

  // 6b. Phase 14B polish: friendly profile must not contain "identity
  // document" placeholder copy. Technical terms live behind the
  // /u/:canonical_id link.
  if (/identity document/i.test(r6aBody)) fail("6b.no-identity-document", `friendly page contains "identity document" copy`);
  else pass(`6b. friendly page has no "identity document" copy`);

  // 6c. Phase 14B final polish: clearing the bio (POST with bio="")
  // removes it from /u/:handle, restoring the no-bio rendering.
  const clearResp = await postJsonSignedIdentity(BASE, "/api/identity/bio", {
    canonical_id: alice.canonical_id, bio: ""
  }, aliceSigner);
  if (clearResp.status !== 200 || clearResp.body?.bio !== "") {
    fail("6c.bio-clear", `expected empty bio after clear, got ${JSON.stringify(clearResp.body)}`);
  } else {
    const r6c = await fetch(`${BASE}/u/${encodeURIComponent(aliceHandleNoAt)}`);
    const r6cBody = await r6c.text();
    if (/<p class="bio[^>]*>/.test(r6cBody)) fail("6c.bio-still-rendered", `bio element still rendered after clear`);
    else if (/no bio yet/i.test(r6cBody)) fail("6c.placeholder-after-clear", `"no bio yet" placeholder reappeared after clear`);
    else pass(`6c. clearing bio removes it from /u/:handle`);
  }

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

  // 7a. Phase 14B polish: landing page (unauthenticated /) must
  // expose the About button. The landing screen is the only surface
  // available before sign-in; About has to be reachable there.
  const r7a = await fetch(`${BASE}/`);
  const r7aBody = await r7a.text();
  if (!/<section[^>]*class="landing"/.test(r7aBody)) fail("7a.landing-present", `landing section missing on /`);
  else if (!/data-auth-action="about"/.test(r7aBody)) fail("7a.about-button-present", `about button missing on landing`);
  else if (!/landing__about-link/.test(r7aBody)) fail("7a.about-styled", `about button missing landing__about-link class`);
  else pass(`7a. landing exposes the About button before auth`);

  // 7b. Landing renders the interactive constellation canvas (Phase
  // 14B polish — replaces the prior grid+glow atmosphere).
  if (!/<canvas[^>]*id="landing-constellation"/.test(r7aBody)) fail("7b.constellation-canvas", `landing-constellation canvas missing`);
  else pass(`7b. landing has constellation canvas`);

  // 8. Phase 14B mobile polish: /docs/HOW_SUDO_WORKS.md is served as
  // styled HTML (sudo doc shell) rather than raw text/plain.
  const r8 = await fetch(`${BASE}/docs/HOW_SUDO_WORKS.md`);
  if (r8.status !== 200) fail("8.docs-served", `expected 200, got ${r8.status}`);
  else {
    const ct = r8.headers.get("content-type") ?? "";
    const body = await r8.text();
    if (!ct.includes("text/html")) fail("8.docs-html", `expected text/html, got ${ct}`);
    else if (!/<article class="doc-shell"/.test(body)) fail("8.docs-shell", `doc-shell markup missing`);
    else if (!/back to sudo/i.test(body)) fail("8.docs-nav", `back-to-sudo nav missing`);
    else if (!/<h1>How sudo works<\/h1>/.test(body)) fail("8.docs-h1", `top-level heading missing or not rendered`);
    else if (!/<h2>In one paragraph<\/h2>/.test(body)) fail("8.docs-h2", `h2 not rendered from markdown`);
    else if (/^#/m.test(body.split("doc-shell__body")[1] ?? "")) fail("8.docs-raw-md", `raw markdown leaked into rendered body`);
    else pass(`8. /docs/HOW_SUDO_WORKS.md rendered as styled HTML with shell`);
  }

  // 8a. Doc allowlist: an allowlisted doc renders; a non-allowlisted
  // markdown file 404s (falls through to the SPA's catch-all).
  const r8a = await fetch(`${BASE}/docs/TRUST_MODEL.md`);
  if (r8a.status !== 200) fail("8a.trust-doc", `expected 200 for TRUST_MODEL.md, got ${r8a.status}`);
  else pass(`8a. TRUST_MODEL.md renders`);

  const r8b = await fetch(`${BASE}/docs/SMOKE.md`);
  if (r8b.status === 200) fail("8b.allowlist-leak", `non-allowlisted doc SMOKE.md was served`);
  else pass(`8b. non-allowlisted docs are not exposed (SMOKE.md -> ${r8b.status})`);

  // 9. /docs/<traversal> denied.
  const r9 = await fetch(`${BASE}/docs/../package.json`);
  if (r9.status === 200) {
    const r9body = await r9.text();
    if (r9body.includes('"dependencies"')) fail("9.docs-traversal", `path traversal returned package.json content`);
    else pass(`9. /docs/ rejects traversal-shaped requests`);
  } else pass(`9. /docs/ rejects traversal-shaped requests (status ${r9.status})`);

  if (failures.length > 0) {
    console.error(`\nU-PROFILE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("U-PROFILE SMOKE PASSED");
}

run().catch((err) => { console.error("U-PROFILE SMOKE ERRORED:", err); process.exit(1); });

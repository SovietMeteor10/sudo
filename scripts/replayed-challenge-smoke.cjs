#!/usr/bin/env node
// Replayed-challenge smoke.
//
// Asserts that:
//   1. A fresh nonce can be issued.
//   2. Consuming a nonce a second time fails (401 invalid_session_challenge).
//   3. A failed consume (wrong signature) ALSO burns the nonce — a
//      subsequent correct-signature consume of the same nonce fails.
//   4. Race two simultaneous consumes of one nonce: exactly one wins.
//   5. An unknown nonce returns 401 with the same shape (no
//      enumeration of "this one exists, that one doesn't").
//   6. A wrong canonical_id paired with the right nonce burns it.

const { generateKeyPairSync, createHash, sign } = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, sortKeys(v)]));
  }
  return value;
}
function canonicalJson(v) { return JSON.stringify(sortKeys(v)); }
function sha256Hex(s) { return createHash("sha256").update(s).digest("hex"); }
function formatCanonicalId(t, h) { return `sudo:${t}:${h}`; }

async function postJson(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function getJson(path) {
  const r = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

function makeOwner(handle) {
  const id = generateKeyPairSync("ed25519");
  const ms = generateKeyPairSync("ed25519");
  const fd = generateKeyPairSync("ed25519");
  const idSpki = b64url(id.publicKey.export({ format: "der", type: "spki" }));
  const msSpki = b64url(ms.publicKey.export({ format: "der", type: "spki" }));
  const fdSpki = b64url(fd.publicKey.export({ format: "der", type: "spki" }));
  const createdAt = new Date().toISOString();
  const base = {
    type: "sudo_identity", protocol_version: "0.1.0",
    canonical_id: formatCanonicalId("ed25519", sha256Hex(idSpki)),
    handle: `@${handle}`, home_node: BASE_URL,
    keys: {
      identity: { type: "ed25519", public_key: idSpki },
      messaging: { type: "ed25519", public_key: msSpki },
      feed: { type: "ed25519", public_key: fdSpki }
    },
    delivery_relays: [], feed_endpoints: [],
    created_at: createdAt, updated_at: createdAt, sequence: 1
  };
  const signature = b64url(sign(null, Buffer.from(canonicalJson(base)), id.privateKey));
  return { document: { ...base, signature }, privateKey: id.privateKey, canonicalId: base.canonical_id };
}

function signNonce(owner, nonce) {
  const signable = { type: "sudo_session_challenge", canonical_id: owner.canonicalId, nonce };
  return b64url(sign(null, Buffer.from(canonicalJson(signable)), owner.privateKey));
}

async function issueNonce(canonicalId) {
  const r = await getJson(`/api/identity/challenge/${encodeURIComponent(canonicalId)}`);
  return r;
}

(async () => {
  console.log(`BASE=${BASE_URL}`);
  const owner = makeOwner("chal" + Date.now().toString().slice(-6));
  const reg = await postJson("/api/identity/register", { identity_document: owner.document });
  if (reg.status !== 201) { fail("setup", `register ${reg.status}`); process.exit(1); }
  ok("owner registered");

  // 1. Issue + consume happy path.
  let issued = await issueNonce(owner.canonicalId);
  if (issued.status !== 200 || typeof issued.body?.nonce !== "string") {
    fail("issue", `status=${issued.status} body=${JSON.stringify(issued.body)}`);
    process.exit(1);
  }
  ok(`challenge issued: nonce.len=${issued.body.nonce.length}`);

  let consume = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (consume.status !== 200 || typeof consume.body?.sessionToken !== "string") {
    fail("happy-consume", `status=${consume.status} body=${JSON.stringify(consume.body)}`);
  } else ok("happy-path consume mints a session token");

  // 2. Replay: same nonce again → 401.
  const replay = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (replay.status !== 401) fail("replay", `expected 401, got ${replay.status} ${JSON.stringify(replay.body)}`);
  else ok(`replay of consumed nonce -> 401`);
  if (replay.body?.error !== "invalid_session_challenge") {
    fail("replay-shape", `expected error='invalid_session_challenge', got '${replay.body?.error}'`);
  }

  // 3. Bad-signature attempt burns the nonce.
  issued = await issueNonce(owner.canonicalId);
  const badSigConsume = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: b64url(Buffer.alloc(64, 0xaa))
  });
  if (badSigConsume.status !== 401) fail("bad-sig", `expected 401, got ${badSigConsume.status}`);
  else ok(`bad-signature consume -> 401`);

  // Subsequent correct consume of the SAME nonce: must also fail (nonce was burned).
  const retryAfterBad = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (retryAfterBad.status !== 401) fail("retry-after-bad", `expected 401, got ${retryAfterBad.status}`);
  else ok(`correct sig after bad sig still 401 (nonce burned on first try)`);

  // 4. Race two parallel consumes of one nonce.
  issued = await issueNonce(owner.canonicalId);
  const consumes = await Promise.all([
    postJson("/api/identity/session-from-challenge", {
      canonical_id: owner.canonicalId,
      nonce: issued.body.nonce,
      signature: signNonce(owner, issued.body.nonce)
    }),
    postJson("/api/identity/session-from-challenge", {
      canonical_id: owner.canonicalId,
      nonce: issued.body.nonce,
      signature: signNonce(owner, issued.body.nonce)
    })
  ]);
  const successes = consumes.filter((r) => r.status === 200).length;
  const failsCount = consumes.filter((r) => r.status === 401).length;
  if (successes !== 1) fail("race-successes", `expected exactly 1 success, got ${successes} (${consumes.map((r) => r.status).join(",")})`);
  else ok(`race of 2 parallel consumes: exactly 1 wins`);
  if (failsCount !== 1) fail("race-fails", `expected exactly 1 fail, got ${failsCount}`);
  else ok(`race losers all -> 401`);

  // 5. Unknown nonce.
  const unknown = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: b64url(Buffer.alloc(32, 0x55)),
    signature: signNonce(owner, "anything")
  });
  if (unknown.status !== 401) fail("unknown-nonce", `expected 401, got ${unknown.status}`);
  else ok(`unknown nonce -> 401`);

  // 6. Wrong canonical id (with a different REGISTERED identity)
  //    paired with the right nonce: server rejects 401 AND burns the
  //    nonce. We must use a registered identity here because the
  //    handler early-returns 401 for unknown canonical_ids without
  //    touching the nonce store; that is correct behavior (avoids a
  //    burn-other-people's-nonces denial-of-service via probing
  //    unregistered IDs).
  const otherOwner = makeOwner("chalother" + Date.now().toString().slice(-6));
  const otherReg = await postJson("/api/identity/register", { identity_document: otherOwner.document });
  if (otherReg.status !== 201) { fail("setup-other", `register ${otherReg.status}`); }

  issued = await issueNonce(owner.canonicalId);
  const wrong = await postJson("/api/identity/session-from-challenge", {
    canonical_id: otherOwner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(otherOwner, issued.body.nonce)
  });
  if (wrong.status !== 401) fail("wrong-canonical", `expected 401, got ${wrong.status}`);
  else ok(`wrong canonical_id with valid nonce -> 401`);

  const correctAfterWrong = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (correctAfterWrong.status !== 401) fail("wrong-burns", `expected 401, got ${correctAfterWrong.status}`);
  else ok(`correct retry after wrong-canonical still 401 (nonce burned)`);

  // 7. Verify the early-401 short-circuit for an UNREGISTERED canonical_id.
  //    This is the defence against probing-burn-other-people's-nonces.
  issued = await issueNonce(owner.canonicalId);
  const unregistered = `sudo:ed25519:${"f".repeat(64)}`;
  const probe = await postJson("/api/identity/session-from-challenge", {
    canonical_id: unregistered,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (probe.status !== 401) fail("probe-unregistered", `expected 401, got ${probe.status}`);
  else ok(`probe with unregistered canonical_id -> 401`);
  // The legit user can still consume their own nonce — the probe didn't burn it.
  const legitAfterProbe = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: issued.body.nonce,
    signature: signNonce(owner, issued.body.nonce)
  });
  if (legitAfterProbe.status !== 200) fail("probe-no-burn", `expected 200 after probe, got ${legitAfterProbe.status}`);
  else ok(`probe does NOT burn the real user's nonce (200 on legit retry)`);

  if (failures.length > 0) {
    console.error(`REPLAYED-CHALLENGE SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("REPLAYED-CHALLENGE SMOKE PASSED");
})().catch((err) => {
  console.error("REPLAYED-CHALLENGE SMOKE ERRORED:", err);
  process.exit(1);
});

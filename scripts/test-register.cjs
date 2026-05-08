#!/usr/bin/env node
// Regression harness for /api/identity/register.
//
// Simulates the browser path by generating an Ed25519 keypair, building a
// browser-style identity document with a SPKI-base64url public key, deriving
// canonical_id the same way the client/server do, signing the canonicalized
// document, and POSTing it. Then mutates canonical_id and asserts rejection.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/test-register.cjs
//
// Exits non-zero on any assertion failure.
const { generateKeyPairSync, createPublicKey, createHash, sign } = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

function ok(msg) {
  console.log("ok:", msg);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatCanonicalId(keyType, hashHex) {
  return `sudo:${keyType}:${hashHex}`;
}

function buildIdentityKeys(handle) {
  const identity = generateKeyPairSync("ed25519");
  const messaging = generateKeyPairSync("ed25519");
  const feed = generateKeyPairSync("ed25519");
  const identityPublicKeySpki = base64url(identity.publicKey.export({ format: "der", type: "spki" }));
  const messagingPublicKeySpki = base64url(messaging.publicKey.export({ format: "der", type: "spki" }));
  const feedPublicKeySpki = base64url(feed.publicKey.export({ format: "der", type: "spki" }));
  const createdAt = new Date().toISOString();
  const baseDocument = {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: formatCanonicalId("ed25519", sha256Hex(identityPublicKeySpki)),
    handle: `@${handle}`,
    home_node: BASE_URL,
    keys: {
      identity: { type: "ed25519", public_key: identityPublicKeySpki },
      messaging: { type: "ed25519", public_key: messagingPublicKeySpki },
      feed: { type: "ed25519", public_key: feedPublicKeySpki }
    },
    delivery_relays: [],
    feed_endpoints: [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence: 1
  };
  return { identityPrivateKey: identity.privateKey, baseDocument };
}

function signDocument(document, privateKey) {
  const signature = base64url(sign(null, Buffer.from(canonicalJson(document)), privateKey));
  return { ...document, signature };
}

async function postRegister(document) {
  const response = await fetch(`${BASE_URL}/api/identity/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ identity_document: document })
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

(async () => {
  const handleA = "regtest" + Date.now().toString().slice(-7);
  const { identityPrivateKey, baseDocument } = buildIdentityKeys(handleA);

  // 1. canonical_id literally "[object Promise]" — the production-symptomatic case.
  //    Sign the broken doc so signature passes; rejection must come from canonical-id check.
  const brokenDoc = { ...baseDocument, canonical_id: "sudo:ed25519:[object Promise]" };
  const brokenSigned = signDocument(brokenDoc, identityPrivateKey);
  const broken = await postRegister(brokenSigned);
  if (broken.status === 201) fail("server accepted '[object Promise]' canonical_id");
  if (!broken.body?.message?.toLowerCase().includes("canonical")) {
    fail(`expected canonical-id error, got status=${broken.status} body=${JSON.stringify(broken.body)}`);
  }
  ok(`server rejects [object Promise] canonical_id (status=${broken.status}, msg='${broken.body.message}')`);

  // 2. Well-formed but wrong canonical_id hash.
  const wrongHashDoc = { ...baseDocument, canonical_id: formatCanonicalId("ed25519", "0".repeat(64)) };
  const wrongHashSigned = signDocument(wrongHashDoc, identityPrivateKey);
  const wrongHashResp = await postRegister(wrongHashSigned);
  if (wrongHashResp.status === 201) fail("server accepted a wrong-hash canonical_id");
  if (!wrongHashResp.body?.message?.toLowerCase().includes("canonical")) {
    fail(`expected canonical-id error, got status=${wrongHashResp.status} body=${JSON.stringify(wrongHashResp.body)}`);
  }
  ok(`server rejects wrong-hash canonical_id (status=${wrongHashResp.status})`);

  // 3. Wrong key-type label — canonical_id keytype != actual key. Server should refuse.
  //    The canonical_id formula uses the declared key_type, so a mismatched declaration
  //    produces a different recomputed id. Sign cleanly.
  const wrongType = JSON.parse(JSON.stringify(baseDocument));
  wrongType.keys.identity.type = "ecdsa-p256";
  // canonical_id still says ed25519 -> recomputation will use ecdsa-p256 and mismatch
  const wrongTypeSigned = signDocument(wrongType, identityPrivateKey);
  const wrongTypeResp = await postRegister(wrongTypeSigned);
  if (wrongTypeResp.status === 201) fail("server accepted a doc whose declared key type does not match canonical_id");
  ok(`server rejects key-type/canonical_id mismatch (status=${wrongTypeResp.status})`);

  // 4. The good doc registers cleanly.
  const goodSigned = signDocument(baseDocument, identityPrivateKey);
  const goodResp = await postRegister(goodSigned);
  if (goodResp.status !== 201) fail(`expected 201 for good doc, got ${goodResp.status} body=${JSON.stringify(goodResp.body)}`);
  if (goodResp.body?.identity?.canonical_id !== baseDocument.canonical_id) {
    fail(`server returned different canonical_id: ${goodResp.body?.identity?.canonical_id}`);
  }
  ok(`server accepts a well-formed Ed25519 identity (canonical_id=${baseDocument.canonical_id})`);

  // 5. Lookup by handle round-trips.
  const lookupResp = await fetch(`${BASE_URL}/api/identity/handles/${handleA}`);
  if (lookupResp.status !== 200) fail(`handle lookup failed: ${lookupResp.status}`);
  const lookupBody = await lookupResp.json();
  if (lookupBody.canonical_id !== baseDocument.canonical_id) {
    fail(`handle lookup returned wrong canonical_id: ${lookupBody.canonical_id}`);
  }
  ok("handle lookup round-trips");

  // 6. Fingerprint route returns the registered identity.
  const fpResp = await fetch(`${BASE_URL}/api/identity/${encodeURIComponent(baseDocument.canonical_id)}/fingerprint`);
  if (fpResp.status !== 200) fail(`fingerprint route failed: ${fpResp.status}`);
  ok("fingerprint route returns the identity");

  console.log("\nidentity-register regression passed");
})().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(2);
});

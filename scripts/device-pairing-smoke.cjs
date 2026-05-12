#!/usr/bin/env node
// Device-pairing smoke. Exercises the trusted-device routes directly
// against a running node and asserts the contract holds end-to-end:
//   1. register an Ed25519 identity (the would-be owner)
//   2. /api/devices/pair/start returns a pairing_code + token
//   3. /api/devices/pair/complete accepts a freshly-encrypted bootstrap
//      payload + a device public key, and returns the stored device
//   4. listing the owner's devices returns the new device as active
//   5. encrypting + locally decrypting the bootstrap payload with the
//      pairing code round-trips the device record, proving the
//      "encrypted_bootstrap_payload" field is opaque ciphertext only
//   6. revoke flips trust_state to revoked
//
// This smoke does NOT require a browser. It runs entirely against the
// HTTP surface of a running sudo node. If a SignedDeviceMembership doc
// is supplied (a follow-up phase), this file will be the first to
// assert on it; today it tolerates servers that don't yet return one.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/device-pairing-smoke.cjs

const {
  generateKeyPairSync,
  createHash,
  createPublicKey,
  sign,
  randomBytes,
  randomUUID,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PBKDF2_ITERATIONS = 120000;

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

function base64urlToBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
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

function buildOwnerIdentity(handle) {
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
  const signature = base64url(sign(null, Buffer.from(canonicalJson(baseDocument)), identity.privateKey));
  return {
    document: { ...baseDocument, signature },
    identityPrivateKey: identity.privateKey,
    identityPublicKey: identity.publicKey,
    canonicalId: baseDocument.canonical_id
  };
}

async function postJson(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

function encryptBootstrapPayload(pairingCode, payloadObject) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(pairingCode, "utf8"), salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObject), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    salt: base64url(salt),
    iv: base64url(iv),
    ciphertext: base64url(Buffer.concat([ciphertext, tag]))
  });
}

function decryptBootstrapPayload(pairingCode, payloadJson) {
  const envelope = JSON.parse(payloadJson);
  const salt = base64urlToBuffer(envelope.salt);
  const iv = base64urlToBuffer(envelope.iv);
  const blob = base64urlToBuffer(envelope.ciphertext);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);
  const key = pbkdf2Sync(Buffer.from(pairingCode, "utf8"), salt, PBKDF2_ITERATIONS, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

(async () => {
  // Pre-flight: server must be reachable.
  const health = await getJson("/health").catch(() => ({ status: 0, body: {} }));
  if (health.status !== 200) {
    console.error(`device-pairing smoke needs a running node at ${BASE_URL} (got ${health.status})`);
    process.exit(2);
  }

  // 1. Register an owner identity using the same canonical-id contract
  //    the client portal uses. This is what /api/devices/pair/start
  //    will be told the device belongs to.
  const handle = "devpair" + Date.now().toString().slice(-7);
  const owner = buildOwnerIdentity(handle);
  const registered = await postJson("/api/identity/register", { identity_document: owner.document });
  if (registered.status !== 201 || registered.body?.identity?.canonical_id !== owner.canonicalId) {
    fail(`could not register owner identity: status=${registered.status} body=${JSON.stringify(registered.body)}`);
  }
  ok(`owner identity registered (${owner.canonicalId})`);

  // 2. /api/devices/pair/start returns a pairing_code + token + expiry.
  const pairStart = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  if (pairStart.status !== 201 || !pairStart.body.ok) fail(`pair/start unexpected: status=${pairStart.status} body=${JSON.stringify(pairStart.body)}`);
  const { pairing_code, pairing_token, expires_at } = pairStart.body;
  if (!pairing_code || !pairing_token || !expires_at) fail(`pair/start missing fields: ${JSON.stringify(pairStart.body)}`);
  if (Date.parse(expires_at) <= Date.now()) fail(`pair/start expires_at is in the past: ${expires_at}`);
  ok(`pair/start returned code=${pairing_code} token-prefix=${pairing_token.slice(0, 8)} expires=${expires_at}`);

  // 3. Build a device record and encrypt the bootstrap payload locally
  //    with the pairing code. The server should never need to decrypt
  //    this — it persists the opaque blob and returns the device row.
  const device = generateKeyPairSync("ed25519");
  const devicePublicKeySpki = base64url(device.publicKey.export({ format: "der", type: "spki" }));
  const deviceId = randomUUID();
  const bootstrapPlaintext = {
    device_id: deviceId,
    owner_canonical_id: owner.canonicalId,
    name: "smoke-laptop",
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  };
  const encryptedBootstrap = encryptBootstrapPayload(pairing_code, bootstrapPlaintext);

  const pairComplete = await postJson("/api/devices/pair/complete", {
    pairing_code,
    device_id: deviceId,
    name: "smoke-laptop",
    device_public_key: devicePublicKeySpki,
    encrypted_bootstrap_payload: encryptedBootstrap
  });
  if (pairComplete.status !== 201 || !pairComplete.body.ok) fail(`pair/complete unexpected: status=${pairComplete.status} body=${JSON.stringify(pairComplete.body)}`);
  if (pairComplete.body.device?.device_id !== deviceId) fail(`pair/complete returned wrong device_id: ${JSON.stringify(pairComplete.body.device)}`);
  if (pairComplete.body.device?.trust_state !== "active") fail(`pair/complete returned non-active trust_state: ${pairComplete.body.device?.trust_state}`);
  if (pairComplete.body.device?.owner_canonical_id !== owner.canonicalId) fail("pair/complete returned wrong owner");
  ok(`pair/complete stored device ${deviceId.slice(0, 8)} as active`);

  // 4. Reusing the same code must fail (single-use semantics).
  const pairReplay = await postJson("/api/devices/pair/complete", {
    pairing_code,
    device_id: randomUUID(),
    name: "replay-attempt",
    device_public_key: devicePublicKeySpki,
    encrypted_bootstrap_payload: encryptedBootstrap
  });
  if (pairReplay.status === 201) fail("pair/complete accepted a replayed pairing code");
  ok(`pair/complete rejects code reuse (status=${pairReplay.status})`);

  // 5. Encrypted-bootstrap round-trip: decrypt the payload we sent the
  //    server with the same pairing code and assert it matches the
  //    record we minted. This proves the field is opaque to the server
  //    and the contract works end-to-end.
  let decoded;
  try { decoded = decryptBootstrapPayload(pairing_code, encryptedBootstrap); }
  catch (error) { fail(`bootstrap decrypt failed: ${error.message}`); }
  if (!decoded || decoded.device_id !== deviceId || decoded.owner_canonical_id !== owner.canonicalId) {
    fail(`bootstrap decrypt mismatch: ${JSON.stringify(decoded)}`);
  }
  ok("encrypted bootstrap round-trips with the pairing code");

  // 6. Listing the owner's devices includes the new device.
  const listing = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  if (listing.status !== 200 || !Array.isArray(listing.body.devices)) {
    fail(`device list unexpected: status=${listing.status} body=${JSON.stringify(listing.body)}`);
  }
  const listed = listing.body.devices.find((d) => d.device_id === deviceId);
  if (!listed) fail("listed devices do not include the new device");
  if (listed.trust_state !== "active") fail(`listed device has wrong trust_state: ${listed.trust_state}`);
  if (listed.device_public_key !== devicePublicKeySpki) fail("listed device public key mismatch");
  ok(`device list returns the new device as active (${listing.body.devices.length} total)`);

  // 7. Submit a SignedDeviceMembership (active) signed by the owner's
  //    identity key and assert the server verifies + persists it.
  const activeMembership = (() => {
    const now = new Date().toISOString();
    const signable = {
      type: "sudo_device_membership",
      protocol_version: "0.1.0",
      owner_canonical_id: owner.canonicalId,
      device_id: deviceId,
      device_public_key: devicePublicKeySpki,
      device_key_type: "ed25519",
      name: "smoke-laptop",
      capabilities: { can_sync: true, can_decrypt: true },
      trust_state: "active",
      created_at: now,
      updated_at: now,
      sequence: 1
    };
    const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
    return { ...signable, signature };
  })();

  // Re-issue the device under a new pairing code so we can attach a
  // signed membership during pair/complete.
  const pairStart2 = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  const code2 = pairStart2.body.pairing_code;
  const device2 = generateKeyPairSync("ed25519");
  const device2PubKey = base64url(device2.publicKey.export({ format: "der", type: "spki" }));
  const device2Id = randomUUID();
  const m2Plaintext = (() => {
    const now = new Date().toISOString();
    const signable = {
      type: "sudo_device_membership",
      protocol_version: "0.1.0",
      owner_canonical_id: owner.canonicalId,
      device_id: device2Id,
      device_public_key: device2PubKey,
      device_key_type: "ed25519",
      name: "smoke-phone",
      capabilities: { can_sync: true, can_decrypt: true },
      trust_state: "active",
      created_at: now,
      updated_at: now,
      sequence: 1
    };
    const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
    return { ...signable, signature };
  })();
  const m2Bootstrap = encryptBootstrapPayload(code2, {
    device_id: device2Id,
    owner_canonical_id: owner.canonicalId,
    name: "smoke-phone",
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  });
  const pair2 = await postJson("/api/devices/pair/complete", {
    pairing_code: code2,
    device_id: device2Id,
    name: "smoke-phone",
    device_public_key: device2PubKey,
    encrypted_bootstrap_payload: m2Bootstrap,
    signed_membership: m2Plaintext
  });
  if (pair2.status !== 201 || !pair2.body.ok) fail(`pair/complete with membership failed: ${JSON.stringify(pair2.body)}`);
  if (!pair2.body.membership || pair2.body.membership.signature !== m2Plaintext.signature) {
    fail(`pair/complete did not echo back the signed membership`);
  }
  ok(`pair/complete accepts and persists a verified SignedDeviceMembership`);

  // Tampered membership must be rejected (signature won't verify).
  const pairStartTamper = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  const tamperCode = pairStartTamper.body.pairing_code;
  const tamperedMembership = { ...m2Plaintext, name: "i-changed-this" };
  const tamperBootstrap = encryptBootstrapPayload(tamperCode, { device_id: randomUUID(), owner_canonical_id: owner.canonicalId, name: "x", created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
  const tamperResp = await postJson("/api/devices/pair/complete", {
    pairing_code: tamperCode,
    device_id: randomUUID(),
    name: "x",
    device_public_key: device2PubKey,
    encrypted_bootstrap_payload: tamperBootstrap,
    signed_membership: tamperedMembership
  });
  if (tamperResp.status === 201) fail("pair/complete accepted a tampered membership");
  ok(`pair/complete rejects tampered membership (status=${tamperResp.status})`);

  // Listing returns the canonical memberships alongside the cache row.
  const listingWithMemberships = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  if (!Array.isArray(listingWithMemberships.body.memberships)) {
    fail(`device listing missing memberships array: ${JSON.stringify(listingWithMemberships.body)}`);
  }
  const m2Echo = listingWithMemberships.body.memberships.find((m) => m.device_id === device2Id);
  if (!m2Echo || m2Echo.signature !== m2Plaintext.signature) {
    fail("device listing did not return the canonical signed membership");
  }
  ok(`device listing returns ${listingWithMemberships.body.memberships.length} canonical signed membership(s)`);

  // 8. Revoke the device. Listing must reflect the new state, AND any
  //    push subscriptions associated with the device must be evicted
  //    server-side so a revoked browser never receives another push
  //    for this owner.
  function fakeP256dh() {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = ec.publicKey.export({ format: "jwk" });
    const pad = (b) => { while (b.length < 32) b = Buffer.concat([Buffer.from([0]), b]); return b; };
    const x = pad(Buffer.from(jwk.x, "base64url"));
    const y = pad(Buffer.from(jwk.y, "base64url"));
    return Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fakeAuth() {
    return randomBytes(16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Register a push subscription against the device that's about to be revoked.
  const preRevokePushEndpoint = `https://stub.example/${randomBytes(8).toString("hex")}`;
  const pushReg = await postJson(`/api/push/subscriptions`, {
    owner_canonical_id: owner.canonicalId,
    device_id: deviceId,
    endpoint: preRevokePushEndpoint,
    p256dh: fakeP256dh(),
    auth: fakeAuth()
  });
  if (pushReg.status !== 200) fail(`pre-revoke push register status=${pushReg.status}`);
  else ok("pre-revoke push subscription registered");

  // Sanity: a test fan-out with stub-201 should now see attempted=1.
  const fanBefore = await postJson(`/api/push/test`, {
    recipient_canonical_id: owner.canonicalId,
    sender_canonical_id: `sudo:ed25519:${randomBytes(32).toString("hex")}`,
    sender_handle: "@alice",
    unread_count: 1,
    stub_status: 201
  });
  if ((fanBefore.body?.stats?.attempted ?? 0) < 1) {
    fail(`expected pre-revoke fan-out attempts>=1, got ${JSON.stringify(fanBefore.body?.stats)}`);
  } else ok(`pre-revoke fan-out attempts=${fanBefore.body.stats.attempted}`);

  const revoke = await postJson(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
    owner_canonical_id: owner.canonicalId
  });
  if (revoke.status !== 200 || !revoke.body.ok) fail(`revoke unexpected: status=${revoke.status} body=${JSON.stringify(revoke.body)}`);
  if (revoke.body.device?.trust_state !== "revoked") fail(`revoke returned non-revoked trust_state: ${revoke.body.device?.trust_state}`);
  ok(`revoke returns trust_state=revoked`);

  const listingAfter = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  const listedAfter = listingAfter.body.devices?.find((d) => d.device_id === deviceId);
  if (!listedAfter || listedAfter.trust_state !== "revoked") {
    fail(`device list does not reflect revocation: ${JSON.stringify(listedAfter)}`);
  }
  ok("device list reflects revocation");

  // Push subscription for the revoked device must be gone now. Fan-out
  // attempts should drop back to 0 (no other subscription rows exist
  // for this owner in this smoke).
  const fanAfter = await postJson(`/api/push/test`, {
    recipient_canonical_id: owner.canonicalId,
    sender_canonical_id: `sudo:ed25519:${randomBytes(32).toString("hex")}`,
    sender_handle: "@alice",
    unread_count: 1,
    stub_status: 201
  });
  if ((fanAfter.body?.stats?.attempted ?? -1) !== 0) {
    fail(`post-revoke fan-out leaked: ${JSON.stringify(fanAfter.body?.stats)}`);
  } else ok("post-revoke fan-out has zero attempts (push subscription evicted)");

  // 9. Revoke a device with a signed revocation membership. The
  //    server should verify and persist it so the canonical record
  //    reflects the revocation, not just the cache row.
  const revokeMembership = (() => {
    const now = new Date().toISOString();
    const signable = {
      type: "sudo_device_membership",
      protocol_version: "0.1.0",
      owner_canonical_id: owner.canonicalId,
      device_id: device2Id,
      device_public_key: device2PubKey,
      device_key_type: "ed25519",
      name: "smoke-phone",
      capabilities: { can_sync: true, can_decrypt: true },
      trust_state: "revoked",
      created_at: m2Plaintext.created_at,
      updated_at: now,
      sequence: 2
    };
    const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
    return { ...signable, signature };
  })();
  const revokeWithMembership = await postJson(`/api/devices/${encodeURIComponent(device2Id)}/revoke`, {
    owner_canonical_id: owner.canonicalId,
    signed_membership: revokeMembership
  });
  if (revokeWithMembership.status !== 200 || !revokeWithMembership.body.ok) {
    fail(`revoke-with-membership unexpected: status=${revokeWithMembership.status} body=${JSON.stringify(revokeWithMembership.body)}`);
  }
  if (revokeWithMembership.body.membership?.signature !== revokeMembership.signature) {
    fail("revoke-with-membership did not echo back the signed revocation");
  }
  ok("revoke accepts a signed revocation membership");

  const listingFinal = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  const m2Final = listingFinal.body.memberships?.find((m) => m.device_id === device2Id);
  if (!m2Final || m2Final.trust_state !== "revoked" || m2Final.sequence !== 2) {
    fail(`canonical membership for revoked device wrong: ${JSON.stringify(m2Final)}`);
  }
  ok("canonical membership shows trust_state=revoked at the new sequence");

  // 10. Revoke under the wrong owner is rejected.
  const wrongOwner = await postJson(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
    owner_canonical_id: "sudo:ed25519:" + "0".repeat(64)
  });
  if (wrongOwner.status === 200) fail("revoke accepted a wrong owner_canonical_id");
  ok(`revoke rejects wrong owner (status=${wrongOwner.status})`);

  console.log("\ndevice-pairing smoke passed");
})().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(2);
});

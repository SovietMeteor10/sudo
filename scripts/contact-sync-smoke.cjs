#!/usr/bin/env node
// Contact-slice sync smoke. Drives the encrypted trusted-device sync
// API end-to-end against a running node, simulating two devices A and
// B for the same owner identity. Asserts the spec's behavioural
// guarantees:
//
//   1. A signs up (registers identity + self-signs a SignedDeviceMembership)
//   2. B pairs (gets a SignedDeviceMembership of its own)
//   3. A adds contact C → B receives the encrypted contact event
//   4. A deletes contact C → B receives the deletion
//   5. A revokes B → server stops delivering events to B
//   6. A adds contact D after revocation → B does NOT receive D
//   7. Re-posting the same event_id is idempotent (no duplicate row)
//   8. The server never sees the contact's plaintext canonical_id in
//      any stored row — every payload is opaque ciphertext
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/contact-sync-smoke.cjs

const {
  generateKeyPairSync,
  createHash,
  sign,
  randomUUID,
  randomBytes,
  hkdfSync,
  createCipheriv,
  createDecipheriv
} = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PROTOCOL_VERSION = "0.1.0";
const SYNC_DOMAIN = "sudo-sync-aes-gcm-v1";

function fail(msg) { console.error("FAIL:", msg); process.exit(1); }
function ok(msg) { console.log("ok:", msg); }
function base64url(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
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
function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }
function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }

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
    protocol_version: PROTOCOL_VERSION,
    canonical_id: `sudo:ed25519:${sha256Hex(identityPublicKeySpki)}`,
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
    canonicalId: baseDocument.canonical_id
  };
}

function buildSignedMembership(opts) {
  const signable = {
    type: "sudo_device_membership",
    protocol_version: PROTOCOL_VERSION,
    owner_canonical_id: opts.ownerCanonicalId,
    device_id: opts.deviceId,
    device_public_key: opts.devicePublicKeySpki,
    device_key_type: "ed25519",
    name: opts.name,
    capabilities: { can_sync: true, can_decrypt: true },
    trust_state: opts.trustState,
    created_at: opts.createdAt,
    updated_at: opts.updatedAt,
    sequence: opts.sequence
  };
  const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), opts.ownerIdentityPrivateKey));
  return { ...signable, signature };
}

function buildSignedSyncEvent(opts) {
  const signable = {
    type: "sudo_sync_event",
    protocol_version: PROTOCOL_VERSION,
    event_id: opts.eventId ?? randomUUID(),
    owner_canonical_id: opts.ownerCanonicalId,
    origin_device_id: opts.originDeviceId,
    slice: "contact",
    kind: opts.kind,
    sequence: opts.sequence,
    created_at: opts.createdAt ?? new Date().toISOString(),
    encrypted_payload: opts.encryptedPayload
  };
  const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), opts.originDevicePrivateKey));
  return { ...signable, signature };
}

function deriveSyncSymKey(accountSyncPrivateKeyPkcs8Bytes) {
  return Buffer.from(hkdfSync(
    "sha256",
    accountSyncPrivateKeyPkcs8Bytes,
    Buffer.alloc(0),
    Buffer.from(SYNC_DOMAIN, "utf8"),
    32
  ));
}

function encryptSyncPayload(plaintext, symKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", symKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: base64url(iv),
    ciphertext: base64url(Buffer.concat([ct, tag]))
  });
}

function decryptSyncPayload(envelopeJson, symKey) {
  const env = JSON.parse(envelopeJson);
  const iv = base64urlToBuffer(env.iv);
  const blob = base64urlToBuffer(env.ciphertext);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", symKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
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

// Phase 14 HIGH-6: /sync GET and /sync/ack POST now require a
// device signature. Use the shared smoke helper.
const { getJsonSignedDevice, postJsonSignedDevice } = require("./lib/request-auth-helpers.cjs");
async function syncGet(path, signer) { return getJsonSignedDevice(BASE_URL, path, signer); }
async function syncPost(path, body, signer) { return postJsonSignedDevice(BASE_URL, path, body, signer); }

(async () => {
  const health = await getJson("/health").catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`contact-sync smoke needs a running node at ${BASE_URL} (got ${health.status})`);
    process.exit(2);
  }

  // ------------------------------------------------------------------
  // 1. A signs up: register identity + self-sign a device membership
  // ------------------------------------------------------------------
  const ownerHandle = "csync" + Date.now().toString().slice(-7);
  const owner = buildOwnerIdentity(ownerHandle);
  const idResp = await postJson("/api/identity/register", { identity_document: owner.document });
  if (idResp.status !== 201) fail(`identity register failed: ${idResp.status} ${JSON.stringify(idResp.body)}`);
  ok(`A registered identity ${owner.canonicalId}`);

  // A's device key (the device key A signs sync events with).
  const deviceA = generateKeyPairSync("ed25519");
  const deviceAId = randomUUID();
  const deviceAPubKey = base64url(deviceA.publicKey.export({ format: "der", type: "spki" }));
  const nowA = new Date().toISOString();
  const membershipA = buildSignedMembership({
    ownerCanonicalId: owner.canonicalId,
    ownerIdentityPrivateKey: owner.identityPrivateKey,
    deviceId: deviceAId,
    devicePublicKeySpki: deviceAPubKey,
    name: "device-a",
    trustState: "active",
    createdAt: nowA,
    updatedAt: nowA,
    sequence: 1
  });
  const aReg = await postJson("/api/devices/register", {
    type: "sudo_trusted_device",
    device_id: deviceAId,
    owner_canonical_id: owner.canonicalId,
    name: "device-a",
    device_public_key: deviceAPubKey,
    capabilities: { can_sync: true, can_decrypt: true },
    signed_membership: membershipA
  });
  if (aReg.status !== 201 || !aReg.body.ok) fail(`A device register failed: ${JSON.stringify(aReg.body)}`);
  if (!aReg.body.membership || aReg.body.membership.signature !== membershipA.signature) {
    fail("A device register did not echo back the signed membership");
  }
  ok(`A registered device ${deviceAId.slice(0, 8)} with self-signed membership`);

  // ------------------------------------------------------------------
  // 2. B pairs in: pair/start, then pair/complete with B's membership.
  //    The account_sync key is shared via the encrypted bootstrap; in
  //    a real flow this would be the bootstrap payload — here we share
  //    by parameter since both devices are simulated in this process.
  // ------------------------------------------------------------------
  const accountSyncKey = generateKeyPairSync("ed25519");
  const accountSyncPkcs8Bytes = accountSyncKey.privateKey.export({ format: "der", type: "pkcs8" });
  const symKey = deriveSyncSymKey(accountSyncPkcs8Bytes);
  ok(`account_sync_key generated; AES-GCM key derived (${symKey.length} bytes)`);

  const pairStart = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  if (pairStart.status !== 201) fail(`pair/start failed: ${pairStart.status}`);
  const pairingCode = pairStart.body.pairing_code;

  const deviceB = generateKeyPairSync("ed25519");
  const deviceBId = randomUUID();
  const deviceBPubKey = base64url(deviceB.publicKey.export({ format: "der", type: "spki" }));
  const nowB = new Date().toISOString();
  const membershipB = buildSignedMembership({
    ownerCanonicalId: owner.canonicalId,
    ownerIdentityPrivateKey: owner.identityPrivateKey,
    deviceId: deviceBId,
    devicePublicKeySpki: deviceBPubKey,
    name: "device-b",
    trustState: "active",
    createdAt: nowB,
    updatedAt: nowB,
    sequence: 1
  });
  // Bootstrap (opaque to server) — in production it would carry the
  // account_sync key bytes encrypted under the pairing code so B
  // adopts the same symKey.
  const bootstrap = encryptSyncPayload(JSON.stringify({
    device_id: deviceBId,
    owner_canonical_id: owner.canonicalId,
    name: "device-b",
    account_sync_pkcs8_b64u: base64url(accountSyncPkcs8Bytes)
  }), Buffer.alloc(32, 0)); // contents are opaque; we don't decode it server-side
  const pairComplete = await postJson("/api/devices/pair/complete", {
    pairing_code: pairingCode,
    device_id: deviceBId,
    name: "device-b",
    device_public_key: deviceBPubKey,
    encrypted_bootstrap_payload: bootstrap,
    signed_membership: membershipB
  });
  if (pairComplete.status !== 201) fail(`pair/complete failed: ${JSON.stringify(pairComplete.body)}`);
  if (pairComplete.body.membership.signature !== membershipB.signature) fail("pair/complete did not store B's membership");
  ok(`B paired as ${deviceBId.slice(0, 8)} with verified membership`);

  // ------------------------------------------------------------------
  // 3. A adds contact C and posts an encrypted sync event.
  // ------------------------------------------------------------------
  const contactC = {
    canonical_id: "sudo:ed25519:" + "c".repeat(64),
    handle: "@charlie",
    tier: "known",
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const upsertEvent = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "contact.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify(contactC), symKey)
  });
  const upsertPost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertEvent
  });
  if (upsertPost.status !== 201 || !upsertPost.body.ok) fail(`A upsert post failed: ${JSON.stringify(upsertPost.body)}`);
  ok(`A posted encrypted contact.upsert (server_seq=${upsertPost.body.server_seq})`);

  // ------------------------------------------------------------------
  // 4. B polls the sync stream, receives, verifies, and decrypts.
  // ------------------------------------------------------------------
  const pollAfterUpsert = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (pollAfterUpsert.status !== 200) fail(`B poll failed: ${pollAfterUpsert.status}`);
  if (pollAfterUpsert.body.events.length !== 1) fail(`B poll expected 1 event, got ${pollAfterUpsert.body.events.length}`);
  const upsertEntry = pollAfterUpsert.body.events[0];
  if (upsertEntry.signed_event.event_id !== upsertEvent.event_id) fail("B poll returned wrong event_id");
  // Verify A's signature against A's device public key from the listing.
  const listing = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  const aMembership = listing.body.memberships.find((m) => m.device_id === deviceAId);
  if (aMembership === undefined) fail("A's canonical membership not visible in listing");
  const { createPublicKey, verify } = require("node:crypto");
  const aPubKeyObj = createPublicKey({ key: base64urlToBuffer(aMembership.device_public_key), format: "der", type: "spki" });
  const { signature: aSig, ...aSignable } = upsertEntry.signed_event;
  const sigOk = verify(null, Buffer.from(canonicalJson(aSignable)), aPubKeyObj, base64urlToBuffer(aSig));
  if (!sigOk) fail("B failed to verify A's sync event signature");
  const decoded = JSON.parse(decryptSyncPayload(upsertEntry.signed_event.encrypted_payload, symKey));
  if (decoded.canonical_id !== contactC.canonical_id || decoded.handle !== contactC.handle) {
    fail(`B decrypt mismatch: ${JSON.stringify(decoded)}`);
  }
  ok(`B received contact.upsert; verified signature; decrypted handle=${decoded.handle}`);

  // ACK so the server cursor advances.
  const ackResp = await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: upsertEntry.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (ackResp.status !== 200 || !ackResp.body.ok) fail(`B ack failed: ${JSON.stringify(ackResp.body)}`);
  ok(`B acked cursor at server_seq=${ackResp.body.last_server_seq}`);

  // ------------------------------------------------------------------
  // 5. Idempotency: re-post the same upsert event_id; server returns
  //    200 with created=false and does NOT increment the log.
  // ------------------------------------------------------------------
  const replayUpsert = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertEvent
  });
  if (replayUpsert.status !== 200 || replayUpsert.body.created !== false) {
    fail(`replay upsert was not idempotent: status=${replayUpsert.status} body=${JSON.stringify(replayUpsert.body)}`);
  }
  ok(`replay of same event_id is idempotent (server_seq=${replayUpsert.body.server_seq})`);

  // Sequence regression: a brand new event_id with a sequence already
  // used is rejected.
  const regressionAttempt = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "contact.upsert",
    sequence: 1, // already used by upsertEvent
    encryptedPayload: encryptSyncPayload(JSON.stringify({ canonical_id: "x", handle: "x", tier: "known", added_at: nowA, updated_at: nowA }), symKey)
  });
  const regressionPost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: regressionAttempt
  });
  if (regressionPost.status !== 409 || regressionPost.body.error !== "sequence_regression") {
    fail(`sequence regression not rejected: status=${regressionPost.status} body=${JSON.stringify(regressionPost.body)}`);
  }
  ok(`server rejects sequence regression (status=409 sequence_regression)`);

  // ------------------------------------------------------------------
  // 6. A deletes contact C → B receives the deletion.
  // ------------------------------------------------------------------
  const deleteEvent = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "contact.delete",
    sequence: 2,
    encryptedPayload: encryptSyncPayload(JSON.stringify({ canonical_id: contactC.canonical_id }), symKey)
  });
  const deletePost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: deleteEvent
  });
  if (deletePost.status !== 201) fail(`A delete post failed: ${JSON.stringify(deletePost.body)}`);
  const pollAfterDelete = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=${ackResp.body.last_server_seq}`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  const deleteEntry = pollAfterDelete.body.events.find((e) => e.signed_event.event_id === deleteEvent.event_id);
  if (deleteEntry === undefined) fail(`B did not receive delete event`);
  const decodedDel = JSON.parse(decryptSyncPayload(deleteEntry.signed_event.encrypted_payload, symKey));
  if (decodedDel.canonical_id !== contactC.canonical_id) fail(`B decoded delete payload mismatch: ${JSON.stringify(decodedDel)}`);
  ok(`B received contact.delete for ${contactC.handle}`);

  // ACK B through the delete.
  const ackResp2 = await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: deleteEntry.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (!ackResp2.body.ok) fail("B ack #2 failed");

  // ------------------------------------------------------------------
  // 7. A revokes B (signed revocation membership at sequence=2).
  // ------------------------------------------------------------------
  const revokeMembership = buildSignedMembership({
    ownerCanonicalId: owner.canonicalId,
    ownerIdentityPrivateKey: owner.identityPrivateKey,
    deviceId: deviceBId,
    devicePublicKeySpki: deviceBPubKey,
    name: "device-b",
    trustState: "revoked",
    createdAt: nowB,
    updatedAt: new Date().toISOString(),
    sequence: 2
  });
  const revoke = await postJson(`/api/devices/${encodeURIComponent(deviceBId)}/revoke`, {
    owner_canonical_id: owner.canonicalId,
    signed_membership: revokeMembership
  });
  if (revoke.status !== 200) fail(`revoke failed: ${JSON.stringify(revoke.body)}`);
  ok(`A revoked B with signed revocation membership`);

  // ------------------------------------------------------------------
  // 8. A adds contact D after revocation. The post itself succeeds (A
  //    is still active). B's poll must be refused with 403.
  // ------------------------------------------------------------------
  const contactD = {
    canonical_id: "sudo:ed25519:" + "d".repeat(64),
    handle: "@delta",
    tier: "known",
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const upsertD = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "contact.upsert",
    sequence: 3,
    encryptedPayload: encryptSyncPayload(JSON.stringify(contactD), symKey)
  });
  const postD = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertD
  });
  if (postD.status !== 201) fail(`A post-D failed: ${JSON.stringify(postD.body)}`);
  ok(`A posted contact D after revoking B (server_seq=${postD.body.server_seq})`);

  // Phase 14 HIGH-6: the sig middleware now rejects revoked-device
  // sigs with 401 device_revoked before the route-level
  // recipient_not_authorized check fires. Either gate is correct.
  const revokedPoll = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (revokedPoll.status !== 401 && revokedPoll.status !== 403) {
    fail(`revoked B was not refused: status=${revokedPoll.status} body=${JSON.stringify(revokedPoll.body)}`);
  }
  ok(`server refuses revoked B's poll (${revokedPoll.status} ${revokedPoll.body?.error})`);

  const revokedAck = await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: postD.body.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (revokedAck.status !== 401 && revokedAck.status !== 403) fail(`revoked B's ack was not refused: ${revokedAck.status}`);
  ok(`server refuses revoked B's ack (${revokedAck.status} ${revokedAck.body?.error})`);

  // A new attempt with B's old credentials directly posting an event
  // (B-as-origin) is rejected because B is no longer an active origin.
  const bAsOrigin = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceBId,
    originDevicePrivateKey: deviceB.privateKey,
    kind: "contact.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify({ canonical_id: "x", handle: "x", tier: "known", added_at: nowB, updated_at: nowB }), symKey)
  });
  const bOriginPost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: bAsOrigin });
  if (bOriginPost.status !== 403) fail(`revoked B-as-origin was not refused: ${bOriginPost.status}`);
  ok(`server refuses revoked B's outbound posts (403 origin_not_authorized)`);

  // ------------------------------------------------------------------
  // 9. The server's stored event rows must NOT contain the contact
  //    plaintext anywhere observable through the public listing API.
  // ------------------------------------------------------------------
  // Re-list events as a still-active recipient (device A) and assert
  // that the contact's plaintext canonical_id is not present in any
  // event payload field readable by the server.
  const finalPoll = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceAId)}&since=0&limit=100`, { canonicalId: owner.canonicalId, deviceId: deviceAId, privateKey: deviceA.privateKey });
  if (finalPoll.status !== 200) fail(`A poll failed: ${finalPoll.status}`);
  const blob = JSON.stringify(finalPoll.body);
  if (blob.includes(contactC.handle) || blob.includes(contactD.handle) || blob.includes(contactC.canonical_id) || blob.includes(contactD.canonical_id)) {
    fail("server-side stored sync rows expose plaintext contact data");
  }
  ok(`server-stored sync rows expose only ciphertext (no plaintext canonical_id or handle)`);

  console.log("\ncontact-sync smoke passed");
})().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(2);
});

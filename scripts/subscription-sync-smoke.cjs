#!/usr/bin/env node
// Subscription-slice sync smoke. Mirrors contact-sync end-to-end and
// asserts the subscription slice rides the same encrypted relay:
//
//   1. A signs up + self-signs a SignedDeviceMembership.
//   2. B pairs with its own SignedDeviceMembership (signed by A's
//      identity key).
//   3. A subscribes to author C → B receives the encrypted upsert.
//   4. A updates C's visibility flags → B receives the new payload.
//   5. A unsubscribes from C → B receives the delete.
//   6. A revokes B; B's poll/ack are refused with 403, B-as-origin
//      posts are also refused.
//   7. A subscribes to D after revocation; A's post is fine, B never
//      sees it.
//   8. Replay of the same event_id is idempotent; sequence regression
//      is rejected.
//   9. The server's stored sync rows expose only ciphertext — the
//      plaintext author canonical_id appears nowhere.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/subscription-sync-smoke.cjs

const {
  generateKeyPairSync,
  createHash,
  sign,
  randomUUID,
  randomBytes,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  verify
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
    slice: opts.slice ?? "subscription",
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

// Phase 14 HIGH-6: /sync GET and /sync/ack POST now require a device signature.
const { getJsonSignedDevice, postJsonSignedDevice } = require("./lib/request-auth-helpers.cjs");
async function syncGet(path, signer) { return getJsonSignedDevice(BASE_URL, path, signer); }
async function syncPost(path, body, signer) { return postJsonSignedDevice(BASE_URL, path, body, signer); }

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

(async () => {
  const health = await getJson("/health").catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`subscription-sync smoke needs a running node at ${BASE_URL} (got ${health.status})`);
    process.exit(2);
  }

  // Owner + A device + self-signed membership.
  const ownerHandle = "subsync" + Date.now().toString().slice(-7);
  const owner = buildOwnerIdentity(ownerHandle);
  const idResp = await postJson("/api/identity/register", { identity_document: owner.document });
  if (idResp.status !== 201) fail(`identity register failed: ${idResp.status}`);
  ok(`A registered identity ${owner.canonicalId}`);

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
  if (aReg.status !== 201) fail(`A device register failed: ${JSON.stringify(aReg.body)}`);
  ok(`A registered device with self-signed membership`);

  // B pairs with its own active membership.
  const accountSyncKey = generateKeyPairSync("ed25519");
  const accountSyncPkcs8Bytes = accountSyncKey.privateKey.export({ format: "der", type: "pkcs8" });
  const symKey = deriveSyncSymKey(accountSyncPkcs8Bytes);

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
  // account sync key encrypted under the pairing code.
  const bootstrap = encryptSyncPayload(JSON.stringify({
    device_id: deviceBId,
    owner_canonical_id: owner.canonicalId,
    name: "device-b",
    account_sync_pkcs8_b64u: base64url(accountSyncPkcs8Bytes)
  }), Buffer.alloc(32, 0));
  const pairComplete = await postJson("/api/devices/pair/complete", {
    pairing_code: pairingCode,
    device_id: deviceBId,
    name: "device-b",
    device_public_key: deviceBPubKey,
    encrypted_bootstrap_payload: bootstrap,
    signed_membership: membershipB
  });
  if (pairComplete.status !== 201) fail(`pair/complete failed: ${JSON.stringify(pairComplete.body)}`);
  ok(`B paired with active membership`);

  // ----------------------------------------------------------------
  // 3. A subscribes to author C → B receives the encrypted upsert.
  // ----------------------------------------------------------------
  const authorC = "sudo:ed25519:" + "c".repeat(64);
  const upsertC = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "subscription.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify({
      author_canonical_id: authorC,
      include_public: true,
      include_connections: true,
      include_close: false,
      updated_at: nowA
    }), symKey)
  });
  const postC = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: upsertC });
  if (postC.status !== 201 || !postC.body.ok) fail(`A subscription.upsert post failed: ${JSON.stringify(postC.body)}`);
  ok(`A posted subscription.upsert for C (server_seq=${postC.body.server_seq})`);

  const pollOne = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (pollOne.status !== 200) fail(`B poll failed: ${pollOne.status}`);
  const cEntry = pollOne.body.events.find((e) => e.signed_event.event_id === upsertC.event_id);
  if (cEntry === undefined) fail(`B did not receive the C upsert`);
  // Verify A's signature against the canonical membership listing.
  const listing = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  const aMembership = listing.body.memberships.find((m) => m.device_id === deviceAId);
  const aPubKeyObj = createPublicKey({ key: base64urlToBuffer(aMembership.device_public_key), format: "der", type: "spki" });
  const { signature: cSig, ...cSignable } = cEntry.signed_event;
  if (!verify(null, Buffer.from(canonicalJson(cSignable)), aPubKeyObj, base64urlToBuffer(cSig))) {
    fail("B failed to verify A's subscription.upsert signature");
  }
  const cPayload = JSON.parse(decryptSyncPayload(cEntry.signed_event.encrypted_payload, symKey));
  if (cPayload.author_canonical_id !== authorC || cPayload.include_public !== true) {
    fail(`B decoded subscription.upsert mismatch: ${JSON.stringify(cPayload)}`);
  }
  ok(`B received subscription.upsert; verified signature and decrypted author_canonical_id`);

  // Idempotency: replaying the same event_id is a no-op.
  const replay = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: upsertC });
  if (replay.status !== 200 || replay.body.created !== false) {
    fail(`replay was not idempotent: status=${replay.status} body=${JSON.stringify(replay.body)}`);
  }
  ok(`replay of same event_id is idempotent`);

  // Sequence regression: a brand new event_id reusing sequence=1 is rejected.
  const regression = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "subscription.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload("{}", symKey)
  });
  const regressionResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: regression });
  if (regressionResp.status !== 409 || regressionResp.body.error !== "sequence_regression") {
    fail(`sequence regression not rejected: ${regressionResp.status} ${JSON.stringify(regressionResp.body)}`);
  }
  ok(`server rejects sequence regression on the subscription slice`);

  // ACK B through this event so we can resume from there.
  await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: cEntry.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });

  // ----------------------------------------------------------------
  // 4. A updates C's visibility flags (subscription.upsert with new
  //    include_close=true, include_public=false).
  // ----------------------------------------------------------------
  const updateAt = new Date().toISOString();
  const updateC = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "subscription.upsert",
    sequence: 2,
    encryptedPayload: encryptSyncPayload(JSON.stringify({
      author_canonical_id: authorC,
      include_public: false,
      include_connections: true,
      include_close: true,
      updated_at: updateAt
    }), symKey)
  });
  const updateResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: updateC });
  if (updateResp.status !== 201) fail(`A update failed: ${JSON.stringify(updateResp.body)}`);
  const pollUpdate = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=${cEntry.server_seq}`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  const updateEntry = pollUpdate.body.events.find((e) => e.signed_event.event_id === updateC.event_id);
  if (updateEntry === undefined) fail(`B did not receive the updated subscription`);
  const updatedPayload = JSON.parse(decryptSyncPayload(updateEntry.signed_event.encrypted_payload, symKey));
  if (updatedPayload.include_public !== false || updatedPayload.include_close !== true) {
    fail(`B decoded update payload missing flags: ${JSON.stringify(updatedPayload)}`);
  }
  ok(`B received updated subscription (include_public=false, include_close=true)`);
  await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: updateEntry.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });

  // ----------------------------------------------------------------
  // 5. A unsubscribes from C → B receives subscription.delete.
  // ----------------------------------------------------------------
  const deleteC = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "subscription.delete",
    sequence: 3,
    encryptedPayload: encryptSyncPayload(JSON.stringify({ author_canonical_id: authorC }), symKey)
  });
  const deleteResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: deleteC });
  if (deleteResp.status !== 201) fail(`A delete failed: ${JSON.stringify(deleteResp.body)}`);
  const pollDelete = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=${updateEntry.server_seq}`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  const deleteEntry = pollDelete.body.events.find((e) => e.signed_event.event_id === deleteC.event_id);
  if (deleteEntry === undefined) fail(`B did not receive subscription.delete`);
  const deletePayload = JSON.parse(decryptSyncPayload(deleteEntry.signed_event.encrypted_payload, symKey));
  if (deletePayload.author_canonical_id !== authorC) {
    fail(`B decoded delete payload mismatch: ${JSON.stringify(deletePayload)}`);
  }
  ok(`B received subscription.delete for C`);
  await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: deleteEntry.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });

  // ----------------------------------------------------------------
  // 6. A revokes B with a signed revocation membership at seq 2.
  // ----------------------------------------------------------------
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
  ok(`A revoked B`);

  // 7. A subscribes to D after revocation; A's POST is fine, B is gated.
  const authorD = "sudo:ed25519:" + "d".repeat(64);
  const upsertD = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "subscription.upsert",
    sequence: 4,
    encryptedPayload: encryptSyncPayload(JSON.stringify({
      author_canonical_id: authorD,
      include_public: true,
      include_connections: true,
      include_close: false,
      updated_at: new Date().toISOString()
    }), symKey)
  });
  const postD = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: upsertD });
  if (postD.status !== 201) fail(`A post-D failed: ${JSON.stringify(postD.body)}`);
  ok(`A posted subscription.upsert for D after revoking B (server_seq=${postD.body.server_seq})`);

  // Phase 14 HIGH-6: revoked-device sig fails at 401 device_revoked
  // before the route-level recipient_not_authorized check fires.
  const revokedPoll = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (revokedPoll.status !== 401 && revokedPoll.status !== 403) {
    fail(`revoked B was not refused: ${revokedPoll.status} ${JSON.stringify(revokedPoll.body)}`);
  }
  ok(`server refuses revoked B's poll (${revokedPoll.status} ${revokedPoll.body?.error})`);

  const revokedAck = await syncPost(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: postD.body.server_seq
  }, { canonicalId: owner.canonicalId, deviceId: deviceBId, privateKey: deviceB.privateKey });
  if (revokedAck.status !== 401 && revokedAck.status !== 403) fail(`revoked B's ack was not refused: ${revokedAck.status}`);
  ok(`server refuses revoked B's ack (${revokedAck.status} ${revokedAck.body?.error})`);

  const bAsOrigin = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceBId,
    originDevicePrivateKey: deviceB.privateKey,
    kind: "subscription.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify({
      author_canonical_id: authorC, include_public: true, include_connections: true, include_close: false, updated_at: nowB
    }), symKey)
  });
  const bOriginPost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: bAsOrigin });
  if (bOriginPost.status !== 403) fail(`revoked B-as-origin was not refused: ${bOriginPost.status}`);
  ok(`server refuses revoked B's outbound posts (403 origin_not_authorized)`);

  // ----------------------------------------------------------------
  // 9. Plaintext author IDs must NOT appear in any server-stored
  //    sync row visible through the listing (still-active device A
  //    pulls everything for an audit).
  // ----------------------------------------------------------------
  const finalPoll = await syncGet(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceAId)}&since=0&limit=200`, { canonicalId: owner.canonicalId, deviceId: deviceAId, privateKey: deviceA.privateKey });
  if (finalPoll.status !== 200) fail(`A audit poll failed: ${finalPoll.status}`);
  const blob = JSON.stringify(finalPoll.body);
  if (blob.includes(authorC) || blob.includes(authorD)) {
    fail("server-stored sync rows expose plaintext author canonical_ids");
  }
  ok(`server-stored sync rows expose only ciphertext (no plaintext author canonical_id)`);

  // Sanity: a subscription.upsert with kind=contact.delete (mismatched
  // slice/kind) is rejected at the edge.
  const mismatched = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    slice: "subscription",
    kind: "contact.upsert",
    sequence: 5,
    encryptedPayload: encryptSyncPayload("{}", symKey)
  });
  const mismatchedResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: mismatched });
  if (mismatchedResp.status !== 400) fail(`mismatched slice/kind not rejected: ${mismatchedResp.status}`);
  ok(`server rejects slice/kind mismatch at the edge (400)`);

  console.log("\nsubscription-sync smoke passed");
})().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(2);
});

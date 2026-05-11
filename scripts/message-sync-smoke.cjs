#!/usr/bin/env node
// Message-history slice sync smoke. Mirrors contact/subscription smokes
// and asserts the message slice rides the same encrypted relay:
//
//   1. A signs up + self-signs a SignedDeviceMembership.
//   2. B pairs with its own SignedDeviceMembership.
//   3. A posts a sent-direction message.upsert; B receives, verifies,
//      decrypts, sees the same message_id/body/peer fields.
//   4. A posts a received-direction message.upsert (envelope landed
//      on A and was saved locally); B receives the same row.
//   5. A posts an UPDATE for the same message_id at a later
//      updated_at. B sees the update.
//   6. Replay of the same event_id is idempotent. Sequence regression
//      is rejected.
//   7. A revokes B; B's poll/ack are refused with 403 and B-as-origin
//      posts are also refused.
//   8. Server-stored sync rows expose only ciphertext — the plaintext
//      message body, peer canonical_ids, and conversation_id appear
//      nowhere readable through the public listing.
//   9. Slice/kind mismatches (e.g. "message" + "contact.delete") are
//      rejected at the edge.

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
    slice: opts.slice ?? "message",
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

(async () => {
  const health = await getJson("/health").catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`message-sync smoke needs a running node at ${BASE_URL} (got ${health.status})`);
    process.exit(2);
  }

  // Owner + A device + self-signed membership.
  const ownerHandle = "msync" + Date.now().toString().slice(-7);
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
  // 3. A's local conversation: A had a chat with peer P. A's device
  //    holds two messages locally — one A sent, one A received from
  //    P. Both get synced to B.
  // ----------------------------------------------------------------
  const peerCanonicalId = "sudo:ed25519:" + "f".repeat(64);
  const conversationId = [owner.canonicalId, peerCanonicalId].sort().join("|");
  const sentMessageId = randomUUID();
  const sentBody = "hello from A — secret_payload_42";
  const sentCreatedAt = new Date().toISOString();
  const sentPayload = {
    message_id: sentMessageId,
    owner_canonical_id: owner.canonicalId,
    conversation_id: conversationId,
    direction: "sent",
    sender_canonical_id: owner.canonicalId,
    recipient_canonical_id: peerCanonicalId,
    sender_handle: `@${ownerHandle}`,
    recipient_handle: "@peer",
    body: sentBody,
    ciphertext: "dev-placeholder:" + Buffer.from(sentBody, "utf8").toString("base64"),
    created_at: sentCreatedAt,
    updated_at: sentCreatedAt,
    status: "stored_by_relay",
    relay_message_id: sentMessageId
  };
  const upsertSent = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "message.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify(sentPayload), symKey)
  });
  const sentResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertSent
  });
  if (sentResp.status !== 201 || !sentResp.body.ok) fail(`A sent-message upsert failed: ${JSON.stringify(sentResp.body)}`);
  ok(`A posted message.upsert (sent direction, server_seq=${sentResp.body.server_seq})`);

  const receivedMessageId = randomUUID();
  const receivedBody = "hi A from peer — peer_secret_77";
  const receivedCreatedAt = new Date().toISOString();
  const receivedPayload = {
    message_id: receivedMessageId,
    owner_canonical_id: owner.canonicalId,
    conversation_id: conversationId,
    direction: "received",
    sender_canonical_id: peerCanonicalId,
    recipient_canonical_id: owner.canonicalId,
    sender_handle: "@peer",
    recipient_handle: `@${ownerHandle}`,
    body: receivedBody,
    ciphertext: "dev-placeholder:" + Buffer.from(receivedBody, "utf8").toString("base64"),
    created_at: receivedCreatedAt,
    updated_at: receivedCreatedAt,
    status: "delivered_to_recipient_device",
    relay_message_id: receivedMessageId
  };
  const upsertReceived = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "message.upsert",
    sequence: 2,
    encryptedPayload: encryptSyncPayload(JSON.stringify(receivedPayload), symKey)
  });
  const recvResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertReceived
  });
  if (recvResp.status !== 201) fail(`A received-message upsert failed: ${JSON.stringify(recvResp.body)}`);
  ok(`A posted message.upsert (received direction, server_seq=${recvResp.body.server_seq})`);

  // ----------------------------------------------------------------
  // 4. B polls, verifies, decrypts both messages.
  // ----------------------------------------------------------------
  const pollOne = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`);
  if (pollOne.status !== 200) fail(`B poll failed: ${pollOne.status}`);
  const sentEntry = pollOne.body.events.find((e) => e.signed_event.event_id === upsertSent.event_id);
  const recvEntry = pollOne.body.events.find((e) => e.signed_event.event_id === upsertReceived.event_id);
  if (sentEntry === undefined || recvEntry === undefined) {
    fail(`B did not receive both messages; got ${pollOne.body.events.length} events`);
  }

  const listing = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  const aMembership = listing.body.memberships.find((m) => m.device_id === deviceAId);
  const aPubKeyObj = createPublicKey({ key: base64urlToBuffer(aMembership.device_public_key), format: "der", type: "spki" });
  const verifyEntry = (entry, label) => {
    const { signature, ...signable } = entry.signed_event;
    if (!verify(null, Buffer.from(canonicalJson(signable)), aPubKeyObj, base64urlToBuffer(signature))) {
      fail(`B failed to verify ${label} signature`);
    }
  };
  verifyEntry(sentEntry, "sent");
  verifyEntry(recvEntry, "received");

  const sentDecoded = JSON.parse(decryptSyncPayload(sentEntry.signed_event.encrypted_payload, symKey));
  const recvDecoded = JSON.parse(decryptSyncPayload(recvEntry.signed_event.encrypted_payload, symKey));
  if (sentDecoded.message_id !== sentMessageId || sentDecoded.body !== sentBody || sentDecoded.direction !== "sent") {
    fail(`B decoded sent payload mismatch: ${JSON.stringify(sentDecoded)}`);
  }
  if (recvDecoded.message_id !== receivedMessageId || recvDecoded.body !== receivedBody || recvDecoded.direction !== "received") {
    fail(`B decoded received payload mismatch: ${JSON.stringify(recvDecoded)}`);
  }
  ok(`B verified and decrypted both messages (sent + received)`);

  // ----------------------------------------------------------------
  // 5. ACK B through both, then post an UPDATE for the sent message
  //    (status=stored_by_relay → acked, with newer updated_at).
  // ----------------------------------------------------------------
  await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: Math.max(sentEntry.server_seq, recvEntry.server_seq)
  });

  const updateAt = new Date(Date.parse(sentCreatedAt) + 60_000).toISOString();
  const updatedPayload = { ...sentPayload, status: "acked", updated_at: updateAt };
  const upsertUpdate = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "message.upsert",
    sequence: 3,
    encryptedPayload: encryptSyncPayload(JSON.stringify(updatedPayload), symKey)
  });
  const updateResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertUpdate
  });
  if (updateResp.status !== 201) fail(`A update failed: ${JSON.stringify(updateResp.body)}`);
  const pollUpdate = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=${recvEntry.server_seq}`);
  const updateEntry = pollUpdate.body.events.find((e) => e.signed_event.event_id === upsertUpdate.event_id);
  if (updateEntry === undefined) fail(`B did not receive the update`);
  const updateDecoded = JSON.parse(decryptSyncPayload(updateEntry.signed_event.encrypted_payload, symKey));
  if (updateDecoded.message_id !== sentMessageId || updateDecoded.status !== "acked" || updateDecoded.updated_at !== updateAt) {
    fail(`B decoded update payload mismatch: ${JSON.stringify(updateDecoded)}`);
  }
  ok(`B received message-status update (status=${updateDecoded.status}, updated_at moved forward)`);

  // ----------------------------------------------------------------
  // 6. Replay idempotency + sequence regression.
  // ----------------------------------------------------------------
  const replay = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertSent
  });
  if (replay.status !== 200 || replay.body.created !== false) {
    fail(`replay was not idempotent: ${replay.status} ${JSON.stringify(replay.body)}`);
  }
  ok(`replay of same event_id is idempotent`);

  const regression = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "message.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify({ ...sentPayload, body: "different" }), symKey)
  });
  const regressionResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: regression
  });
  if (regressionResp.status !== 409 || regressionResp.body.error !== "sequence_regression") {
    fail(`sequence regression not rejected: ${regressionResp.status} ${JSON.stringify(regressionResp.body)}`);
  }
  ok(`server rejects sequence regression on the message slice`);

  // ----------------------------------------------------------------
  // 7. A revokes B with a signed revocation membership.
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

  // 8. A creates another message; A's POST is fine; B's poll is gated.
  const postRevokeMessageId = randomUUID();
  const postRevokeBody = "after-revoke leak attempt body";
  const postRevokePayload = {
    message_id: postRevokeMessageId,
    owner_canonical_id: owner.canonicalId,
    conversation_id: conversationId,
    direction: "sent",
    sender_canonical_id: owner.canonicalId,
    recipient_canonical_id: peerCanonicalId,
    body: postRevokeBody,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "stored_by_relay"
  };
  const upsertAfterRevoke = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    kind: "message.upsert",
    sequence: 4,
    encryptedPayload: encryptSyncPayload(JSON.stringify(postRevokePayload), symKey)
  });
  const afterRevokePost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: upsertAfterRevoke
  });
  if (afterRevokePost.status !== 201) fail(`A post-revoke message failed: ${JSON.stringify(afterRevokePost.body)}`);
  ok(`A posted message.upsert after revoking B (server_seq=${afterRevokePost.body.server_seq})`);

  const revokedPoll = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceBId)}&since=0`);
  if (revokedPoll.status !== 403 || revokedPoll.body.error !== "recipient_not_authorized") {
    fail(`revoked B was not refused: ${revokedPoll.status} ${JSON.stringify(revokedPoll.body)}`);
  }
  ok(`server refuses revoked B's poll (403 recipient_not_authorized)`);

  const revokedAck = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: deviceBId,
    last_server_seq: afterRevokePost.body.server_seq
  });
  if (revokedAck.status !== 403) fail(`revoked B's ack was not refused: ${revokedAck.status}`);
  ok(`server refuses revoked B's ack (403)`);

  const bAsOrigin = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceBId,
    originDevicePrivateKey: deviceB.privateKey,
    kind: "message.upsert",
    sequence: 1,
    encryptedPayload: encryptSyncPayload(JSON.stringify({ ...postRevokePayload, message_id: randomUUID() }), symKey)
  });
  const bOriginPost = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: bAsOrigin
  });
  if (bOriginPost.status !== 403) fail(`revoked B-as-origin was not refused: ${bOriginPost.status}`);
  ok(`server refuses revoked B's outbound posts (403 origin_not_authorized)`);

  // ----------------------------------------------------------------
  // 9. Plaintext leak audit. Pull the entire stored sync log via a
  //    still-active device (A) and assert no plaintext message body,
  //    peer canonical_id, or conversation_id appears anywhere.
  // ----------------------------------------------------------------
  const finalPoll = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(deviceAId)}&since=0&limit=200`);
  if (finalPoll.status !== 200) fail(`A audit poll failed: ${finalPoll.status}`);
  const blob = JSON.stringify(finalPoll.body);
  const leaked = [];
  if (blob.includes(sentBody)) leaked.push("sent body");
  if (blob.includes(receivedBody)) leaked.push("received body");
  if (blob.includes(postRevokeBody)) leaked.push("post-revoke body");
  if (blob.includes(peerCanonicalId)) leaked.push("peer canonical_id");
  if (blob.includes(conversationId)) leaked.push("conversation_id");
  if (leaked.length > 0) fail(`server-stored sync rows leak plaintext: ${leaked.join(", ")}`);
  ok(`server-stored sync rows expose only ciphertext (no plaintext body / peer / conversation)`);

  // 10. Slice/kind mismatches at the edge. The `message` slice now
  // accepts `message.upsert` and `message.delete`, so to exercise the
  // validator we pick a kind that belongs to a different slice
  // ("contact.delete") and post it under `slice: message`.
  const mismatched = buildSignedSyncEvent({
    ownerCanonicalId: owner.canonicalId,
    originDeviceId: deviceAId,
    originDevicePrivateKey: deviceA.privateKey,
    slice: "message",
    kind: "contact.delete",
    sequence: 5,
    encryptedPayload: encryptSyncPayload("{}", symKey)
  });
  const mismatchedResp = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, {
    signed_event: mismatched
  });
  if (mismatchedResp.status !== 400) fail(`slice/kind mismatch was not rejected: ${mismatchedResp.status}`);
  ok(`server rejects slice/kind mismatch (message + contact.delete) at the edge (400)`);

  console.log("\nmessage-sync smoke passed");
})().catch((error) => {
  console.error("UNEXPECTED ERROR:", error);
  process.exit(2);
});

#!/usr/bin/env node
// Stale-session-replay smoke.
//
// Threat: a previously trusted device is revoked, but the device (or
// an attacker holding its credentials) tries to keep using its
// device_id against the sync API. Today's auth check at the sync
// routes is "does device_id resolve to an active SignedDeviceMember-
// ship for this owner?" — so the contract is that a revoked device's
// device_id must be rejected with 403 on every sync surface, even if
// the device still possesses its old signing key.
//
// We verify:
//   1. While the device is active, POST /sync, GET /sync, /sync/ack,
//      and peer-progress all return 2xx.
//   2. After we replace the device's canonical membership with a
//      signed "revoked" membership at the next sequence, ALL four
//      endpoints return 403.
//   3. A SECOND device that was never revoked keeps working — proves
//      we aren't accidentally breaking the owner.

const {
  generateKeyPairSync,
  createHash,
  sign,
  randomBytes,
  randomUUID,
  pbkdf2Sync,
  createCipheriv
} = require("node:crypto");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PBKDF2_ITERATIONS = 120000;

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
function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }
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

function buildOwnerIdentity(handle) {
  const identity = generateKeyPairSync("ed25519");
  const messaging = generateKeyPairSync("ed25519");
  const feed = generateKeyPairSync("ed25519");
  const idSpki = b64url(identity.publicKey.export({ format: "der", type: "spki" }));
  const msSpki = b64url(messaging.publicKey.export({ format: "der", type: "spki" }));
  const fdSpki = b64url(feed.publicKey.export({ format: "der", type: "spki" }));
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
  const signature = b64url(sign(null, Buffer.from(canonicalJson(base)), identity.privateKey));
  return {
    document: { ...base, signature },
    identityPrivateKey: identity.privateKey,
    canonicalId: base.canonical_id
  };
}

function encryptBootstrap(pairingCode, payload) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(pairingCode, "utf8"), salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ salt: b64url(salt), iv: b64url(iv), ciphertext: b64url(Buffer.concat([ct, tag])) });
}

function buildMembership(owner, deviceId, devicePub, trustState, sequence, createdAt) {
  const now = new Date().toISOString();
  const signable = {
    type: "sudo_device_membership", protocol_version: "0.1.0",
    owner_canonical_id: owner.canonicalId, device_id: deviceId,
    device_public_key: devicePub, device_key_type: "ed25519",
    name: "smoke-dev", capabilities: { can_sync: true, can_decrypt: true },
    trust_state: trustState,
    created_at: createdAt ?? now, updated_at: now, sequence
  };
  const signature = b64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
  return { ...signable, signature };
}

async function pairDeviceWithMembership(owner) {
  const start = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  if (start.status !== 201) throw new Error(`pair/start ${start.status}`);
  const code = start.body.pairing_code;
  const devKp = generateKeyPairSync("ed25519");
  const devPub = b64url(devKp.publicKey.export({ format: "der", type: "spki" }));
  const deviceId = randomUUID();
  const membership = buildMembership(owner, deviceId, devPub, "active", 1);
  const bootstrap = encryptBootstrap(code, {
    device_id: deviceId, owner_canonical_id: owner.canonicalId, name: "smoke-dev",
    created_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
  });
  const complete = await postJson("/api/devices/pair/complete", {
    pairing_code: code, device_id: deviceId, name: "smoke-dev",
    device_public_key: devPub, encrypted_bootstrap_payload: bootstrap,
    signed_membership: membership
  });
  if (complete.status !== 201) throw new Error(`pair/complete ${complete.status} ${JSON.stringify(complete.body)}`);
  return { deviceId, devPub, devicePrivateKey: devKp.privateKey, createdAt: membership.created_at };
}

function buildSyncEvent(owner, originDeviceId, originDevicePriv, sequence) {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const signable = {
    type: "sudo_sync_event", protocol_version: "0.1.0",
    event_id: eventId, owner_canonical_id: owner.canonicalId,
    origin_device_id: originDeviceId, sequence,
    slice: "contact", kind: "contact.upsert",
    created_at: createdAt,
    encrypted_payload: b64url(randomBytes(32))
  };
  const signature = b64url(sign(null, Buffer.from(canonicalJson(signable)), originDevicePriv));
  return { ...signable, signature };
}

async function probeSyncSurface(owner, callerDeviceId, originPriv, peerDeviceId, sequence, label) {
  // POST /sync
  const evt = buildSyncEvent(owner, callerDeviceId, originPriv, sequence);
  const post = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync`, { signed_event: evt });

  // GET /sync (recipient=caller)
  const get = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync?device_id=${encodeURIComponent(callerDeviceId)}&since=0&limit=1`);

  // POST /sync/ack
  const ack = await postJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/ack`, {
    recipient_device_id: callerDeviceId, last_server_seq: 0
  });

  // GET peer-progress (caller=caller, peer=other)
  const pp = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}/sync/peer-progress?device_id=${encodeURIComponent(peerDeviceId)}&caller_device_id=${encodeURIComponent(callerDeviceId)}`);

  return { post, get, ack, pp, label };
}

(async () => {
  console.log(`BASE=${BASE_URL}`);
  const health = await getJson("/health");
  if (health.status !== 200) {
    console.error(`stale-session-replay needs a running node at ${BASE_URL} (got ${health.status})`);
    process.exit(2);
  }

  // 1. Owner + two devices, both with active memberships.
  const owner = buildOwnerIdentity("stale" + Date.now().toString().slice(-6));
  const reg = await postJson("/api/identity/register", { identity_document: owner.document });
  if (reg.status !== 201) { fail("setup-owner", `register ${reg.status}`); process.exit(1); }
  ok("owner registered");

  const dev1 = await pairDeviceWithMembership(owner);
  const dev2 = await pairDeviceWithMembership(owner);
  ok(`two devices paired and active: ${dev1.deviceId.slice(0,8)} / ${dev2.deviceId.slice(0,8)}`);

  // 2. Active-state baseline: dev1 can hit every sync surface.
  let res = await probeSyncSurface(owner, dev1.deviceId, dev1.devicePrivateKey, dev2.deviceId, 1, "dev1-active");
  if (res.post.status >= 400) fail("active.POST /sync", `${res.post.status} ${JSON.stringify(res.post.body)}`);
  else ok(`active dev1 POST /sync -> ${res.post.status}`);
  if (res.get.status !== 200) fail("active.GET /sync", `${res.get.status}`);
  else ok(`active dev1 GET /sync -> 200`);
  if (res.ack.status !== 200) fail("active.POST /sync/ack", `${res.ack.status}`);
  else ok(`active dev1 POST /sync/ack -> 200`);
  if (res.pp.status !== 200) fail("active.GET /peer-progress", `${res.pp.status}`);
  else ok(`active dev1 GET /sync/peer-progress -> 200`);

  // 3. Revoke dev1 by submitting a signed revocation at sequence 2.
  const revokeMembership = buildMembership(owner, dev1.deviceId, dev1.devPub, "revoked", 2, dev1.createdAt);
  const revoke = await postJson(`/api/devices/${encodeURIComponent(dev1.deviceId)}/revoke`, {
    owner_canonical_id: owner.canonicalId,
    signed_membership: revokeMembership
  });
  if (revoke.status !== 200 || revoke.body?.ok !== true) {
    fail("revoke", `status=${revoke.status} body=${JSON.stringify(revoke.body)}`);
    process.exit(1);
  }
  ok("dev1 revoked with signed membership at sequence 2");

  // 4. Replay every surface as dev1 — all must 403.
  res = await probeSyncSurface(owner, dev1.deviceId, dev1.devicePrivateKey, dev2.deviceId, 2, "dev1-revoked");
  if (res.post.status !== 403) fail("revoked.POST /sync", `expected 403, got ${res.post.status} ${JSON.stringify(res.post.body)}`);
  else ok(`revoked dev1 POST /sync -> 403`);
  if (res.get.status !== 403) fail("revoked.GET /sync", `expected 403, got ${res.get.status}`);
  else ok(`revoked dev1 GET /sync -> 403`);
  if (res.ack.status !== 403) fail("revoked.POST /sync/ack", `expected 403, got ${res.ack.status}`);
  else ok(`revoked dev1 POST /sync/ack -> 403`);
  if (res.pp.status !== 403) fail("revoked.GET /peer-progress", `expected 403, got ${res.pp.status} ${JSON.stringify(res.pp.body)}`);
  else ok(`revoked dev1 GET /sync/peer-progress -> 403`);

  // 5. dev2 (never revoked) must still work — proves we didn't break the owner.
  res = await probeSyncSurface(owner, dev2.deviceId, dev2.devicePrivateKey, dev1.deviceId, 1, "dev2-active");
  if (res.post.status >= 400) fail("survivor.POST /sync", `${res.post.status} ${JSON.stringify(res.post.body)}`);
  else ok(`survivor dev2 POST /sync -> ${res.post.status}`);
  if (res.get.status !== 200) fail("survivor.GET /sync", `${res.get.status}`);
  else ok(`survivor dev2 GET /sync -> 200`);
  if (res.ack.status !== 200) fail("survivor.POST /sync/ack", `${res.ack.status}`);
  else ok(`survivor dev2 POST /sync/ack -> 200`);
  if (res.pp.status !== 200) fail("survivor.GET /peer-progress", `${res.pp.status}`);
  else ok(`survivor dev2 GET /sync/peer-progress -> 200`);

  if (failures.length > 0) {
    console.error(`STALE-SESSION-REPLAY SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("STALE-SESSION-REPLAY SMOKE PASSED");
})().catch((err) => {
  console.error("STALE-SESSION-REPLAY SMOKE ERRORED:", err);
  process.exit(1);
});

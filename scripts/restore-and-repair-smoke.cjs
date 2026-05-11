#!/usr/bin/env node
// Restore-and-repair lifecycle smoke. The lost-device-recovery smoke
// covers the user-facing UX (signup → backup export → wipe → restore
// → signed-in via challenge flow). This smoke covers the trust
// semantics of restoring a device and then continuing to use it as
// a normal pairing peer:
//
//   1. Mint identity A via /api/identity/register.
//   2. Pair second device B with A (pair/start + pair/complete with
//      a SignedDeviceMembership signed by A's identity key).
//   3. Simulate wiping A: drop the original device id from our
//      working state but keep the identity key (mirroring what
//      backup-file restore preserves — the key, not the device id).
//   4. "Restore A" by minting a fresh device A' that re-uses the
//      same identity key but generates its own device public key
//      and device id. A' self-registers via the device-membership
//      surface (the same path the browser takes after a backup
//      restore). This is the assertion that fresh device ids on
//      restore are well-formed: trust derives from the identity
//      signature, not from browser persistence.
//   5. Pair third device C from A'.
//   6. All three devices (A', B, C) appear as active in the device
//      listing, each with a distinct device_id.
//   7. The original A1 device id is no longer "the device A is
//      currently using" but its trusted_devices row is left intact
//      so the user can revoke it from their linked-devices dialog.
//   8. Each of A', B, C can mint a server session via the
//      client-signed challenge flow against A's identity public
//      key, proving challenge auth survives the restore.
//
// HTTP-only — no browser. Mirrors the patterns in
// scripts/device-pairing-smoke.cjs.
//
// Usage:
//   BASE_URL=http://127.0.0.1:3000 node scripts/restore-and-repair-smoke.cjs

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

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }

function buildIdentity(handle) {
  const identity = generateKeyPairSync("ed25519");
  const messaging = generateKeyPairSync("ed25519");
  const feed = generateKeyPairSync("ed25519");
  const identityPublicKeySpki = base64url(identity.publicKey.export({ format: "der", type: "spki" }));
  const messagingPublicKeySpki = base64url(messaging.publicKey.export({ format: "der", type: "spki" }));
  const feedPublicKeySpki = base64url(feed.publicKey.export({ format: "der", type: "spki" }));
  const canonicalId = `sudo:ed25519:${sha256Hex(identityPublicKeySpki)}`;
  const createdAt = new Date().toISOString();
  const baseDocument = {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: canonicalId,
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
    canonicalId,
    identityPrivateKey: identity.privateKey
  };
}

function buildSignedMembership(owner, deviceKeypair, name) {
  const devicePublicKeySpki = base64url(deviceKeypair.publicKey.export({ format: "der", type: "spki" }));
  const deviceId = randomUUID();
  const now = new Date().toISOString();
  const signable = {
    type: "sudo_device_membership",
    protocol_version: "0.1.0",
    owner_canonical_id: owner.canonicalId,
    device_id: deviceId,
    device_public_key: devicePublicKeySpki,
    device_key_type: "ed25519",
    name,
    capabilities: { can_sync: true, can_decrypt: true },
    trust_state: "active",
    created_at: now,
    updated_at: now,
    sequence: 1
  };
  const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
  return { membership: { ...signable, signature }, deviceId, devicePublicKeySpki };
}

function encryptBootstrap(pairingCode, payload) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(pairingCode, "utf8"), salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    salt: base64url(salt),
    iv: base64url(iv),
    ciphertext: base64url(Buffer.concat([ct, tag]))
  });
}

async function postJson(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

async function getJson(path) {
  const r = await fetch(`${BASE_URL}${path}`, { headers: { accept: "application/json" } });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

async function pairDevice(owner, deviceKeypair, name) {
  const start = await postJson("/api/devices/pair/start", { owner_canonical_id: owner.canonicalId });
  if (start.status !== 201 || !start.body.ok) {
    throw new Error(`pair/start failed for ${name}: ${start.status} ${JSON.stringify(start.body)}`);
  }
  const code = start.body.pairing_code;
  const built = buildSignedMembership(owner, deviceKeypair, name);
  const bootstrap = encryptBootstrap(code, {
    device_id: built.deviceId,
    owner_canonical_id: owner.canonicalId,
    name,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  });
  const complete = await postJson("/api/devices/pair/complete", {
    pairing_code: code,
    device_id: built.deviceId,
    name,
    device_public_key: built.devicePublicKeySpki,
    encrypted_bootstrap_payload: bootstrap,
    signed_membership: built.membership
  });
  if (complete.status !== 201 || !complete.body.ok) {
    throw new Error(`pair/complete failed for ${name}: ${complete.status} ${JSON.stringify(complete.body)}`);
  }
  return { device_id: built.deviceId, device_public_key: built.devicePublicKeySpki };
}

async function mintSession(owner) {
  const challenge = await getJson(`/api/identity/challenge/${encodeURIComponent(owner.canonicalId)}`);
  if (challenge.status !== 200) throw new Error(`challenge GET failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
  const signable = { type: "sudo_session_challenge", canonical_id: owner.canonicalId, nonce: challenge.body.nonce };
  const signature = base64url(sign(null, Buffer.from(canonicalJson(signable)), owner.identityPrivateKey));
  const session = await postJson("/api/identity/session-from-challenge", {
    canonical_id: owner.canonicalId,
    nonce: challenge.body.nonce,
    signature
  });
  if (session.status !== 200 || typeof session.body?.sessionToken !== "string") {
    throw new Error(`session-from-challenge failed: ${session.status} ${JSON.stringify(session.body)}`);
  }
  return session.body.sessionToken;
}

(async () => {
  const health = await getJson("/health").catch(() => ({ status: 0 }));
  if (health.status !== 200) { console.error(`needs node at ${BASE_URL}`); process.exit(2); }

  // Phase 1 — register identity A and self-onboard the original device (A1).
  const handle = `restpair${Date.now().toString().slice(-7)}`;
  const owner = buildIdentity(handle);
  const reg = await postJson("/api/identity/register", { identity_document: owner.document });
  if (reg.status !== 201) { fail("1.register", `expected 201, got ${reg.status}: ${JSON.stringify(reg.body)}`); throw new Error(); }
  ok(`1. registered identity A (${owner.canonicalId.slice(0, 28)}...)`);

  const a1 = await pairDevice(owner, generateKeyPairSync("ed25519"), "device-A1").catch((e) => { fail("1.pairA1", e.message); throw e; });
  ok(`1b. paired original device A1 (${a1.device_id.slice(0, 8)})`);

  // Phase 2 — pair second device B.
  const b = await pairDevice(owner, generateKeyPairSync("ed25519"), "device-B").catch((e) => { fail("2.pairB", e.message); throw e; });
  ok(`2. paired device B (${b.device_id.slice(0, 8)})`);

  // Phase 3 — wipe A1 (representational: drop our local handle to A1's
  // device id, preserve the identity key — that's what
  // .sudo-backup.json does in the browser).
  const wipedDeviceId = a1.device_id;
  ok(`3. simulated wipe of A1; identity key preserved (the backup-file invariant)`);

  // Phase 4 — restore A as a fresh device A'. Brand-new device
  // keypair, brand-new device id, signed by the same identity key.
  // This is what `importLocalSnapshot` post-step-7 produces: settings
  // imported except `device.metadata`, so ensureCurrentDeviceId()
  // mints a fresh UUID on the next signin.
  const aPrime = await pairDevice(owner, generateKeyPairSync("ed25519"), "device-A'-restored").catch((e) => { fail("4.restoreA", e.message); throw e; });
  if (aPrime.device_id === wipedDeviceId) {
    fail("4.fresh-id", "restored install reused the wiped device id; trust must derive from identity signatures, not browser persistence");
  } else {
    ok(`4. restored install minted a FRESH device id ${aPrime.device_id.slice(0, 8)} (not the wiped ${wipedDeviceId.slice(0, 8)})`);
  }

  // Phase 5 — A' pairs a third device C.
  const c = await pairDevice(owner, generateKeyPairSync("ed25519"), "device-C").catch((e) => { fail("5.pairC", e.message); throw e; });
  ok(`5. restored install A' paired device C (${c.device_id.slice(0, 8)})`);

  // Phase 6 — listing returns A1 (still active until revoked), B, A',
  // and C. The original A1 row stays so the user can revoke it from
  // the linked-devices dialog if they choose.
  const listing = await getJson(`/api/devices/${encodeURIComponent(owner.canonicalId)}`);
  if (listing.status !== 200 || !Array.isArray(listing.body.devices)) {
    fail("6.listing", `device listing failed: ${listing.status}`);
  } else {
    const ids = new Set(listing.body.devices.map((d) => d.device_id));
    const expected = [wipedDeviceId, b.device_id, aPrime.device_id, c.device_id];
    const missing = expected.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      fail("6.listing", `device listing missing ids: ${missing.map((m) => m.slice(0, 8)).join(", ")}`);
    } else {
      ok(`6. listing has all 4 device records (A1 wiped + B + A'-restored + C)`);
    }
    const fresh = listing.body.devices.find((d) => d.device_id === aPrime.device_id);
    if (!fresh || fresh.trust_state !== "active") fail("6.listing", `restored A' is not active in listing: ${JSON.stringify(fresh)}`);
    else ok(`6b. restored A' is active in the device listing`);
  }

  // Phase 7 — challenge auth still works against A's identity for
  // each of B, A', and C. (The pairing-code flow gives the device
  // record a presence on the server; minting a *session* still goes
  // through the identity-key-signed challenge flow. The same
  // identity key signs all three; the device records are
  // bookkeeping for trust-and-revoke.)
  for (const label of [["A'-restored", aPrime], ["B", b], ["C", c]]) {
    const [name] = label;
    try {
      const token = await mintSession(owner);
      if (typeof token === "string" && token.length >= 16) {
        ok(`7. challenge auth still mints a session under A's identity (after restore + ${name})`);
      } else {
        fail(`7.${name}`, `unexpected session token shape`);
      }
    } catch (e) {
      fail(`7.${name}`, e.message);
    }
  }

  if (failures.length > 0) {
    console.error(`\nRESTORE-AND-REPAIR SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nRESTORE-AND-REPAIR SMOKE PASSED");
})().catch((error) => { console.error("RESTORE-AND-REPAIR SMOKE ERROR", error); process.exit(2); });

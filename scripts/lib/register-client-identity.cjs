// Shared smoke fixture: mint a registered identity using the same
// path the production browser portal uses for signup.
//
// Why: prior to migration step 4, several smokes minted fixture
// actors via POST /dev/signup or POST /api/identity/signup. That
// route generates a server-side Ed25519 keypair, mirrors a password
// credential into dev_account_access, and returns a session token —
// none of which a fixture actor needs in order to be addressable by
// canonical_id, post on the feed, or react.
//
// This helper does only what the production browser does:
//   1. generates an Ed25519 keypair via node:crypto (the same primitive
//      WebCrypto exposes, with the same canonical-JSON signing rules
//      our protocol verifier accepts)
//   2. builds a SignableIdentityDocument and signs it
//   3. POSTs the signed document to /api/identity/register
//   4. returns the canonical_id, the kept private key (so the caller
//      can mint a session via the challenge flow if it needs one),
//      and the registered document
//
// Ordinary smoke runs that use this helper produce zero
// [legacy-signin] log events on the server and zero PEM files under
// data/keys/.

const {
  generateKeyPairSync,
  createHash,
  sign: nodeSign
} = require("node:crypto");

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

function buildIdentity(handle, homeNode = "127.0.0.1") {
  const identityKey = generateKeyPairSync("ed25519");
  const feedKey = generateKeyPairSync("ed25519");
  const identityPublicSpki = base64Url(identityKey.publicKey.export({ type: "spki", format: "der" }));
  const feedPublicSpki = base64Url(feedKey.publicKey.export({ type: "spki", format: "der" }));
  const canonicalId = `sudo:ed25519:${sha256Hex(identityPublicSpki)}`;
  const createdAt = new Date().toISOString();
  const unsigned = {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: canonicalId,
    handle: `@${handle}`,
    home_node: homeNode,
    keys: {
      identity: { type: "ed25519", public_key: identityPublicSpki },
      messaging: { type: "x25519_or_placeholder", public_key: `placeholder:${identityPublicSpki.slice(0, 24)}` },
      feed: { type: "ed25519", public_key: feedPublicSpki }
    },
    delivery_relays: [],
    feed_endpoints: [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence: 1
  };
  const signature = base64Url(nodeSign(null, Buffer.from(canonicalJson(unsigned)), identityKey.privateKey));
  return {
    canonicalId,
    identityKey,
    document: { ...unsigned, signature }
  };
}

// Mints a registered fixture identity. Returns:
//   { canonical_id, handle, identity_key, identity_document }
//
// The shape intentionally mirrors what the legacy /dev/signup
// helpers returned (`{ identity: { canonical_id, handle, ... } }`)
// so existing call sites can be updated mechanically:
//   const id = await registerClientIdentity(BASE, handle);
//   actor.canonical_id  →  id.canonical_id
//   actor.handle        →  id.handle
async function registerClientIdentity(baseUrl, handle) {
  const built = buildIdentity(handle);
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/identity/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity_document: built.document })
  });
  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`registerClientIdentity(${handle}) -> ${resp.status} ${body}`);
  }
  return {
    canonical_id: built.canonicalId,
    handle: `@${handle}`,
    identity_key: built.identityKey,
    identity_document: built.document
  };
}

// Optional: mint a server session for an already-registered
// fixture by signing a fresh challenge nonce. Returns the bearer
// token. Most smokes don't need this — they identify the actor by
// canonical_id and don't go through any session-gated route.
async function mintSession(baseUrl, identity) {
  const challengeResp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/identity/challenge/${encodeURIComponent(identity.canonical_id)}`);
  if (!challengeResp.ok) {
    throw new Error(`challenge(${identity.canonical_id}) -> ${challengeResp.status}`);
  }
  const challenge = await challengeResp.json();
  const signable = { type: "sudo_session_challenge", canonical_id: identity.canonical_id, nonce: challenge.nonce };
  const signature = base64Url(nodeSign(null, Buffer.from(canonicalJson(signable)), identity.identity_key.privateKey));
  const sessionResp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/identity/session-from-challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canonical_id: identity.canonical_id, nonce: challenge.nonce, signature })
  });
  if (!sessionResp.ok) {
    throw new Error(`session-from-challenge(${identity.canonical_id}) -> ${sessionResp.status} ${await sessionResp.text()}`);
  }
  return sessionResp.json();
}

module.exports = { registerClientIdentity, mintSession };

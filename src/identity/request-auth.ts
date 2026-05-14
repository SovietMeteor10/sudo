// Per-request signed-payload authentication for write routes that
// mutate trust state. This is the answer to the audit finding that
// every social-graph endpoint accepted owner_canonical_id from the
// request body with no proof of ownership.
//
// Wire shape (the client computes this header for every signed
// request):
//
//   X-Sudo-Auth: <base64url-json>
//
// where <base64url-json> decodes to JSON of the form:
//
//   {
//     "canonical_id": "sudo:...",
//     "device_id":   "<uuid>",       // present only on device-signed requests
//     "ts":          1700000000,     // seconds since epoch
//     "nonce":       "<base64url>",  // 16 random bytes, single-use
//     "signature":   "<base64url>"   // signature over the signed payload
//   }
//
// The signed payload (what the client signs and the server verifies)
// is the canonical JSON of:
//
//   {
//     "type":         "sudo_request_auth",
//     "method":       "POST",
//     "path":         "/api/connections",
//     "body_digest":  "<sha256(canonicalJson(body)) as base64url>",
//     "canonical_id": "sudo:...",
//     "device_id":    "...",          // if device-signed
//     "ts":           1700000000,
//     "nonce":        "..."
//   }
//
// Replay defenses:
//   - ts must be within +/- TS_SKEW_SECONDS of server time
//   - nonce must not have been seen in the current process within
//     NONCE_TTL_SECONDS; stored in-memory and pruned lazily
//   - signature is over the body digest, so a captured signature
//     cannot be reused with a different body
//   - path + method are part of the signed payload, so a signature
//     for POST /api/feeds cannot be replayed against POST /api/connections
//
// Server restart loses the nonce store. The TS skew window
// (60s default) bounds the worst-case replay window after restart.

import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { canonicalJson, verifyCanonicalSignature } from "../crypto/signatures.js";
import { getIdentityByCanonicalId } from "./identity.store.js";
import { getLatestDeviceMembership } from "../devices/devices.store.js";
import type { SigningKeyType } from "../protocol/types.js";

const TS_SKEW_SECONDS = 60;
const NONCE_TTL_SECONDS = 120;
const PRUNE_INTERVAL_MS = 5_000;
const MAX_NONCE_STORE = 100_000;

// nonce -> expiresAt epoch-millis. Single-use; an attempt to consume
// an already-present nonce returns false.
const seenNonces = new Map<string, number>();
let lastPrune = 0;

function pruneNonces(now: number): void {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
  // Hard cap: if the map grows past MAX_NONCE_STORE despite expiry-driven
  // pruning, drop the oldest entries. Protects against an attacker who
  // floods unique-but-not-yet-expired nonces.
  if (seenNonces.size > MAX_NONCE_STORE) {
    const overflow = seenNonces.size - MAX_NONCE_STORE;
    let dropped = 0;
    for (const nonce of seenNonces.keys()) {
      seenNonces.delete(nonce);
      if (++dropped >= overflow) break;
    }
  }
}

function consumeNonce(nonce: string, expiresAtMs: number, now: number): boolean {
  pruneNonces(now);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, expiresAtMs);
  return true;
}

export function __resetSignedRequestStateForTests(): void {
  seenNonces.clear();
  lastPrune = 0;
}

type SignedAuthHeader = {
  canonical_id: string;
  device_id?: string;
  ts: number;
  nonce: string;
  signature: string;
};

function parseHeader(raw: string | undefined): SignedAuthHeader | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return null;
  let decoded: string;
  try {
    const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
    decoded = Buffer.from(normalized, "base64").toString("utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.canonical_id !== "string"
    || typeof candidate.ts !== "number"
    || !Number.isFinite(candidate.ts)
    || typeof candidate.nonce !== "string"
    || candidate.nonce.length === 0
    || candidate.nonce.length > 128
    || typeof candidate.signature !== "string"
    || candidate.signature.length === 0
    || candidate.signature.length > 1024
  ) {
    return null;
  }
  if (candidate.device_id !== undefined && typeof candidate.device_id !== "string") {
    return null;
  }
  return {
    canonical_id: candidate.canonical_id,
    device_id: candidate.device_id as string | undefined,
    ts: candidate.ts,
    nonce: candidate.nonce,
    signature: candidate.signature
  };
}

function bodyDigest(body: unknown): string {
  // canonicalJson sorts keys recursively and handles undefined consistently
  // (JSON.stringify drops undefined fields). Hash the canonical bytes.
  //
  // express.json populates request.body to {} when no body is sent
  // (DELETE / GET / POST without body). Normalize that to null so
  // the digest matches what a client signs for a body-less request.
  const isEmptyObject = body !== null
    && typeof body === "object"
    && !Array.isArray(body)
    && Object.keys(body as Record<string, unknown>).length === 0;
  const normalized = body === undefined || isEmptyObject ? null : body;
  const json = canonicalJson(normalized);
  return createHash("sha256").update(json).digest("base64url");
}

// Path used in the signed payload. Strips query string and any trailing
// slash. Uses originalUrl so the mount-point-stripping behavior of
// req.path doesn't depend on which router the middleware sits behind.
function signedPath(request: Request): string {
  const original = request.originalUrl ?? request.url ?? "";
  const queryIndex = original.indexOf("?");
  const noQuery = queryIndex === -1 ? original : original.slice(0, queryIndex);
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

function reject(response: Response, status: number, error: string, message: string): void {
  response.status(status).json({ ok: false, error, message });
}

// Extend express Request with the authenticated identifiers. Routes
// downstream of the middleware can read these without re-verifying.
declare module "express-serve-static-core" {
  interface Request {
    authenticatedCanonicalId?: string;
    authenticatedDeviceId?: string;
  }
}

export type IdentityAuthRequirement = {
  kind: "identity";
  // Field names to cross-check against the authenticated canonical_id.
  // The middleware will reject the request if any named field exists
  // and disagrees with the signer. Omit to skip the cross-check (e.g.
  // when the authenticated canonical_id is the only owner reference).
  bodyOwnerField?: string;
  urlOwnerParam?: string;
  queryOwnerField?: string;
};

export type DeviceAuthRequirement = {
  kind: "device";
  // The owner canonical_id whose device-list we look up the device in.
  // Defaults to the signer's canonical_id, which is typical (a device
  // signing for its own owner). Set to look up a device under a
  // different owner.
  bodyOwnerField?: string;
  urlOwnerParam?: string;
  queryOwnerField?: string;
  // The device_id named in the request must match the signer's device_id.
  bodyDeviceField?: string;
  urlDeviceParam?: string;
  queryDeviceField?: string;
};

export type RequestAuthRequirement = IdentityAuthRequirement | DeviceAuthRequirement;

function readFieldFromRequest(
  request: Request,
  bodyKey: string | undefined,
  urlKey: string | undefined,
  queryKey: string | undefined
): string | null {
  if (bodyKey !== undefined) {
    const body = request.body as Record<string, unknown> | undefined;
    const value = body?.[bodyKey];
    if (typeof value === "string") return value;
  }
  if (urlKey !== undefined) {
    const value = request.params[urlKey];
    if (typeof value === "string") return value;
  }
  if (queryKey !== undefined) {
    const value = request.query[queryKey];
    if (typeof value === "string") return value;
  }
  return null;
}

export function requireSignedRequest(requirement: RequestAuthRequirement) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const header = parseHeader(request.get("x-sudo-auth"));
    if (header === null) {
      reject(response, 401, "missing_signature", "x-sudo-auth header is required");
      return;
    }

    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    if (Math.abs(header.ts - nowSeconds) > TS_SKEW_SECONDS) {
      reject(response, 401, "expired_signature", "request signature timestamp is outside the accepted window");
      return;
    }

    const nonceExpiresAt = (header.ts + NONCE_TTL_SECONDS) * 1000;
    if (!consumeNonce(header.nonce, nonceExpiresAt, now)) {
      reject(response, 401, "replayed_signature", "nonce has already been used");
      return;
    }

    const identity = getIdentityByCanonicalId(header.canonical_id);
    if (identity === null) {
      reject(response, 401, "unknown_identity", "signer is not registered on this node");
      return;
    }

    let verifyingPublicKey: string | undefined;
    let verifyingKeyType: SigningKeyType = "ed25519";

    if (requirement.kind === "identity") {
      verifyingPublicKey = identity.document.keys?.identity?.public_key;
      verifyingKeyType = identity.document.keys?.identity?.type ?? "ed25519";
    } else {
      if (typeof header.device_id !== "string" || header.device_id.length === 0) {
        reject(response, 401, "missing_device_id", "device_id is required for device-signed requests");
        return;
      }
      // Resolve the device's published key under the signer's owner.
      // resolveActiveMembership semantics: latest known membership for
      // this device_id must be for this owner AND trust_state=='active'.
      const membership = getLatestDeviceMembership(header.device_id);
      if (membership === null) {
        reject(response, 401, "unknown_device", "device is not registered on this node");
        return;
      }
      if (membership.owner_canonical_id !== header.canonical_id) {
        reject(response, 401, "device_owner_mismatch", "device does not belong to the signer");
        return;
      }
      if (membership.trust_state !== "active") {
        reject(response, 401, "device_revoked", "device is not active");
        return;
      }
      verifyingPublicKey = membership.device_public_key;
      verifyingKeyType = membership.device_key_type ?? "ed25519";
    }

    if (typeof verifyingPublicKey !== "string" || verifyingPublicKey.length === 0) {
      reject(response, 401, "missing_public_key", "signer has no published public key");
      return;
    }

    const signedPayload: Record<string, unknown> = {
      type: "sudo_request_auth",
      method: request.method.toUpperCase(),
      path: signedPath(request),
      body_digest: bodyDigest(request.body),
      canonical_id: header.canonical_id,
      ts: header.ts,
      nonce: header.nonce
    };
    if (header.device_id !== undefined) {
      signedPayload.device_id = header.device_id;
    }

    if (!verifyCanonicalSignature(signedPayload, header.signature, verifyingPublicKey, verifyingKeyType)) {
      reject(response, 401, "invalid_signature", "request signature did not verify");
      return;
    }

    // Cross-check: the authenticated canonical_id must match any
    // owner_canonical_id field named in the body, URL params, or
    // query string. This closes the "I am eve but I am writing to
    // victim's row" attack.
    const claimedOwner = readFieldFromRequest(
      request,
      requirement.bodyOwnerField,
      requirement.urlOwnerParam,
      requirement.queryOwnerField
    );
    if (claimedOwner !== null && claimedOwner !== header.canonical_id) {
      reject(response, 403, "canonical_id_mismatch", "signer does not match owner_canonical_id");
      return;
    }

    if (requirement.kind === "device") {
      const claimedDevice = readFieldFromRequest(
        request,
        requirement.bodyDeviceField,
        requirement.urlDeviceParam,
        requirement.queryDeviceField
      );
      if (claimedDevice !== null && claimedDevice !== header.device_id) {
        reject(response, 403, "device_id_mismatch", "signer does not match named device_id");
        return;
      }
    }

    request.authenticatedCanonicalId = header.canonical_id;
    if (header.device_id !== undefined) {
      request.authenticatedDeviceId = header.device_id;
    }
    next();
  };
}

// Exposed for smokes and route-level usage where the middleware shape
// doesn't fit (e.g. a route that needs to choose between identity-sig
// or actor-sig at runtime).
export function verifySignedRequest(opts: {
  header: string | undefined;
  method: string;
  path: string;
  body: unknown;
  expectedCanonicalId?: string;
  expectedDeviceId?: string;
  // The caller supplies the public key + type to verify against. Useful
  // when the verifying key is not the signer's identity key (e.g. a
  // feed-key signature where the actor is known by canonical_id but
  // signs with a separate feed key).
  publicKey: string;
  keyType?: SigningKeyType;
}): { ok: true; canonicalId: string; deviceId?: string } | { ok: false; error: string; message: string } {
  const header = parseHeader(opts.header);
  if (header === null) return { ok: false, error: "missing_signature", message: "x-sudo-auth header is required" };

  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  if (Math.abs(header.ts - nowSeconds) > TS_SKEW_SECONDS) {
    return { ok: false, error: "expired_signature", message: "request signature timestamp is outside the accepted window" };
  }

  const nonceExpiresAt = (header.ts + NONCE_TTL_SECONDS) * 1000;
  if (!consumeNonce(header.nonce, nonceExpiresAt, now)) {
    return { ok: false, error: "replayed_signature", message: "nonce has already been used" };
  }

  if (opts.expectedCanonicalId !== undefined && header.canonical_id !== opts.expectedCanonicalId) {
    return { ok: false, error: "canonical_id_mismatch", message: "signer does not match expected canonical_id" };
  }
  if (opts.expectedDeviceId !== undefined && header.device_id !== opts.expectedDeviceId) {
    return { ok: false, error: "device_id_mismatch", message: "signer device does not match expected device_id" };
  }

  const signedPayload: Record<string, unknown> = {
    type: "sudo_request_auth",
    method: opts.method.toUpperCase(),
    path: opts.path,
    body_digest: bodyDigest(opts.body),
    canonical_id: header.canonical_id,
    ts: header.ts,
    nonce: header.nonce
  };
  if (header.device_id !== undefined) signedPayload.device_id = header.device_id;

  if (!verifyCanonicalSignature(signedPayload, header.signature, opts.publicKey, opts.keyType ?? "ed25519")) {
    return { ok: false, error: "invalid_signature", message: "request signature did not verify" };
  }

  return { ok: true, canonicalId: header.canonical_id, deviceId: header.device_id };
}

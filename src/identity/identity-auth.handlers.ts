// HTTP handlers for the identity-auth surface. After migration step 6
// the only password/recovery routes (/api/identity/{signup,recover}
// and the /dev/* aliases) are gone — every account is client-key only
// and authenticates via the challenge flow below. What remains:
//
//   GET  /api/identity/session                — restore from bearer
//   GET  /api/identity/search?q=...           — handle search
//   GET  /api/identity/challenge/:canonicalId — issue a single-use nonce
//   POST /api/identity/session-from-challenge — exchange a signed nonce
//                                                for a session token
//
// Account creation is handled by POST /api/identity/register
// (in identity.routes.ts) which accepts a client-signed
// IdentityDocument and stores nothing else.

import type { Request, Response } from "express";
import { verifyCanonicalSignature } from "../crypto/signatures.js";
import { searchIdentityHandles } from "../discovery/discovery.service.js";
import { getIdentityByCanonicalId } from "./identity.store.js";
import { consumeChallenge, createChallenge } from "./identity-challenge.service.js";
import { checkChallengeRate } from "./challenge-rate-limit.js";
import { emitRateLimited } from "../devices/rate-limit-response.js";
import {
  createDevSession,
  getIdentityForDevSession
} from "../localState/accountAccess.js";

// Phase 14 MED-2: only honor X-Real-IP when the immediate peer is
// loopback (i.e. behind nginx). See src/node/trusted-ip.ts.
import { resolveTrustedIp as resolveRemoteIp } from "../node/trusted-ip.js";

function rejectIfRateLimited(request: Request, response: Response, canonicalId: string | null): boolean {
  const result = checkChallengeRate(resolveRemoteIp(request), canonicalId);
  if (result.ok) return false;
  emitRateLimited(response, result, {
    message: `too many challenge requests; retry in ${result.retry_after_seconds}s`
  });
  return true;
}

export function handleIdentitySession(request: Request, response: Response): void {
  const authorization = request.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authorization);

  if (!match) {
    response.status(401).json({ error: "missing_session", message: "missing bearer token" });
    return;
  }

  const identity = getIdentityForDevSession(match[1]!);
  if (!identity) {
    response.status(401).json({ error: "invalid_session", message: "session expired or invalid" });
    return;
  }

  response.json(identity);
}

export function handleIdentitySearch(request: Request, response: Response): void {
  const query = typeof request.query["q"] === "string" ? request.query["q"] : "";
  response.json({ results: searchIdentityHandles(query) });
}

// Client-signed session bootstrap.
//
// GET /api/identity/challenge/:canonicalId — issues a fresh nonce
// for the named identity. The nonce is stored server-side under a
// short TTL and is single-use.
//
// POST /api/identity/session-from-challenge — accepts
// { canonical_id, nonce, signature }, verifies the signature
// against the registered identity public key over the canonical
// JSON of { type: "sudo_session_challenge", canonical_id, nonce },
// and on success mints a session via the existing createDevSession
// helper. No password is required, so a browser-key account whose
// private key lives only in IndexedDB can authenticate without
// ever sending its password to the server.
//
// Failure modes (all return 401 except 400 for malformed bodies):
//   - unknown nonce      → 401 (already consumed or never existed)
//   - expired nonce      → 401
//   - canonical mismatch → 401 (nonce was for someone else)
//   - bad signature      → 401 (nonce burned regardless)
//   - identity unknown   → 401

export function handleIdentityChallenge(request: Request, response: Response): void {
  const canonicalId = request.params["canonicalId"];
  if (typeof canonicalId !== "string" || canonicalId.length === 0) {
    // Bad request — count against the per-IP bucket only (no canonical
    // id is known yet) so a noisy probe can't flood the endpoint.
    if (rejectIfRateLimited(request, response, null)) return;
    response.status(400).json({ error: "invalid_canonical_id", message: "canonical_id is required" });
    return;
  }
  if (rejectIfRateLimited(request, response, canonicalId)) return;
  if (getIdentityByCanonicalId(canonicalId) === null) {
    // Hide identity-existence vs. nonce details behind a single 404.
    // A challenge for an identity the registry doesn't know cannot
    // possibly be exchanged for a session.
    response.status(404).json({ error: "identity_not_found", message: "identity is not registered on this node" });
    return;
  }
  const challenge = createChallenge(canonicalId);
  response.json({ ...challenge, canonical_id: canonicalId });
}

type SessionFromChallengeBody = {
  canonical_id?: unknown;
  nonce?: unknown;
  signature?: unknown;
};

export function handleIdentitySessionFromChallenge(request: Request, response: Response): void {
  const body = request.body as SessionFromChallengeBody;
  if (
    typeof body.canonical_id !== "string"
    || typeof body.nonce !== "string"
    || typeof body.signature !== "string"
  ) {
    if (rejectIfRateLimited(request, response, null)) return;
    response.status(400).json({ error: "invalid_payload", message: "canonical_id, nonce, and signature are required" });
    return;
  }

  // Rate-limit BEFORE consumeChallenge so an attacker can't drain
  // bucket budget by burning their own nonces. The consume-on-failure
  // semantics in consumeChallenge stay intact below — once we get
  // past the limiter, every attempt still costs the user a nonce.
  if (rejectIfRateLimited(request, response, body.canonical_id)) return;

  const identity = getIdentityByCanonicalId(body.canonical_id);
  if (identity === null) {
    response.status(401).json({ error: "invalid_session_challenge", message: "identity is not registered" });
    return;
  }

  const consumeResult = consumeChallenge(body.nonce, body.canonical_id);
  if (!consumeResult.ok) {
    response.status(401).json({ error: "invalid_session_challenge", message: consumeResult.code });
    return;
  }

  const signable = {
    type: "sudo_session_challenge" as const,
    canonical_id: body.canonical_id,
    nonce: body.nonce
  };

  const publicKey = identity.document.keys?.identity?.public_key;
  const keyType = identity.document.keys?.identity?.type ?? "ed25519";
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    response.status(401).json({ error: "invalid_session_challenge", message: "identity has no published public key" });
    return;
  }

  if (!verifyCanonicalSignature(signable, body.signature, publicKey, keyType)) {
    response.status(401).json({ error: "invalid_session_challenge", message: "signature did not verify" });
    return;
  }

  const session = createDevSession(body.canonical_id);
  response.json({
    identity: identity.document,
    sessionToken: session.token,
    expiresAt: session.expiresAt
  });
}

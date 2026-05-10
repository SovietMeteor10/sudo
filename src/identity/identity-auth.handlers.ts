// Shared HTTP handlers for the identity-auth surface (signup, signin,
// recover, session, search). Mounted twice during the migration:
//   - /api/identity/{signup,signin,recover,session,search}  (canonical)
//   - /dev/{signup,signin,recover,session,search-handles}   (deprecated alias)
//
// Both mount points call the same handlers. The /dev/* alias stays for
// one release so cached browsers keep working; new client builds use
// the canonical path. Deprecation headers and a once-per-process warn
// log are emitted by the alias router itself, not here.

import type { Request, Response } from "express";
import { verifyCanonicalSignature } from "../crypto/signatures.js";
import { searchIdentityHandles } from "../discovery/discovery.service.js";
import { getIdentityByCanonicalId } from "./identity.store.js";
import { consumeChallenge, createChallenge } from "./identity-challenge.service.js";
import {
  AccountAccessError,
  accountAccessProvider,
  createDevSession,
  getIdentityForDevSession
} from "../localState/accountAccess.js";
import { DevSignupError, createDevIdentity } from "./devSignup.js";
import { readNodeRuntimeConfig, resolveIdentityHost } from "../node/node.config.js";

type SignupBody = {
  handle?: unknown;
  password?: unknown;
  recoveryQuestion?: unknown;
  recoveryAnswer?: unknown;
};

type RecoverBody = {
  handle?: unknown;
  backupCode?: unknown;
  recoveryQuestion?: unknown;
  recoveryAnswer?: unknown;
};

export function handleIdentitySignup(request: Request, response: Response): void {
  const config = readNodeRuntimeConfig();
  if (!config.allowSignups) {
    response.status(403).json({ error: "signups_disabled", message: "signups are disabled on this node" });
    return;
  }

  if (config.requireInvite) {
    response.status(403).json({ error: "invite_required", message: "this node requires an invite" });
    return;
  }

  const body = request.body as SignupBody;

  if (typeof body.handle !== "string") {
    response.status(400).json({ error: "invalid_handle", message: "handle is required" });
    return;
  }

  if (typeof body.password !== "string" || !isStrongPassword(body.password)) {
    response.status(400).json({ error: "weak_password", message: "password does not meet requirements" });
    return;
  }

  if (typeof body.recoveryQuestion !== "string" || body.recoveryQuestion.trim().length < 1) {
    response.status(400).json({ error: "invalid_recovery_question", message: "recovery question is required" });
    return;
  }

  if (typeof body.recoveryAnswer !== "string" || body.recoveryAnswer.trim().length < 1) {
    response.status(400).json({ error: "invalid_recovery_answer", message: "recovery answer is required" });
    return;
  }

  try {
    const baseUrl = process.env.SUDO_BASE_URL?.trim() || config.publicBaseUrl || `${request.protocol}://${request.get("host")}`;
    const host = resolveIdentityHost(config);
    const result = createDevIdentity({
      rawHandle: body.handle,
      password: body.password,
      recoveryQuestion: body.recoveryQuestion.trim(),
      recoveryAnswer: body.recoveryAnswer.trim(),
      baseUrl,
      host
    });

    response.status(201).json({
      identity: result.identity,
      backupCode: result.backupCode,
      sessionToken: createDevSession(result.canonicalId).token
    });
  } catch (error) {
    if (error instanceof DevSignupError) {
      response
        .status(error.code === "duplicate_handle" ? 409 : 400)
        .json({ error: error.code, message: error.message });
      return;
    }

    throw error;
  }
}

export function handleIdentityRecover(request: Request, response: Response): void {
  const body = request.body as RecoverBody;

  if (
    typeof body.handle !== "string"
    || typeof body.backupCode !== "string"
    || typeof body.recoveryQuestion !== "string"
    || typeof body.recoveryAnswer !== "string"
  ) {
    response.status(400).json({ error: "invalid_credentials", message: "handle, backup code, recovery question, and recovery answer are required" });
    return;
  }

  try {
    const result = accountAccessProvider.recoverCredential(
      body.handle,
      body.backupCode,
      body.recoveryAnswer
    );
    response.json({
      identity: result.identity,
      sessionToken: result.session.token,
      expiresAt: result.session.expiresAt
    });
  } catch (error) {
    if (error instanceof AccountAccessError) {
      response.status(401).json({ error: error.code, message: error.message });
      return;
    }

    throw error;
  }
}

// Legacy POST /api/identity/signin handler removed in migration step 5.
// The production browser portal authenticates via the client-signed
// challenge flow (handleIdentityChallenge + handleIdentitySessionFromChallenge
// above). Telemetry over a 24h+ window after migration step 4 (commit
// d8f639b) showed zero Mozilla/* user-agents on this route — only the
// smoke harness — so the route is gone.
//
// Going with it: the SigninBody type, the SUDO_DISABLE_LEGACY_SIGNIN
// kill-switch env, the [legacy-signin] structured log, the
// accountAccessProvider.unlockCredential method, and the /dev/signin
// alias. The dev_account_access table itself is left in schema.ts for
// one more release because /api/identity/signup and /api/identity/recover
// still write/read it; a follow-up commit can drop the table once
// those two also move to client-key flows.

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
    response.status(400).json({ error: "invalid_canonical_id", message: "canonical_id is required" });
    return;
  }
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
    response.status(400).json({ error: "invalid_payload", message: "canonical_id, nonce, and signature are required" });
    return;
  }

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

function isStrongPassword(password: string): boolean {
  return (
    password.length >= 12
    && /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password)
  );
}

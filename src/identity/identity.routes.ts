import { Router } from "express";
import {
  registerIdentityDocument,
  resolveIdentityByCanonicalId,
  resolveIdentityByHandle,
  resolveIdentityFingerprintByCanonicalId
} from "./identity.service.js";
import {
  handleIdentityChallenge,
  handleIdentitySearch,
  handleIdentitySession,
  handleIdentitySessionFromChallenge
} from "./identity-auth.handlers.js";
import type { IdentityDocument } from "../protocol/types.js";
import { requireSignedRequest } from "./request-auth.js";
import { getIdentityBio, normalizeBio, setIdentityBio, MAX_BIO_LENGTH } from "./identity-bio.store.js";

export const identityRouter = Router();

// Canonical identity surface. Mounted BEFORE the /:canonicalId
// wildcard routes below so named routes don't get captured by the
// wildcard. POST /signup, POST /signin, and POST /recover were all
// removed in migration steps 5 and 6 — every account is client-key
// only and authenticates via the challenge flow.
identityRouter.get("/session", handleIdentitySession);
identityRouter.get("/search", handleIdentitySearch);
// Client-signed session bootstrap. Both routes must sit before
// the /:canonicalId wildcard below or the GET would be captured.
identityRouter.get("/challenge/:canonicalId", handleIdentityChallenge);
identityRouter.post("/session-from-challenge", handleIdentitySessionFromChallenge);

identityRouter.post("/register", (request, response) => {
  try {
    const body = request.body as { identity_document?: unknown };
    if (typeof body.identity_document !== "object" || body.identity_document === null) {
      response.status(400).json({ error: "invalid_identity_document" });
      return;
    }

    const identity = registerIdentityDocument(body.identity_document as IdentityDocument);
    response.status(201).json({ ok: true, identity });
  } catch (error) {
    const message = error instanceof Error ? error.message : "identity registration failed";
    const status = message.includes("invalid identity signature") || message.includes("canonical id") ? 400 : 409;
    response.status(status).json({ ok: false, error: "identity_registration_failed", message });
  }
});

identityRouter.get("/handles/:handle", (request, response) => {
  try {
    const identity = resolveIdentityByHandle(request.params.handle);
    if (!identity) {
      response.status(404).json({ error: "handle_not_found" });
      return;
    }

    response.json(identity.document);
  } catch {
    response.status(400).json({ error: "invalid_handle" });
  }
});

identityRouter.get("/profiles/:canonicalId", (request, response) => {
  const identity = resolveIdentityByCanonicalId(request.params.canonicalId);
  if (!identity) {
    response.status(404).json({ error: "profile_not_found" });
    return;
  }

  // Phase 14B: include the optional short bio. It's stored separately
  // from the signed identity document so users can edit it without
  // re-signing the whole identity.
  const bio = getIdentityBio(identity.document.canonical_id);
  response.json({ ...identity.document, bio });
});

// Phase 14B: POST /api/identity/bio sets the caller's short bio.
// Identity-signed (`bodyOwnerField: "canonical_id"` cross-check).
// Server normalizes (strip control chars, truncate to 280) and stores.
identityRouter.post("/bio", requireSignedRequest({
  kind: "identity",
  bodyOwnerField: "canonical_id"
}), (request, response) => {
  const body = request.body as { canonical_id?: unknown; bio?: unknown };
  if (typeof body.canonical_id !== "string") {
    response.status(400).json({ ok: false, error: "invalid_canonical_id" });
    return;
  }
  if (resolveIdentityByCanonicalId(body.canonical_id) === null) {
    response.status(404).json({ ok: false, error: "identity_not_found" });
    return;
  }
  const normalized = normalizeBio(body.bio);
  setIdentityBio(body.canonical_id, normalized);
  response.json({ ok: true, bio: normalized, max_length: MAX_BIO_LENGTH });
});

identityRouter.get("/:canonicalId/fingerprint", (request, response) => {
  const fingerprint = resolveIdentityFingerprintByCanonicalId(request.params.canonicalId);
  if (fingerprint === null) {
    response.status(404).json({ error: "identity_not_found" });
    return;
  }

  response.json(fingerprint);
});

identityRouter.get("/:canonicalId", (request, response) => {
  const identity = resolveIdentityByCanonicalId(request.params.canonicalId);
  if (!identity) {
    response.status(404).json({ error: "identity_not_found" });
    return;
  }

  response.json(identity.document);
});

import { Router } from "express";
import {
  registerIdentityDocument,
  resolveIdentityByCanonicalId,
  resolveIdentityByHandle,
  resolveIdentityFingerprintByCanonicalId
} from "./identity.service.js";
import {
  handleIdentityChallenge,
  handleIdentityRecover,
  handleIdentitySearch,
  handleIdentitySession,
  handleIdentitySessionFromChallenge,
  handleIdentitySignin,
  handleIdentitySignup
} from "./identity-auth.handlers.js";
import type { IdentityDocument } from "../protocol/types.js";

export const identityRouter = Router();

// Canonical auth + search surface. These are mounted BEFORE the
// /:canonicalId wildcard routes below so /signup, /signin, etc. don't
// get captured by the wildcard. Same handlers back the deprecated
// /dev/* aliases in src/routes/dev.ts.
identityRouter.post("/signup", handleIdentitySignup);
identityRouter.post("/signin", handleIdentitySignin);
identityRouter.post("/recover", handleIdentityRecover);
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

  response.json(identity.document);
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

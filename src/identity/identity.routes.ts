import { Router } from "express";
import {
  registerIdentityDocument,
  resolveIdentityByCanonicalId,
  resolveIdentityByHandle,
  resolveIdentityFingerprintByCanonicalId
} from "./identity.service.js";
import type { IdentityDocument } from "../protocol/types.js";

export const identityRouter = Router();

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

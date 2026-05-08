import { Router } from "express";
import {
  resolveIdentityByCanonicalId,
  resolveIdentityByHandle,
  resolveIdentityFingerprintByCanonicalId
} from "./identity.service.js";

export const identityRouter = Router();

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

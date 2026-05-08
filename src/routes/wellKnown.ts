import { Router } from "express";
import { generateIdentityGrid } from "../crypto/index.js";
import { getIdentityByHandle, normalizeHandle } from "../identity/registry.js";
import { getNodeCapabilityDocument } from "../node/node.service.js";

export const wellKnownRouter = Router();

wellKnownRouter.get("/.well-known/handles/:handle", (request, response) => {
  try {
    normalizeHandle(request.params.handle);
  } catch {
    response.status(400).json({ error: "invalid_handle" });
    return;
  }

  const identity = getIdentityByHandle(request.params.handle);

  if (!identity) {
    response.status(404).json({ error: "handle_not_found" });
    return;
  }

  response.json({
    ...identity.document,
    canonical_id: identity.canonicalId,
    identity_url: `/api/identity/${encodeURIComponent(identity.canonicalId)}`,
    public_keys: identity.document.keys,
    visual_fingerprint: generateIdentityGrid(identity.document.keys.identity.public_key),
    signature: identity.document.signature
  });
});

wellKnownRouter.get("/.well-known/sudo/node.json", (_request, response) => {
  response.json(getNodeCapabilityDocument());
});

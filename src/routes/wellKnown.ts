import { Router } from "express";
import { getIdentityByHandle, normalizeHandle } from "../registry.js";

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

  response.json(identity.document);
});

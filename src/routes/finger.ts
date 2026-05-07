import { Router } from "express";
import { fingerprintPublicKey, verifyIdentityDocument } from "../crypto.js";
import { getIdentityByHandle, normalizeHandle } from "../registry.js";

export const fingerRouter = Router();

fingerRouter.get("/finger/:handle", (request, response) => {
  try {
    normalizeHandle(request.params.handle);
  } catch {
    response.status(400).type("text/plain").send("sudo: invalid handle\n");
    return;
  }

  const identity = getIdentityByHandle(request.params.handle);

  if (!identity) {
    response.status(404).type("text/plain").send("sudo: handle not found\n");
    return;
  }

  const fingerprint = fingerprintPublicKey(identity.document.public_key);
  const signatureState = verifyIdentityDocument(identity.document) ? "valid" : "invalid";

  response.type("text/plain").send(`Login: ${identity.document.handle}
Canonical: ${identity.document.canonical}
Key: sha256:${fingerprint}
Signature: ${signatureState}
Updated: ${identity.document.updated_at}
Profile: ${identity.document.profile}
Inbox: ${identity.document.inbox}

Plan:
  text-first identity, Tor-first transport, encrypted messages only

Note:
  registry == discovery, not trust
  trust == public keys + signatures + key continuity
`);
});

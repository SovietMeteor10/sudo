import { Router } from "express";
import { fingerprintPublicKey, verifyIdentityDocument } from "../crypto/index.js";
import { getIdentityByHandle, normalizeHandle } from "../identity/registry.js";

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

  const fingerprint = fingerprintPublicKey(identity.document.keys.identity.public_key);
  const signatureState = verifyIdentityDocument(identity.document) ? "valid" : "invalid";

  response.type("text/plain").send(`Login: ${identity.document.handle}
Canonical: ${identity.document.canonical_id}
Key: sha256:${fingerprint}
Signature: ${signatureState}
Updated: ${identity.document.updated_at}
Home: ${identity.document.home_node}
Profile: ${identity.document.profile ?? `/u/${identity.document.canonical_id}`}
Inbox: ${identity.document.inbox ?? `/inbox/${identity.document.canonical_id}`}

Plan:
  text-first identity, Tor-first transport, encrypted messages only

Note:
  registry == discovery, not trust
  trust == public keys + signatures + key continuity
`);
});

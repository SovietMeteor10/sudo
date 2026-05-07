import { Router } from "express";
import { fingerprintPublicKey, verifyIdentityDocument } from "../crypto.js";
import { getIdentityByCanonicalId } from "../registry.js";

export const profileRouter = Router();

profileRouter.get("/u/:canonicalId", (request, response) => {
  const identity = getIdentityByCanonicalId(request.params.canonicalId);

  if (!identity) {
    response.status(404).type("text/plain").send("sudo: profile not found\n");
    return;
  }

  const fingerprint = fingerprintPublicKey(identity.document.public_key);
  const signatureState = verifyIdentityDocument(identity.document) ? "valid" : "invalid";

  response.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(identity.document.handle)} / sudo</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      max-width: 78ch;
      margin: 2rem auto;
      padding: 0 1rem;
      font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    a { color: inherit; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
<pre>sudo identity
=============

handle:      ${escapeHtml(identity.document.handle)}
canonical:   ${escapeHtml(identity.document.canonical)}
key:         sha256:${fingerprint}
signature:   ${signatureState}
updated:     ${escapeHtml(identity.document.updated_at)}

profile:     ${escapeHtml(identity.document.profile)}
finger:      ${escapeHtml(identity.document.finger)}
inbox:       ${escapeHtml(identity.document.inbox)}

Registry entries are discovery hints. Trust this identity only after
verifying key continuity and signed identity documents over time.
</pre>
</body>
</html>`);
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

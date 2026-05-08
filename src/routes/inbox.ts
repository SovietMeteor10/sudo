import { Router } from "express";
import { deliverRelayEnvelope, listRelayEnvelopes } from "../relay/relay.service.js";
import type { LegacyEncryptedMessageEnvelope } from "../relay/relay.types.js";

export const inboxRouter = Router();

type MessageRequest = {
  from?: unknown;
  ciphertext?: unknown;
  nonce?: unknown;
  signature?: unknown;
};

inboxRouter.post("/inbox/:canonicalId", (request, response) => {
  const body = request.body as MessageRequest;
  if (
    typeof body.from !== "string" ||
    typeof body.ciphertext !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.signature !== "string"
  ) {
    response.status(400).json({ error: "encrypted_blob_required" });
    return;
  }

  const result = deliverRelayEnvelope(request.params.canonicalId, {
    from: body.from,
    ciphertext: body.ciphertext,
    nonce: body.nonce,
    signature: body.signature
  } satisfies LegacyEncryptedMessageEnvelope);

  if (result.status === "recipient_not_found") {
    response.status(404).json({ error: "inbox_not_found" });
    return;
  }

  response.status(202).json({ ok: true });
});

inboxRouter.get("/inbox/:canonicalId", (request, response) => {
  const messages = listRelayEnvelopes(request.params.canonicalId);

  if (messages === null) {
    response.status(404).json({ error: "inbox_not_found" });
    return;
  }

  // UNSAFE DEV-ONLY ENDPOINT: useful for local message flow testing.
  // A real deployment should authenticate the recipient and return ciphertext
  // only over their private retrieval channel.
  response.json({
    warning: "unsafe_dev_only_ciphertext_listing",
    messages
  });
});

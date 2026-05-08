import { Router } from "express";
import {
  ackStoredRelayEnvelope,
  expireStoredRelayEnvelopes,
  listRecipientRelayInbox,
  setRelayRelationship,
  submitRelayEnvelope
} from "./relay.service.js";
import type { RelayTier } from "./relay.types.js";

export const relayRouter = Router();

relayRouter.post("/envelopes", (request, response) => {
  const result = submitRelayEnvelope(request.body);
  response.status(result.ok ? 202 : relayErrorStatus(result.error)).json(result);
});

relayRouter.get("/inbox/:canonicalId", (request, response) => {
  // DEV ONLY: recipient authentication is not implemented yet. Production
  // relay retrieval must require recipient-device authentication, and clients
  // should ACK only after durable local save.
  response.json({
    warning: "unsafe_dev_only_ciphertext_listing",
    envelopes: listRecipientRelayInbox(request.params.canonicalId)
  });
});

relayRouter.post("/envelopes/:messageId/ack", (request, response) => {
  // DEV ONLY: the server cannot verify durable local recipient save yet.
  // Recipient devices should only call this after persisting the ciphertext.
  const result = ackStoredRelayEnvelope(request.params.messageId);
  if (!result.ok) {
    response.status(404).json({ ok: false, error: result.error });
    return;
  }

  response.json({ ok: true, status: "acked" });
});

relayRouter.post("/relationships", (request, response) => {
  const body = request.body as {
    sender_canonical_id?: unknown;
    recipient_canonical_id?: unknown;
    tier?: unknown;
  };

  if (
    typeof body.sender_canonical_id !== "string" ||
    typeof body.recipient_canonical_id !== "string" ||
    !isRelayTier(body.tier)
  ) {
    response.status(400).json({ ok: false, error: "invalid_relationship" });
    return;
  }

  response.json({
    ok: true,
    relationship: setRelayRelationship(
      body.sender_canonical_id,
      body.recipient_canonical_id,
      body.tier
    )
  });
});

relayRouter.post("/expire", (_request, response) => {
  // DEV/admin route for local maintenance until a proper job runner exists.
  response.json({ ok: true, ...expireStoredRelayEnvelopes() });
});

function isRelayTier(value: unknown): value is RelayTier {
  return value === "known" || value === "unknown" || value === "blocked";
}

function relayErrorStatus(error: string): number {
  if (error === "invalid_envelope") return 400;
  if (error === "duplicate_message") return 409;
  if (error === "expired") return 410;
  return 429;
}

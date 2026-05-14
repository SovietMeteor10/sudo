import type { Request, Response } from "express";
import { Router } from "express";
import { readNodeRuntimeConfig } from "../node/node.config.js";
import {
  ackStoredRelayEnvelope,
  expireStoredRelayEnvelopes,
  listRecipientRelayInbox,
  setRelayRelationship,
  submitRelayEnvelope
} from "./relay.service.js";
import { getRelayEnvelopeRecipient } from "./relay.store.js";
import type { RelayTier } from "./relay.types.js";
import { requireSignedRequest } from "../identity/request-auth.js";

export const relayRouter = Router();

// Phase 11.5: per-minute send rate limits on /api/relay/envelopes.
// One bucket per (sender_canonical_id) and one per IP. Returns 429
// with a stable error code so the client can render specific copy
// instead of the user-hostile "unknown_quota_exceeded" surface that
// the per-pair count cap used to throw. In-memory state; resets on
// process restart, which matches the media-route limiter behavior.
const RELAY_RATE_WINDOW_MS = 60_000;
const relayHitsBySender = new Map<string, number[]>();
const relayHitsByIp = new Map<string, number[]>();
function relayRateCheck(buckets: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  if (key.length === 0) return true; // missing key = no per-key cap, fall through
  const hits = buckets.get(key) ?? [];
  const cutoff = now - RELAY_RATE_WINDOW_MS;
  const fresh = hits.filter((t) => t > cutoff);
  if (fresh.length >= limit) {
    buckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return true;
}
// Phase 14 MED-2: only honor X-Real-IP when the peer is loopback.
import { resolveTrustedIp as resolveRelayIp } from "../node/trusted-ip.js";

relayRouter.post("/envelopes", (request, response) => {
  const config = readNodeRuntimeConfig();
  const body = request.body as { sender_canonical_id?: unknown };
  const senderId = typeof body?.sender_canonical_id === "string" ? body.sender_canonical_id : "";
  const ip = resolveRelayIp(request);
  const now = Date.now();
  if (!relayRateCheck(relayHitsBySender, senderId, config.relayPerMinuteRateSender, now)) {
    response.status(429).json({
      ok: false,
      error: "rate_limited",
      scope: "sender",
      retry_after_seconds: 60
    });
    return;
  }
  if (!relayRateCheck(relayHitsByIp, ip, config.relayPerMinuteRateIp, now)) {
    response.status(429).json({
      ok: false,
      error: "rate_limited",
      scope: "ip",
      retry_after_seconds: 60
    });
    return;
  }
  const result = submitRelayEnvelope(request.body);
  response.status(result.ok ? 202 : relayErrorStatus(result.error)).json(result);
});

// Phase 11.5: smoke-only reset for the relay rate limiters. Gated
// to development by the route file's own readNodeRuntimeConfig check.
export function __resetRelayRateLimitsForTests(): void {
  relayHitsBySender.clear();
  relayHitsByIp.clear();
}

// Operator inspection: current bucket sizes (count of pending hits
// per identifier in the current window). Used by the dev
// diagnostics page; never exposes ciphertext or message bodies.
export function snapshotRelayRateLimits(): { sender_buckets: number; ip_buckets: number } {
  return {
    sender_buckets: relayHitsBySender.size,
    ip_buckets: relayHitsByIp.size
  };
}

// Phase 14 CRIT-2: recipient-device must prove possession of its
// device key to read the pending inbox. Previously any anonymous
// caller could enumerate {message_id, sender_canonical_id,
// sender_handle, created_at, ciphertext} for any user — the warning
// string was advisory only.
relayRouter.get("/inbox/:canonicalId", requireSignedRequest({
  kind: "device",
  urlOwnerParam: "canonicalId"
}), (request, response) => {
  response.json({
    envelopes: listRecipientRelayInbox(request.params.canonicalId)
  });
});

// Phase 14 CRIT-3: recipient-device must prove possession of its
// device key to ack (and thereby destroy) a queued envelope.
// Previously any caller knowing a message_id could redact-delete it
// — combined with the unauth inbox listing, that was a total
// message-delivery DoS primitive for any user.
//
// The middleware only verifies the signer; we additionally check the
// envelope's recipient_canonical_id matches the signer's
// canonical_id, since the message_id alone doesn't establish the
// signer-as-recipient relationship.
relayRouter.post("/envelopes/:messageId/ack", requireSignedRequest({
  kind: "device"
}), (request, response) => {
  const messageId = request.params.messageId;
  const recipientCanonical = getRelayEnvelopeRecipient(messageId);
  if (recipientCanonical === null) {
    response.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  if (recipientCanonical !== request.authenticatedCanonicalId) {
    response.status(403).json({ ok: false, error: "not_recipient" });
    return;
  }
  const result = ackStoredRelayEnvelope(messageId);
  if (!result.ok) {
    response.status(404).json({ ok: false, error: result.error });
    return;
  }
  response.json({ ok: true, status: "acked" });
});

// Phase 14 CRIT-4: relay-tier writes require a per-request signature
// from the sender (the canonical_id whose tier is being set). Previously
// any anonymous caller could set tier="blocked" between two arbitrary
// users to silently DoS message delivery, or "known" to abuse the
// expanded relay quota against a victim.
relayRouter.post("/relationships", requireSignedRequest({
  kind: "identity",
  bodyOwnerField: "sender_canonical_id"
}), (request, response) => {
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
  // Phase 14 platform slice: this route was previously labeled "DEV/admin"
  // in a comment but had no production gate. Production cron handles
  // retention via src/relay/relay.retention.ts on a timer — the
  // operator-triggered endpoint is dev-only.
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("not found\n");
    return;
  }
  response.json({ ok: true, ...expireStoredRelayEnvelopes() });
});

function isRelayTier(value: unknown): value is RelayTier {
  return value === "known" || value === "unknown" || value === "blocked";
}

function relayErrorStatus(error: string): number {
  if (error === "invalid_envelope") return 400;
  if (error === "missing_signature") return 400;
  if (error === "duplicate_message") return 409;
  if (error === "expired") return 410;
  return 429;
}

// Expose for the response so the dev diagnostics route can mount
// the reset hook. Wire is set up in routes/dev.ts.
export { Response };

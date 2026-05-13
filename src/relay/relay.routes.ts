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
import type { RelayTier } from "./relay.types.js";

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
function resolveRelayIp(request: Request): string {
  const real = request.get("x-real-ip");
  if (typeof real === "string" && real.length > 0) return real;
  return request.ip ?? "";
}

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

// Expose for the response so the dev diagnostics route can mount
// the reset hook. Wire is set up in routes/dev.ts.
export { Response };

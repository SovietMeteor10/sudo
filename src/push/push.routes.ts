// /api/push HTTP surface.
//
//   GET    /api/push/vapid-public-key
//     -> { public_key }
//     Public — the VAPID public key is meant to be served to anyone
//     who wants to subscribe.
//
//   POST   /api/push/subscriptions
//     body: { owner_canonical_id, device_id, endpoint, p256dh, auth }
//     -> { ok: true }
//     Upsert on (device_id, endpoint). Idempotent; the same browser
//     re-registering produces no row growth.
//
//   DELETE /api/push/subscriptions
//     body: { device_id, endpoint }
//     -> { ok: true, deleted }
//     Used by the client during reset-this-device + sign-out.
//
//   POST   /api/push/test                                 (dev only)
//     body: { recipient_canonical_id, sender_handle?, unread_count? }
//     -> { ok: true, stats }
//     Smoke-only entry to force a fan-out without sending an envelope.
//     Gated on SUDO_LOCAL_DEV / NODE_ENV !== production.

import express from "express";
import { emitRateLimited } from "../devices/rate-limit-response.js";
import {
  isBoundedString,
  isCanonicalId,
  isDeviceId,
  isFiniteInt,
  isNonEmptyString,
  makeBadRequest
} from "../protocol/validators.js";
import { getPublicVapidKey } from "./push.config.js";
import { checkPushSubscriptionRate } from "./push.rate-limit.js";
import {
  deletePushSubscriptionByDeviceAndEndpoint,
  upsertPushSubscription
} from "./push.store.js";
import { buildPushPayload, notifyEnvelopeRecipient, setStubStatusForTests } from "./push.service.js";
import { requireSignedRequest } from "../identity/request-auth.js";
import { validatePushEndpoint } from "./endpoint-validation.js";

export const pushRouter = express.Router();

// Phase 14 MED-2: X-Real-IP is only honored when the request arrived
// from loopback (i.e. behind nginx). See src/node/trusted-ip.ts.
import { resolveTrustedIp as resolveRemoteIp } from "../node/trusted-ip.js";

pushRouter.get("/vapid-public-key", (_request, response) => {
  response.json({ public_key: getPublicVapidKey() });
});

// Phase 14 CRIT-5: push subscriptions are now signature-gated AND the
// endpoint URL is validated against a private-IP blocklist. Previously
// an unauthenticated caller could (a) register a subscription for a
// victim's owner_canonical_id pointing at attacker-controlled
// infrastructure (live traffic-analysis oracle), and (b) point the
// endpoint at internal addresses for SSRF. The signature requirement
// closes (a); the address validator closes (b).
pushRouter.post("/subscriptions", requireSignedRequest({
  kind: "identity",
  bodyOwnerField: "owner_canonical_id"
}), async (request, response) => {
  const body = request.body as Partial<{
    owner_canonical_id: string;
    device_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
  const rateResult = checkPushSubscriptionRate(resolveRemoteIp(request), body.owner_canonical_id ?? null);
  if (!rateResult.ok) { emitRateLimited(response, rateResult); return; }
  if (!isDeviceId(body?.device_id)) {
    response.status(400).json(makeBadRequest("device_id", "must be a 32-hex device id"));
    return;
  }
  if (!isNonEmptyString(body?.endpoint, 2048) || !/^https?:\/\//i.test(body!.endpoint!)) {
    response.status(400).json(makeBadRequest("endpoint", "must be an http(s) URL"));
    return;
  }
  const endpointCheck = await validatePushEndpoint(body!.endpoint!);
  if (!endpointCheck.ok) {
    response.status(400).json({
      ok: false,
      error: "invalid_endpoint",
      reason: endpointCheck.reason,
      message: `push endpoint rejected: ${endpointCheck.reason}`
    });
    return;
  }
  if (!isNonEmptyString(body?.p256dh, 256)) {
    response.status(400).json(makeBadRequest("p256dh", "must be a non-empty base64url string"));
    return;
  }
  if (!isNonEmptyString(body?.auth, 64)) {
    response.status(400).json(makeBadRequest("auth", "must be a non-empty base64url string"));
    return;
  }
  upsertPushSubscription({
    owner_canonical_id: body.owner_canonical_id!,
    device_id: body.device_id!,
    endpoint: body.endpoint!,
    p256dh: body.p256dh!,
    auth: body.auth!
  });
  response.json({ ok: true });
});

// DELETE now also requires identity signature matching owner_canonical_id.
// Previously the route relied on "an attacker who knows your device_id +
// endpoint pair can already not affect any row" — but the audit observed
// that device_id is exposed via the unauth /api/devices/:owner listing
// (HIGH-5), so it's not a secret. Requiring sig closes the de-registration
// vector identified in MED-10.
pushRouter.delete("/subscriptions", requireSignedRequest({
  kind: "identity",
  bodyOwnerField: "owner_canonical_id"
}), (request, response) => {
  const body = request.body as Partial<{ owner_canonical_id: string; device_id: string; endpoint: string }>;
  if (!isDeviceId(body?.device_id)) {
    response.status(400).json(makeBadRequest("device_id", "must be a 32-hex device id"));
    return;
  }
  if (!isNonEmptyString(body?.endpoint, 2048)) {
    response.status(400).json(makeBadRequest("endpoint", "must be a non-empty URL"));
    return;
  }
  const rateResult = checkPushSubscriptionRate(resolveRemoteIp(request), body.owner_canonical_id ?? null);
  if (!rateResult.ok) { emitRateLimited(response, rateResult); return; }
  const deleted = deletePushSubscriptionByDeviceAndEndpoint(body!.device_id!, body!.endpoint!);
  response.json({ ok: true, deleted });
});

function isLocalDev(): boolean {
  return process.env.NODE_ENV !== "production"
    || process.env.SUDO_LOCAL_DEV === "1"
    || process.env.SUDO_LOCAL_DEV === "true";
}

pushRouter.post("/test", async (request, response) => {
  if (!isLocalDev()) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  const body = request.body as Partial<{
    recipient_canonical_id: string;
    sender_canonical_id: string;
    sender_handle: string;
    unread_count: number;
    stub_status: number;
    echo_payload: boolean;
  }>;
  if (!isCanonicalId(body?.recipient_canonical_id)) {
    response.status(400).json(makeBadRequest("recipient_canonical_id", "must be a canonical id"));
    return;
  }
  if (body?.sender_canonical_id !== undefined && !isCanonicalId(body.sender_canonical_id)) {
    response.status(400).json(makeBadRequest("sender_canonical_id", "must be a canonical id"));
    return;
  }
  if (body?.unread_count !== undefined && !isFiniteInt(body.unread_count, { min: 0, max: 1_000_000 })) {
    response.status(400).json(makeBadRequest("unread_count", "must be a non-negative integer"));
    return;
  }
  if (body?.sender_handle !== undefined && !isBoundedString(body.sender_handle, 64)) {
    response.status(400).json(makeBadRequest("sender_handle", "must be ≤ 64 chars"));
    return;
  }
  // dev-only echo mode: returns the exact JSON payload the server
  // would have dispatched to the push provider, without sending it.
  // Used by smoke:disappearing-notification-privacy to assert the
  // payload contains no message-body bytes.
  if (body.echo_payload === true) {
    const payload = buildPushPayload({
      conversationHint: typeof body.sender_canonical_id === "string" ? body.sender_canonical_id : "sudo:unknown",
      senderHandle: typeof body.sender_handle === "string" ? body.sender_handle : "someone",
      unreadCount: typeof body.unread_count === "number" ? body.unread_count : 1
    });
    response.json({ ok: true, payload });
    return;
  }
  // dev-only: a smoke can ask the service to short-circuit delivery
  // with a specific status code so we don't have to provision an
  // HTTPS push provider in CI. Reset after the call.
  if (typeof body.stub_status === "number") setStubStatusForTests(body.stub_status);
  try {
    const stats = await notifyEnvelopeRecipient({
      recipientCanonicalId: body.recipient_canonical_id,
      senderCanonicalId: typeof body.sender_canonical_id === "string" ? body.sender_canonical_id : "sudo:unknown",
      senderHandle: typeof body.sender_handle === "string" ? body.sender_handle : "someone",
      unreadCount: typeof body.unread_count === "number" ? body.unread_count : 1
    });
    response.json({ ok: true, stats });
  } finally {
    setStubStatusForTests(null);
  }
});

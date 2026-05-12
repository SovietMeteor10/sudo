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
import { getPublicVapidKey } from "./push.config.js";
import {
  deletePushSubscriptionByDeviceAndEndpoint,
  upsertPushSubscription
} from "./push.store.js";
import { buildPushPayload, notifyEnvelopeRecipient, setStubStatusForTests } from "./push.service.js";

export const pushRouter = express.Router();

pushRouter.get("/vapid-public-key", (_request, response) => {
  response.json({ public_key: getPublicVapidKey() });
});

pushRouter.post("/subscriptions", (request, response) => {
  const body = request.body as Partial<{
    owner_canonical_id: string;
    device_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>;
  if (
    typeof body?.owner_canonical_id !== "string" || !body.owner_canonical_id ||
    typeof body?.device_id !== "string" || !body.device_id ||
    typeof body?.endpoint !== "string" || !body.endpoint ||
    typeof body?.p256dh !== "string" || !body.p256dh ||
    typeof body?.auth !== "string" || !body.auth
  ) {
    response.status(400).json({ ok: false, error: "invalid_subscription" });
    return;
  }
  if (!/^https?:\/\//i.test(body.endpoint)) {
    response.status(400).json({ ok: false, error: "invalid_endpoint" });
    return;
  }
  upsertPushSubscription({
    owner_canonical_id: body.owner_canonical_id,
    device_id: body.device_id,
    endpoint: body.endpoint,
    p256dh: body.p256dh,
    auth: body.auth
  });
  response.json({ ok: true });
});

pushRouter.delete("/subscriptions", (request, response) => {
  const body = request.body as Partial<{ device_id: string; endpoint: string }>;
  if (typeof body?.device_id !== "string" || typeof body?.endpoint !== "string") {
    response.status(400).json({ ok: false, error: "invalid_payload" });
    return;
  }
  const deleted = deletePushSubscriptionByDeviceAndEndpoint(body.device_id, body.endpoint);
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
  if (typeof body?.recipient_canonical_id !== "string" || !body.recipient_canonical_id) {
    response.status(400).json({ ok: false, error: "missing_recipient" });
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

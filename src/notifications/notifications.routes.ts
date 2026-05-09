// Read-only social-notification surface. Today this only derives
// follow notifications from feed_subscriptions — connection requests
// are deliberately NOT a notification category. Dismissal is the
// recipient device's responsibility (kept in IndexedDB), so this
// route always returns the full incoming list and the client
// filters out anything it has dismissed.
//
// This is a single-node MVP shape. A federated future will move
// these to author-host pulls or push deliveries.

import { Router } from "express";
import { listIncomingFollowers } from "../connections/connections.store.js";
import type { SocialNotification } from "../protocol/types.js";

export const notificationsRouter = Router();

notificationsRouter.get("/incoming/:recipientCanonicalId", (request, response) => {
  const recipientCanonicalId = request.params.recipientCanonicalId;
  if (typeof recipientCanonicalId !== "string" || recipientCanonicalId.length === 0) {
    response.status(400).json({ ok: false, error: "invalid_recipient" });
    return;
  }

  const limitRaw = Number(request.query.limit ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 100;

  const followers = listIncomingFollowers(recipientCanonicalId, limit);

  const notifications: SocialNotification[] = [];
  for (const follower of followers) {
    if (follower.actor_canonical_id === recipientCanonicalId) continue;
    notifications.push({
      type: "sudo_social_notification",
      id: `follow:${follower.actor_canonical_id}`,
      kind: "follow",
      recipient_canonical_id: recipientCanonicalId,
      actor_canonical_id: follower.actor_canonical_id,
      actor_handle: follower.actor_handle,
      created_at: follower.created_at,
      updated_at: follower.updated_at
    });
  }

  // Newest first.
  notifications.sort((left, right) => right.created_at.localeCompare(left.created_at));

  response.json({ notifications });
});

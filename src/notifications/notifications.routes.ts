// Read-only social-notification surface. Derives notifications from
// existing canonical state — feed_subscriptions for follows,
// discovery_reactions for likes/dislikes, feed_posts for replies and
// reposts. No separate notifications table; dismissal is the
// recipient device's responsibility (kept in IndexedDB), so this
// route always returns the full incoming list and the client filters
// out anything it has dismissed.
//
// Stable ids per (kind, actor[, post]) so a re-vote doesn't
// duplicate the row and dismissal survives re-fetches. Self-actions
// are excluded at the SQL level.
//
// This is a single-node MVP shape. A federated future will move
// these to author-host pulls or push deliveries.

import { Router } from "express";
import { listIncomingFollowers } from "../connections/connections.store.js";
import {
  listIncomingMutualConnections,
  listIncomingReactionsOnAuthor,
  listIncomingRepliesToAuthor,
  listIncomingRepostsOfAuthor
} from "./notifications.store.js";
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

  const notifications: SocialNotification[] = [];

  // Mutual-connection confirmations. Computed first so the dedupe
  // below can suppress the redundant raw "follow" notification when
  // the relationship is already mutual: the user only needs the
  // upgraded "connected" row, not both.
  const mutualPeerIds = new Set<string>();
  for (const mutual of listIncomingMutualConnections(recipientCanonicalId, limit)) {
    if (mutual.actor_canonical_id === recipientCanonicalId) continue;
    mutualPeerIds.add(mutual.actor_canonical_id);
    notifications.push({
      type: "sudo_social_notification",
      id: `connection_confirmed:${mutual.actor_canonical_id}`,
      kind: "connection_confirmed",
      recipient_canonical_id: recipientCanonicalId,
      actor_canonical_id: mutual.actor_canonical_id,
      actor_handle: mutual.actor_handle,
      created_at: mutual.confirmed_at,
      updated_at: mutual.confirmed_at
    });
  }

  // Follow notifications. Suppressed for peers we've already mutually
  // confirmed — the connection_confirmed row above subsumes the raw
  // follow.
  for (const follower of listIncomingFollowers(recipientCanonicalId, limit)) {
    if (follower.actor_canonical_id === recipientCanonicalId) continue;
    if (mutualPeerIds.has(follower.actor_canonical_id)) continue;
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

  // Reaction notifications (likes / dislikes on the recipient's
  // posts). Stable id per (actor, post, reaction_kind) — toggling
  // the same vote on the same post does not duplicate the row.
  for (const reaction of listIncomingReactionsOnAuthor(recipientCanonicalId, limit)) {
    if (reaction.actor_canonical_id === recipientCanonicalId) continue;
    const kind = reaction.reaction === "recommend" ? "reaction_recommend" : "reaction_downrank";
    const idPrefix = reaction.reaction === "recommend" ? "recommend" : "downrank";
    notifications.push({
      type: "sudo_social_notification",
      id: `${idPrefix}:${reaction.actor_canonical_id}:${reaction.post_id}`,
      kind,
      recipient_canonical_id: recipientCanonicalId,
      actor_canonical_id: reaction.actor_canonical_id,
      actor_handle: reaction.actor_handle,
      post_id: reaction.post_id,
      parent_post_id: reaction.post_id,
      created_at: reaction.created_at,
      updated_at: reaction.created_at
    });
  }

  // Reply notifications. The "view" target is the reply itself so
  // the thread view shows it in context with the original parent
  // above. parent_post_id holds the recipient's own post.
  for (const reply of listIncomingRepliesToAuthor(recipientCanonicalId, limit)) {
    if (reply.actor_canonical_id === recipientCanonicalId) continue;
    notifications.push({
      type: "sudo_social_notification",
      id: `reply:${reply.actor_canonical_id}:${reply.reply_post_id}`,
      kind: "reply",
      recipient_canonical_id: recipientCanonicalId,
      actor_canonical_id: reply.actor_canonical_id,
      actor_handle: reply.actor_handle,
      post_id: reply.reply_post_id,
      parent_post_id: reply.parent_post_id,
      created_at: reply.created_at,
      updated_at: reply.updated_at
    });
  }

  // Repost notifications. View opens the repost (which in the
  // thread view embeds the original).
  for (const repost of listIncomingRepostsOfAuthor(recipientCanonicalId, limit)) {
    if (repost.actor_canonical_id === recipientCanonicalId) continue;
    notifications.push({
      type: "sudo_social_notification",
      id: `repost:${repost.actor_canonical_id}:${repost.repost_post_id}`,
      kind: "repost",
      recipient_canonical_id: recipientCanonicalId,
      actor_canonical_id: repost.actor_canonical_id,
      actor_handle: repost.actor_handle,
      post_id: repost.repost_post_id,
      parent_post_id: repost.original_post_id,
      created_at: repost.created_at,
      updated_at: repost.updated_at
    });
  }

  // Newest first.
  notifications.sort((left, right) => right.created_at.localeCompare(left.created_at));

  response.json({ notifications });
});

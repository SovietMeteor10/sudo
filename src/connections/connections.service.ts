import { getIdentityByCanonicalId } from "../identity/identity.store.js";
import type { ConnectionRelationship, ConnectionTier, FeedSubscription } from "../protocol/types.js";
import { ConnectionError, type UpsertConnectionInput, type UpsertSubscriptionInput } from "./connections.types.js";
import {
  connectionTierToRelayTier,
  deleteConnectionRelationship,
  deleteFeedSubscription,
  getConnectionEffectiveTier,
  getConnectionRelationship,
  getFeedSubscription,
  listConnectionRelationships,
  listFeedSubscriptions,
  setFeedSubscription,
  upsertConnectionRelationship
} from "./connections.store.js";

export function upsertConnection(input: UpsertConnectionInput): {
  relationship: ConnectionRelationship;
  subscription?: FeedSubscription | null;
} {
  validateOwnerAndSubject(input.owner_canonical_id, input.subject_canonical_id);
  const subject = getIdentityByCanonicalId(input.subject_canonical_id);
  const subjectHandle = input.subject_handle ?? subject?.document.handle;
  const notes = input.notes;

  const relationship = upsertConnectionRelationship(
    input.owner_canonical_id,
    input.subject_canonical_id,
    input.tier,
    input.subscribed ?? (input.tier === "close" || input.tier === "known"),
    subjectHandle,
    notes
  );

  let subscription: FeedSubscription | null = null;
  if (input.tier === "unknown") {
    deleteFeedSubscription(input.owner_canonical_id, input.subject_canonical_id);
  } else if (input.tier === "blocked") {
    deleteFeedSubscription(input.owner_canonical_id, input.subject_canonical_id);
  } else {
    subscription = setFeedSubscription(
      input.owner_canonical_id,
      input.subject_canonical_id,
      subjectHandle,
      true,
      true,
      input.tier === "close",
      false
    );
  }

  return {
    relationship,
    subscription
  };
}

export function getConnection(ownerCanonicalId: string, subjectCanonicalId: string): ConnectionRelationship {
  const relationship = getConnectionRelationship(ownerCanonicalId, subjectCanonicalId);
  if (relationship === null) {
    return {
      type: "sudo_connection_relationship",
      owner_canonical_id: ownerCanonicalId,
      subject_canonical_id: subjectCanonicalId,
      tier: "unknown",
      subscribed: false,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    };
  }

  return relationship;
}

export function listConnections(ownerCanonicalId: string, tier?: ConnectionTier): ConnectionRelationship[] {
  return listConnectionRelationships(ownerCanonicalId, tier);
}

export function removeConnection(ownerCanonicalId: string, subjectCanonicalId: string): boolean {
  // Removing a connection is intentionally NOT destructive to a
  // separately-held feed subscription. The connection axis (trust
  // tier) and the follow axis (subscription) are independent in the
  // UI, so dropping a connection must not silently unfollow the
  // subject. If the user wants to fully cut ties they unfollow
  // explicitly. block/unblock still clears the subscription via
  // upsertConnection's tier="blocked" branch — that path is unchanged.
  return deleteConnectionRelationship(ownerCanonicalId, subjectCanonicalId);
}

export function getSubscription(ownerCanonicalId: string, authorCanonicalId: string): FeedSubscription | null {
  return getFeedSubscription(ownerCanonicalId, authorCanonicalId);
}

export function upsertSubscription(input: UpsertSubscriptionInput): FeedSubscription {
  validateOwnerAndSubject(input.owner_canonical_id, input.author_canonical_id);

  const connection = getConnectionRelationship(input.owner_canonical_id, input.author_canonical_id);
  if (connection?.tier === "blocked") {
    throw new ConnectionError("blocked_relationship", "blocked authors cannot be subscribed", 409);
  }

  const author = getIdentityByCanonicalId(input.author_canonical_id);
  return setFeedSubscription(
    input.owner_canonical_id,
    input.author_canonical_id,
    input.author_handle ?? author?.document.handle,
    input.include_public ?? true,
    input.include_connections ?? true,
    input.include_close ?? (connection?.tier === "close"),
    input.muted ?? false
  );
}

export function listSubscriptions(ownerCanonicalId: string): FeedSubscription[] {
  return listFeedSubscriptions(ownerCanonicalId);
}

export function removeSubscription(ownerCanonicalId: string, authorCanonicalId: string): boolean {
  return deleteFeedSubscription(ownerCanonicalId, authorCanonicalId);
}

export function getEffectiveRelayTier(senderCanonicalId: string, recipientCanonicalId: string) {
  return connectionTierToRelayTier(getConnectionEffectiveTier(recipientCanonicalId, senderCanonicalId));
}

function validateOwnerAndSubject(ownerCanonicalId: string, subjectCanonicalId: string): void {
  if (ownerCanonicalId.length === 0 || subjectCanonicalId.length === 0) {
    throw new ConnectionError("invalid_relationship", "owner and subject are required");
  }
}

import { db } from "../storage/db.js";
import type { ConnectionRelationship, ConnectionTier, FeedSubscription } from "../protocol/types.js";
import type { RelayTier } from "../relay/relay.types.js";

type ConnectionRow = {
  owner_canonical_id: string;
  subject_canonical_id: string;
  subject_handle: string | null;
  tier: ConnectionTier;
  subscribed: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type SubscriptionRow = {
  owner_canonical_id: string;
  author_canonical_id: string;
  author_handle: string | null;
  include_public: number;
  include_connections: number;
  include_close: number;
  muted: number;
  created_at: string;
  updated_at: string;
};

export function upsertConnectionRelationship(
  ownerCanonicalId: string,
  subjectCanonicalId: string,
  tier: ConnectionTier,
  subscribed: boolean,
  subjectHandle: string | undefined,
  notes: string | undefined,
  now = new Date()
): ConnectionRelationship {
  const existing = getConnectionRelationship(ownerCanonicalId, subjectCanonicalId);
  const createdAt = existing === null ? now.toISOString() : existing.created_at;
  const updatedAt = now.toISOString();
  const effectiveSubscribed = tier === "blocked" ? false : tier === "close" ? true : subscribed;

  if (tier === "unknown") {
    db.prepare(`
      DELETE FROM connections
      WHERE owner_canonical_id = ? AND subject_canonical_id = ?
    `).run(ownerCanonicalId, subjectCanonicalId);
    db.prepare(`
      DELETE FROM relay_relationships
      WHERE sender_canonical_id = ? AND recipient_canonical_id = ?
    `).run(subjectCanonicalId, ownerCanonicalId);
    return {
      type: "sudo_connection_relationship",
      owner_canonical_id: ownerCanonicalId,
      subject_canonical_id: subjectCanonicalId,
      subject_handle: subjectHandle,
      tier: "unknown",
      subscribed: false,
      created_at: createdAt,
      updated_at: updatedAt,
      notes
    };
  }

  db.prepare(`
    INSERT INTO connections (
      owner_canonical_id,
      subject_canonical_id,
      subject_handle,
      tier,
      subscribed,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_canonical_id, subject_canonical_id)
    DO UPDATE SET
      subject_handle = excluded.subject_handle,
      tier = excluded.tier,
      subscribed = excluded.subscribed,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    ownerCanonicalId,
    subjectCanonicalId,
    subjectHandle ?? null,
    tier,
    effectiveSubscribed ? 1 : 0,
    notes ?? null,
    createdAt,
    updatedAt
  );

  upsertLegacyRelayRelationship(subjectCanonicalId, ownerCanonicalId, tierToRelayTier(tier), now);

  return {
    type: "sudo_connection_relationship",
    owner_canonical_id: ownerCanonicalId,
    subject_canonical_id: subjectCanonicalId,
    subject_handle: subjectHandle,
    tier,
    subscribed: effectiveSubscribed,
    created_at: createdAt,
    updated_at: updatedAt,
    notes
  };
}

export function deleteConnectionRelationship(
  ownerCanonicalId: string,
  subjectCanonicalId: string
): boolean {
  const result = db.prepare(`
    DELETE FROM connections
    WHERE owner_canonical_id = ? AND subject_canonical_id = ?
  `).run(ownerCanonicalId, subjectCanonicalId);

  db.prepare(`
    DELETE FROM relay_relationships
    WHERE sender_canonical_id = ? AND recipient_canonical_id = ?
  `).run(subjectCanonicalId, ownerCanonicalId);

  return result.changes > 0;
}

export function getConnectionRelationship(
  ownerCanonicalId: string,
  subjectCanonicalId: string
): ConnectionRelationship | null {
  const row = db.prepare(`
    SELECT *
    FROM connections
    WHERE owner_canonical_id = ? AND subject_canonical_id = ?
  `).get(ownerCanonicalId, subjectCanonicalId) as ConnectionRow | undefined;

  if (!row) return null;
  return rowToRelationship(row);
}

export function listConnectionRelationships(
  ownerCanonicalId: string,
  tier?: ConnectionTier
): ConnectionRelationship[] {
  const rows = tier === undefined
    ? db.prepare(`
        SELECT *
        FROM connections
        WHERE owner_canonical_id = ?
        ORDER BY updated_at DESC, created_at DESC
      `).all(ownerCanonicalId) as ConnectionRow[]
    : db.prepare(`
        SELECT *
        FROM connections
        WHERE owner_canonical_id = ? AND tier = ?
        ORDER BY updated_at DESC, created_at DESC
      `).all(ownerCanonicalId, tier) as ConnectionRow[];

  return rows.map(rowToRelationship);
}

export function setFeedSubscription(
  ownerCanonicalId: string,
  authorCanonicalId: string,
  authorHandle: string | undefined,
  includePublic: boolean,
  includeConnections: boolean,
  includeClose: boolean,
  muted: boolean,
  now = new Date()
): FeedSubscription {
  const existing = getFeedSubscription(ownerCanonicalId, authorCanonicalId);
  const createdAt = existing === null ? now.toISOString() : existing.created_at;
  const updatedAt = now.toISOString();

  db.prepare(`
    INSERT INTO feed_subscriptions (
      owner_canonical_id,
      author_canonical_id,
      author_handle,
      include_public,
      include_connections,
      include_close,
      muted,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_canonical_id, author_canonical_id)
    DO UPDATE SET
      author_handle = excluded.author_handle,
      include_public = excluded.include_public,
      include_connections = excluded.include_connections,
      include_close = excluded.include_close,
      muted = excluded.muted,
      updated_at = excluded.updated_at
  `).run(
    ownerCanonicalId,
    authorCanonicalId,
    authorHandle ?? null,
    includePublic ? 1 : 0,
    includeConnections ? 1 : 0,
    includeClose ? 1 : 0,
    muted ? 1 : 0,
    createdAt,
    updatedAt
  );

  return {
    type: "sudo_feed_subscription",
    owner_canonical_id: ownerCanonicalId,
    author_canonical_id: authorCanonicalId,
    author_handle: authorHandle,
    include_public: includePublic,
    include_connections: includeConnections,
    include_close: includeClose,
    muted,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function deleteFeedSubscription(ownerCanonicalId: string, authorCanonicalId: string): boolean {
  const result = db.prepare(`
    DELETE FROM feed_subscriptions
    WHERE owner_canonical_id = ? AND author_canonical_id = ?
  `).run(ownerCanonicalId, authorCanonicalId);

  return result.changes > 0;
}

export function getFeedSubscription(
  ownerCanonicalId: string,
  authorCanonicalId: string
): FeedSubscription | null {
  const row = db.prepare(`
    SELECT *
    FROM feed_subscriptions
    WHERE owner_canonical_id = ? AND author_canonical_id = ?
  `).get(ownerCanonicalId, authorCanonicalId) as SubscriptionRow | undefined;

  if (!row) return null;
  return rowToSubscription(row);
}

export function listFeedSubscriptions(ownerCanonicalId: string): FeedSubscription[] {
  const rows = db.prepare(`
    SELECT *
    FROM feed_subscriptions
    WHERE owner_canonical_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(ownerCanonicalId) as SubscriptionRow[];

  return rows.map(rowToSubscription);
}

// "Who is following me / connected to me" — derived from the
// existing rows. The connections subject_canonical_id and
// feed_subscriptions author_canonical_id columns are both indexed
// so these stay cheap. Used by the notifications surface.
export type IncomingFollower = {
  actor_canonical_id: string;
  actor_handle?: string;
  created_at: string;
  updated_at: string;
  muted: boolean;
};

export function listIncomingFollowers(authorCanonicalId: string, limit = 50): IncomingFollower[] {
  // Resolve the FOLLOWER's handle from the identities table — the
  // feed_subscriptions row only stores the author's handle (the
  // target), not the owner's. Without this join the notification
  // would render "@you follows you", since author_handle here is
  // the recipient's own handle.
  const rows = db.prepare(`
    SELECT
      fs.owner_canonical_id,
      i.handle AS owner_handle,
      fs.created_at,
      fs.updated_at,
      fs.muted
    FROM feed_subscriptions fs
    LEFT JOIN identities i ON i.canonical_id = fs.owner_canonical_id
    WHERE fs.author_canonical_id = ?
    ORDER BY fs.created_at DESC
    LIMIT ?
  `).all(authorCanonicalId, limit) as Array<{
    owner_canonical_id: string;
    owner_handle: string | null;
    created_at: string;
    updated_at: string;
    muted: number;
  }>;
  return rows.map((row) => ({
    actor_canonical_id: row.owner_canonical_id,
    actor_handle: row.owner_handle ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    muted: row.muted !== 0
  }));
}

export function connectionTierToRelayTier(tier: ConnectionTier): RelayTier {
  if (tier === "blocked") return "blocked";
  if (tier === "known" || tier === "close") return "known";
  return "unknown";
}

export function getRelayTierFor(senderCanonicalId: string, recipientCanonicalId: string): RelayTier {
  const relationship = getConnectionRelationship(recipientCanonicalId, senderCanonicalId);
  if (relationship === null) return "unknown";
  return connectionTierToRelayTier(relationship.tier);
}

export function getConnectionEffectiveTier(
  ownerCanonicalId: string,
  subjectCanonicalId: string
): ConnectionTier {
  return getConnectionRelationship(ownerCanonicalId, subjectCanonicalId)?.tier ?? "unknown";
}

function upsertLegacyRelayRelationship(
  senderCanonicalId: string,
  recipientCanonicalId: string,
  tier: RelayTier,
  now: Date
): void {
  db.prepare(`
    INSERT INTO relay_relationships (
      sender_canonical_id,
      recipient_canonical_id,
      tier,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sender_canonical_id, recipient_canonical_id)
    DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at
  `).run(senderCanonicalId, recipientCanonicalId, tier, now.toISOString(), now.toISOString());
}

function rowToRelationship(row: ConnectionRow): ConnectionRelationship {
  return {
    type: "sudo_connection_relationship",
    owner_canonical_id: row.owner_canonical_id,
    subject_canonical_id: row.subject_canonical_id,
    subject_handle: row.subject_handle ?? undefined,
    tier: row.tier,
    subscribed: row.subscribed !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    notes: row.notes ?? undefined
  };
}

function rowToSubscription(row: SubscriptionRow): FeedSubscription {
  return {
    type: "sudo_feed_subscription",
    owner_canonical_id: row.owner_canonical_id,
    author_canonical_id: row.author_canonical_id,
    author_handle: row.author_handle ?? undefined,
    include_public: row.include_public !== 0,
    include_connections: row.include_connections !== 0,
    include_close: row.include_close !== 0,
    muted: row.muted !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function tierToRelayTier(tier: ConnectionTier): RelayTier {
  if (tier === "blocked") return "blocked";
  if (tier === "known" || tier === "close") return "known";
  return "unknown";
}

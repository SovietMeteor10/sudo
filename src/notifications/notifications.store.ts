// Read-only notification derivations. Each query joins the canonical
// social-action tables (discovery_reactions, feed_posts) so we never
// materialize a separate notifications table. Self-actions are
// excluded at the SQL level so the route layer doesn't have to
// re-filter, and deleted feed_posts are excluded so a removed post
// doesn't keep generating phantom notifications.

import { db } from "../storage/db.js";

export type IncomingMutualConnection = {
  actor_canonical_id: string;
  actor_handle?: string;
  // Time the mutual relationship became confirmed — i.e. the later of
  // the two subscriptions. Used as the notification's created_at so
  // it appears "new" to the original follower the moment the second
  // subscription lands.
  confirmed_at: string;
};

// Mutual-follow detection: returns peers (X) for whom both
// (recipient -> X) and (X -> recipient) feed_subscriptions exist.
// Used to derive `connection_confirmed` notifications so chat targets
// only unlock after both sides have explicitly followed each other.
export function listIncomingMutualConnections(
  recipientCanonicalId: string,
  limit = 50
): IncomingMutualConnection[] {
  const rows = db.prepare(`
    SELECT
      mine.author_canonical_id AS peer_canonical_id,
      i.handle                 AS peer_handle,
      mine.created_at          AS my_created_at,
      mine.updated_at          AS my_updated_at,
      theirs.created_at        AS their_created_at,
      theirs.updated_at        AS their_updated_at
    FROM feed_subscriptions mine
    INNER JOIN feed_subscriptions theirs
      ON theirs.owner_canonical_id  = mine.author_canonical_id
     AND theirs.author_canonical_id = mine.owner_canonical_id
    LEFT JOIN identities i ON i.canonical_id = mine.author_canonical_id
    WHERE mine.owner_canonical_id = ?
      AND mine.author_canonical_id != ?
      AND COALESCE(mine.muted, 0) = 0
      AND COALESCE(theirs.muted, 0) = 0
    LIMIT ?
  `).all(recipientCanonicalId, recipientCanonicalId, limit) as Array<{
    peer_canonical_id: string;
    peer_handle: string | null;
    my_created_at: string;
    my_updated_at: string;
    their_created_at: string;
    their_updated_at: string;
  }>;

  return rows.map((row) => ({
    actor_canonical_id: row.peer_canonical_id,
    actor_handle: row.peer_handle ?? undefined,
    confirmed_at: row.my_created_at > row.their_created_at ? row.my_created_at : row.their_created_at
  }));
}

export type IncomingReaction = {
  reaction: "recommend" | "downrank";
  actor_canonical_id: string;
  actor_handle?: string;
  post_id: string;
  created_at: string;
};

export function listIncomingReactionsOnAuthor(
  recipientCanonicalId: string,
  limit = 50
): IncomingReaction[] {
  // Reactions on the recipient's own posts. Drops self-reactions
  // (an author reacting to their own post should never notify
  // themselves) and reactions on deleted posts.
  const rows = db.prepare(`
    SELECT
      dr.reaction,
      dr.actor_canonical_id,
      dr.actor_handle,
      dr.post_id,
      dr.created_at
    FROM discovery_reactions dr
    INNER JOIN feed_posts fp ON fp.post_id = dr.post_id
    WHERE fp.author_canonical_id = ?
      AND fp.deleted_at IS NULL
      AND dr.actor_canonical_id != ?
      AND dr.reaction IN ('recommend', 'downrank')
    ORDER BY dr.created_at DESC
    LIMIT ?
  `).all(recipientCanonicalId, recipientCanonicalId, limit) as Array<{
    reaction: string;
    actor_canonical_id: string;
    actor_handle: string | null;
    post_id: string;
    created_at: string;
  }>;

  return rows
    .filter((row) => row.reaction === "recommend" || row.reaction === "downrank")
    .map((row) => ({
      reaction: row.reaction as "recommend" | "downrank",
      actor_canonical_id: row.actor_canonical_id,
      actor_handle: row.actor_handle ?? undefined,
      post_id: row.post_id,
      created_at: row.created_at
    }));
}

export type IncomingReply = {
  actor_canonical_id: string;
  actor_handle?: string;
  reply_post_id: string;
  // Immediate parent (always the recipient's own post per the SQL
  // filter). Useful for the engagement count refresh.
  parent_post_id: string;
  // Top-of-thread post id. May equal parent_post_id for top-level
  // replies, or differ for nested replies — the client needs this so
  // clicking the notification opens the ROOT thread, not an isolated
  // reply view. Resolved by walking reply_to up to the row where
  // reply_to IS NULL.
  root_post_id: string;
  created_at: string;
  updated_at: string;
};

export function listIncomingRepliesToAuthor(
  recipientCanonicalId: string,
  limit = 50
): IncomingReply[] {
  // Replies whose immediate parent (reply_to) belongs to the
  // recipient. The recursive CTE chain(...) walks reply_to up from
  // the reply itself until it hits a row whose reply_to IS NULL —
  // that row's post_id is the thread root. The top-level SELECT then
  // joins the original recipient filter against the root resolution.
  const rows = db.prepare(`
    WITH RECURSIVE chain(start_post_id, current_post_id, current_reply_to) AS (
      SELECT fp.post_id, fp.post_id, fp.reply_to
        FROM feed_posts fp
       WHERE fp.deleted_at IS NULL
      UNION ALL
      SELECT c.start_post_id, p.post_id, p.reply_to
        FROM chain c
        JOIN feed_posts p ON p.post_id = c.current_reply_to
       WHERE c.current_reply_to IS NOT NULL
         AND p.deleted_at IS NULL
    ),
    roots AS (
      SELECT start_post_id AS post_id, current_post_id AS root_post_id
      FROM chain
      WHERE current_reply_to IS NULL
    )
    SELECT
      child.post_id           AS reply_post_id,
      child.author_canonical_id,
      child.author_handle,
      child.created_at,
      child.updated_at,
      child.reply_to          AS parent_post_id,
      r.root_post_id          AS root_post_id
    FROM feed_posts child
    INNER JOIN feed_posts parent ON parent.post_id = child.reply_to
    LEFT JOIN roots r ON r.post_id = child.post_id
    WHERE parent.author_canonical_id = ?
      AND parent.deleted_at IS NULL
      AND child.deleted_at IS NULL
      AND child.author_canonical_id != ?
      AND child.reply_to IS NOT NULL
    ORDER BY child.created_at DESC
    LIMIT ?
  `).all(recipientCanonicalId, recipientCanonicalId, limit) as Array<{
    reply_post_id: string;
    author_canonical_id: string;
    author_handle: string | null;
    created_at: string;
    updated_at: string;
    parent_post_id: string;
    root_post_id: string | null;
  }>;

  return rows.map((row) => ({
    actor_canonical_id: row.author_canonical_id,
    actor_handle: row.author_handle ?? undefined,
    reply_post_id: row.reply_post_id,
    parent_post_id: row.parent_post_id,
    // Fall back to the immediate parent if the recursive walk didn't
    // resolve a root (shouldn't happen in practice; defensive).
    root_post_id: row.root_post_id ?? row.parent_post_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

export type IncomingRepost = {
  actor_canonical_id: string;
  actor_handle?: string;
  repost_post_id: string;
  original_post_id: string;
  created_at: string;
  updated_at: string;
};

export function listIncomingRepostsOfAuthor(
  recipientCanonicalId: string,
  limit = 50
): IncomingRepost[] {
  const rows = db.prepare(`
    SELECT
      child.post_id           AS repost_post_id,
      child.author_canonical_id,
      child.author_handle,
      child.created_at,
      child.updated_at,
      child.repost_of         AS original_post_id
    FROM feed_posts child
    INNER JOIN feed_posts parent ON parent.post_id = child.repost_of
    WHERE parent.author_canonical_id = ?
      AND parent.deleted_at IS NULL
      AND child.deleted_at IS NULL
      AND child.author_canonical_id != ?
      AND child.repost_of IS NOT NULL
    ORDER BY child.created_at DESC
    LIMIT ?
  `).all(recipientCanonicalId, recipientCanonicalId, limit) as Array<{
    repost_post_id: string;
    author_canonical_id: string;
    author_handle: string | null;
    created_at: string;
    updated_at: string;
    original_post_id: string;
  }>;

  return rows.map((row) => ({
    actor_canonical_id: row.author_canonical_id,
    actor_handle: row.author_handle ?? undefined,
    repost_post_id: row.repost_post_id,
    original_post_id: row.original_post_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

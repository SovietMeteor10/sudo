// Read-only notification derivations. Each query joins the canonical
// social-action tables (discovery_reactions, feed_posts) so we never
// materialize a separate notifications table. Self-actions are
// excluded at the SQL level so the route layer doesn't have to
// re-filter, and deleted feed_posts are excluded so a removed post
// doesn't keep generating phantom notifications.

import { db } from "../storage/db.js";

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
  parent_post_id: string;
  created_at: string;
  updated_at: string;
};

export function listIncomingRepliesToAuthor(
  recipientCanonicalId: string,
  limit = 50
): IncomingReply[] {
  // Replies whose immediate parent (reply_to) belongs to the
  // recipient. Each reply post is its own row so each gets its own
  // notification; a re-edit of a reply changes updated_at but keeps
  // the same id.
  const rows = db.prepare(`
    SELECT
      child.post_id           AS reply_post_id,
      child.author_canonical_id,
      child.author_handle,
      child.created_at,
      child.updated_at,
      child.reply_to          AS parent_post_id
    FROM feed_posts child
    INNER JOIN feed_posts parent ON parent.post_id = child.reply_to
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
  }>;

  return rows.map((row) => ({
    actor_canonical_id: row.author_canonical_id,
    actor_handle: row.author_handle ?? undefined,
    reply_post_id: row.reply_post_id,
    parent_post_id: row.parent_post_id,
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

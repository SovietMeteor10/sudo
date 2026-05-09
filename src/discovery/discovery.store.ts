import { db } from "../storage/db.js";
import type {
  DiscoveryPostIndex,
  DiscoveryReaction,
  FeedPost,
  FeedVisibility,
  IdentityFingerprint
} from "../protocol/types.js";
import { scoreDiscoveryPost, type DiscoveryRankingCounts } from "./ranking.js";

type SearchableIdentityRow = {
  handle: string;
  canonical_id: string;
  canonical: string;
  public_key: string;
  identity_public_key: string | null;
  fingerprint_json: string | null;
};

type FeedPostRow = {
  post_id: string;
  author_canonical_id: string;
  author_handle: string | null;
  visibility: FeedVisibility;
  body: string | null;
  encrypted_body: string | null;
  public_metadata_json: string | null;
  allowed_recipients_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sequence: number;
  signature: string | null;
  post_json: string;
};

type DiscoveryPostIndexRow = {
  post_id: string;
  author_canonical_id: string;
  author_handle: string | null;
  visibility: "public" | "unlisted" | "public_metadata_encrypted_body";
  public_metadata_json: string | null;
  body_excerpt: string | null;
  created_at: string;
  recommend_count: number;
  downrank_count: number;
  reply_count: number;
  repost_count: number;
  report_count: number;
  hot_score: number;
  rising_score: number;
  explanation: string | null;
};

type DiscoveryReactionRow = {
  reaction_id: string;
  post_id: string;
  actor_canonical_id: string;
  actor_handle: string | null;
  reaction: DiscoveryReaction["reaction"];
  created_at: string;
  signature: string | null;
  reaction_json: string;
};

type DiscoveryPostOrder = "hot" | "rising" | "recent";

export function listSearchableIdentities(): SearchableIdentityRow[] {
  return db.prepare(`
    SELECT handle, canonical_id, canonical, public_key, identity_public_key, fingerprint_json
    FROM identities
  `).all() as SearchableIdentityRow[];
}

export function upsertDiscoveryPostIndexFromFeedPost(post: FeedPost): DiscoveryPostIndex | null {
  if (!isDiscoverableVisibility(post.visibility) || post.deleted_at !== null) {
    db.prepare("DELETE FROM discovery_post_index WHERE post_id = ?").run(post.post_id);
    return null;
  }

  db.prepare(`
    INSERT INTO discovery_post_index (
      post_id,
      author_canonical_id,
      author_handle,
      visibility,
      public_metadata_json,
      body_excerpt,
      created_at,
      recommend_count,
      downrank_count,
      reply_count,
      repost_count,
      report_count,
      hot_score,
      rising_score,
      explanation
    ) VALUES (
      @postId,
      @authorCanonicalId,
      @authorHandle,
      @visibility,
      @publicMetadataJson,
      @bodyExcerpt,
      @createdAt,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      @explanation
    )
    ON CONFLICT(post_id) DO UPDATE SET
      author_canonical_id = excluded.author_canonical_id,
      author_handle = excluded.author_handle,
      visibility = excluded.visibility,
      public_metadata_json = excluded.public_metadata_json,
      body_excerpt = excluded.body_excerpt,
      created_at = excluded.created_at,
      explanation = excluded.explanation
  `).run({
    postId: post.post_id,
    authorCanonicalId: post.author_canonical_id,
    authorHandle: post.author_handle ?? null,
    visibility: post.visibility as DiscoveryPostIndex["visibility"],
    publicMetadataJson: JSON.stringify(post.public_metadata),
    bodyExcerpt: buildBodyExcerpt(post),
    createdAt: post.created_at,
    explanation: "Ranked by transparent reaction counts and age."
  });

  return refreshDiscoveryPostIndex(post.post_id);
}

export function removeDiscoveryPostIndex(postId: string): boolean {
  const result = db.prepare(`
    DELETE FROM discovery_post_index
    WHERE post_id = ?
  `).run(postId);

  return result.changes > 0;
}

export function getDiscoveryPostIndex(postId: string): DiscoveryPostIndex | null {
  const row = db.prepare(`
    SELECT *
    FROM discovery_post_index
    WHERE post_id = ?
  `).get(postId) as DiscoveryPostIndexRow | undefined;

  return row === undefined ? null : rowToPostIndex(row);
}

export function listDiscoveryPostIndex(order: DiscoveryPostOrder, limit = 20, offset = 0): DiscoveryPostIndex[] {
  const orderClause = order === "hot"
    ? "hot_score DESC, created_at DESC"
    : order === "rising"
      ? "rising_score DESC, created_at DESC"
      : "created_at DESC";

  const rows = db.prepare(`
    SELECT *
    FROM discovery_post_index
    ORDER BY ${orderClause}
    LIMIT ?
    OFFSET ?
  `).all(limit, offset) as DiscoveryPostIndexRow[];

  return rows.map(rowToPostIndex);
}

export function reactionExists(
  postId: string,
  actorCanonicalId: string,
  reaction: DiscoveryReaction["reaction"]
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM discovery_reactions
    WHERE post_id = ? AND actor_canonical_id = ? AND reaction = ?
    LIMIT 1
  `).get(postId, actorCanonicalId, reaction);

  return row !== undefined;
}

export function insertDiscoveryReaction(reaction: DiscoveryReaction): DiscoveryReaction {
  db.prepare(`
    INSERT INTO discovery_reactions (
      reaction_id,
      post_id,
      actor_canonical_id,
      actor_handle,
      reaction,
      created_at,
      signature,
      reaction_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reaction.reaction_id,
    reaction.post_id,
    reaction.actor_canonical_id,
    reaction.actor_handle ?? null,
    reaction.reaction,
    reaction.created_at,
    reaction.signature,
    JSON.stringify(reaction)
  );

  return reaction;
}

export function refreshDiscoveryPostIndex(postId: string): DiscoveryPostIndex | null {
  const post = db.prepare(`
    SELECT *
    FROM feed_posts
    WHERE post_id = ?
  `).get(postId) as FeedPostRow | undefined;

  if (post === undefined || post.deleted_at !== null || !isDiscoverableVisibility(post.visibility)) {
    db.prepare("DELETE FROM discovery_post_index WHERE post_id = ?").run(postId);
    return null;
  }

  const counts = countDiscoveryReactions(postId);
  const ranking = scoreDiscoveryPost(post.created_at, counts);
  const index = rowToPostIndex({
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    visibility: post.visibility as DiscoveryPostIndex["visibility"],
    public_metadata_json: post.public_metadata_json,
    body_excerpt: buildBodyExcerptFromRow(post),
    created_at: post.created_at,
    recommend_count: counts.recommend_count,
    downrank_count: counts.downrank_count,
    reply_count: counts.reply_count,
    repost_count: counts.repost_count,
    report_count: counts.report_count,
    hot_score: ranking.hot_score,
    rising_score: ranking.rising_score,
    explanation: ranking.explanation
  });

  db.prepare(`
    INSERT INTO discovery_post_index (
      post_id,
      author_canonical_id,
      author_handle,
      visibility,
      public_metadata_json,
      body_excerpt,
      created_at,
      recommend_count,
      downrank_count,
      reply_count,
      repost_count,
      report_count,
      hot_score,
      rising_score,
      explanation
    ) VALUES (
      @post_id,
      @author_canonical_id,
      @author_handle,
      @visibility,
      @public_metadata_json,
      @body_excerpt,
      @created_at,
      @recommend_count,
      @downrank_count,
      @reply_count,
      @repost_count,
      @report_count,
      @hot_score,
      @rising_score,
      @explanation
    )
    ON CONFLICT(post_id) DO UPDATE SET
      author_canonical_id = excluded.author_canonical_id,
      author_handle = excluded.author_handle,
      visibility = excluded.visibility,
      public_metadata_json = excluded.public_metadata_json,
      body_excerpt = excluded.body_excerpt,
      created_at = excluded.created_at,
      recommend_count = excluded.recommend_count,
      downrank_count = excluded.downrank_count,
      reply_count = excluded.reply_count,
      repost_count = excluded.repost_count,
      report_count = excluded.report_count,
      hot_score = excluded.hot_score,
      rising_score = excluded.rising_score,
      explanation = excluded.explanation
  `).run({
    post_id: index.post_id,
    author_canonical_id: index.author_canonical_id,
    author_handle: index.author_handle ?? null,
    visibility: index.visibility,
    public_metadata_json: JSON.stringify(index.public_metadata),
    body_excerpt: index.body_excerpt,
    created_at: index.created_at,
    recommend_count: index.recommend_count,
    downrank_count: index.downrank_count,
    reply_count: index.reply_count,
    repost_count: index.repost_count,
    report_count: index.report_count,
    hot_score: index.hot_score,
    rising_score: index.rising_score,
    explanation: index.explanation
  });

  return getDiscoveryPostIndex(postId);
}

export function reindexDiscoveryPosts(): number {
  const posts = listDiscoverableFeedPosts();
  const postIds = new Set(posts.map((post) => post.post_id));

  const transaction = db.transaction(() => {
    if (postIds.size > 0) {
      const placeholders = [...postIds].map(() => "?").join(", ");
      db.prepare(`DELETE FROM discovery_post_index WHERE post_id NOT IN (${placeholders})`).run(...postIds);
    } else {
      db.prepare("DELETE FROM discovery_post_index").run();
    }

    for (const post of posts) {
      upsertDiscoveryPostIndexFromFeedPost(post);
    }
  });

  transaction();
  return posts.length;
}

export function listDiscoverableFeedPosts(): FeedPost[] {
  const rows = db.prepare(`
    SELECT *
    FROM feed_posts
    WHERE deleted_at IS NULL
      AND visibility IN ('public', 'public_metadata_encrypted_body')
    ORDER BY created_at DESC
  `).all() as FeedPostRow[];

  return rows.map(rowToFeedPost);
}

export function rowToFeedPost(row: FeedPostRow): FeedPost {
  const parsed = parseJson<FeedPost>(row.post_json);
  if (parsed !== null) return parsed;

  return {
    type: "sudo_feed_post",
    protocol_version: "0.1.0",
    post_id: row.post_id,
    author_canonical_id: row.author_canonical_id,
    author_handle: row.author_handle ?? undefined,
    visibility: row.visibility as DiscoveryPostIndex["visibility"],
    body: row.body ?? undefined,
    encrypted_body: row.encrypted_body ?? undefined,
    public_metadata: parseJson(row.public_metadata_json) ?? { tags: [] },
    allowed_recipients: parseJson(row.allowed_recipients_json) ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    sequence: row.sequence,
    signature: row.signature ?? "dev-placeholder"
  };
}

function countDiscoveryReactions(postId: string): DiscoveryRankingCounts {
  const totalRows = db.prepare(`
    SELECT reaction, COUNT(*) AS count
    FROM discovery_reactions
    WHERE post_id = ?
    GROUP BY reaction
  `).all(postId) as Array<{ reaction: DiscoveryReaction["reaction"]; count: number }>;

  const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentRows = db.prepare(`
    SELECT reaction, COUNT(*) AS count
    FROM discovery_reactions
    WHERE post_id = ?
      AND created_at >= ?
    GROUP BY reaction
  `).all(postId, recentCutoff) as Array<{ reaction: DiscoveryReaction["reaction"]; count: number }>;

  const counts = buildCounts(totalRows, recentRows);

  // reply_count and repost_count are sourced from real feed posts, not
  // from "reply"/"repost" reactions, because replies/reposts are now
  // first-class feed posts with their own bodies. The discovery
  // reactions of those types stay around for ranking signal but the
  // displayed counts come from the feed_posts table.
  const replyRow = db.prepare(`
    SELECT COUNT(*) AS count FROM feed_posts WHERE reply_to = ? AND deleted_at IS NULL
  `).get(postId) as { count: number } | undefined;
  const repostRow = db.prepare(`
    SELECT COUNT(*) AS count FROM feed_posts WHERE repost_of = ? AND deleted_at IS NULL
  `).get(postId) as { count: number } | undefined;
  const recentReplyRow = db.prepare(`
    SELECT COUNT(*) AS count FROM feed_posts WHERE reply_to = ? AND deleted_at IS NULL AND created_at >= ?
  `).get(postId, recentCutoff) as { count: number } | undefined;
  const recentRepostRow = db.prepare(`
    SELECT COUNT(*) AS count FROM feed_posts WHERE repost_of = ? AND deleted_at IS NULL AND created_at >= ?
  `).get(postId, recentCutoff) as { count: number } | undefined;

  counts.reply_count = replyRow?.count ?? 0;
  counts.repost_count = repostRow?.count ?? 0;
  counts.recent_reply_count_24h = recentReplyRow?.count ?? 0;
  counts.recent_repost_count_24h = recentRepostRow?.count ?? 0;
  return counts;
}

export function deleteDiscoveryReaction(
  postId: string,
  actorCanonicalId: string,
  reaction: DiscoveryReaction["reaction"]
): boolean {
  const result = db.prepare(`
    DELETE FROM discovery_reactions
    WHERE post_id = ? AND actor_canonical_id = ? AND reaction = ?
  `).run(postId, actorCanonicalId, reaction);
  return result.changes > 0;
}

export function getViewerReaction(
  postId: string,
  viewerCanonicalId: string
): DiscoveryReaction["reaction"] | null {
  const row = db.prepare(`
    SELECT reaction FROM discovery_reactions
    WHERE post_id = ? AND actor_canonical_id = ?
      AND reaction IN ('recommend', 'downrank')
    LIMIT 1
  `).get(postId, viewerCanonicalId) as { reaction: DiscoveryReaction["reaction"] } | undefined;
  return row?.reaction ?? null;
}

function buildCounts(
  totalRows: Array<{ reaction: DiscoveryReaction["reaction"]; count: number }>,
  recentRows: Array<{ reaction: DiscoveryReaction["reaction"]; count: number }>
): DiscoveryRankingCounts {
  const total = toCountMap(totalRows);
  const recent = toCountMap(recentRows);

  return {
    recommend_count: total.recommend ?? 0,
    downrank_count: total.downrank ?? 0,
    reply_count: total.reply ?? 0,
    repost_count: total.repost ?? 0,
    report_count: total.report ?? 0,
    recent_recommend_count_24h: recent.recommend ?? 0,
    recent_downrank_count_24h: recent.downrank ?? 0,
    recent_reply_count_24h: recent.reply ?? 0,
    recent_repost_count_24h: recent.repost ?? 0,
    recent_report_count_24h: recent.report ?? 0
  };
}

function toCountMap(rows: Array<{ reaction: DiscoveryReaction["reaction"]; count: number }>): Partial<Record<DiscoveryReaction["reaction"], number>> {
  const counts: Partial<Record<DiscoveryReaction["reaction"], number>> = {};
  for (const row of rows) {
    counts[row.reaction] = row.count;
  }
  return counts;
}

function rowToPostIndex(row: DiscoveryPostIndexRow): DiscoveryPostIndex {
  return {
    post_id: row.post_id,
    author_canonical_id: row.author_canonical_id,
    author_handle: row.author_handle ?? undefined,
    visibility: row.visibility,
    public_metadata: parseJson(row.public_metadata_json) ?? { tags: [] },
    body_excerpt: row.body_excerpt ?? "",
    created_at: row.created_at,
    recommend_count: row.recommend_count,
    downrank_count: row.downrank_count,
    reply_count: row.reply_count,
    repost_count: row.repost_count,
    report_count: row.report_count,
    hot_score: row.hot_score,
    rising_score: row.rising_score,
    explanation: row.explanation ?? "Ranked by transparent reaction counts and age."
  };
}

function isDiscoverableVisibility(visibility: FeedVisibility): boolean {
  return visibility === "public" || visibility === "public_metadata_encrypted_body";
}

function buildBodyExcerpt(post: FeedPost): string {
  if (post.visibility === "public_metadata_encrypted_body") {
    return post.public_metadata.title
      ?? post.public_metadata.summary
      ?? "[encrypted body]";
  }

  return post.body
    ?? post.public_metadata.summary
    ?? post.public_metadata.title
    ?? "";
}

function buildBodyExcerptFromRow(row: FeedPostRow): string {
  const post = rowToFeedPost(row);
  return buildBodyExcerpt(post);
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

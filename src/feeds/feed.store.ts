import { db } from "../storage/db.js";
import { removeDiscoveryPostIndex, upsertDiscoveryPostIndexFromFeedPost, refreshDiscoveryPostIndex } from "../discovery/discovery.store.js";
import type { FeedPost, FeedPostKind, FeedVisibility } from "./feed.types.js";
import { localStreamPosts } from "./localFeed.js";

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
  kind: string | null;
  reply_to: string | null;
  repost_of: string | null;
  post_json: string;
};

export function saveFeedPost(post: FeedPost): void {
  db.prepare(`
    INSERT INTO feed_posts (
      post_id,
      author_canonical_id,
      author_handle,
      visibility,
      body,
      encrypted_body,
      public_metadata_json,
      allowed_recipients_json,
      created_at,
      updated_at,
      deleted_at,
      sequence,
      signature,
      kind,
      reply_to,
      repost_of,
      post_json
    ) VALUES (
      @postId,
      @authorCanonicalId,
      @authorHandle,
      @visibility,
      @body,
      @encryptedBody,
      @publicMetadataJson,
      @allowedRecipientsJson,
      @createdAt,
      @updatedAt,
      @deletedAt,
      @sequence,
      @signature,
      @kind,
      @replyTo,
      @repostOf,
      @postJson
    )
  `).run(rowParams(post));

  try {
    upsertDiscoveryPostIndexFromFeedPost(post);
    // Reply/repost feed posts don't index themselves, but they do
    // mutate the parent post's reply/repost counts.
    if (post.reply_to !== undefined && post.reply_to !== null) {
      refreshDiscoveryPostIndex(post.reply_to);
    }
    if (post.repost_of !== undefined && post.repost_of !== null) {
      refreshDiscoveryPostIndex(post.repost_of);
    }
  } catch {
    // Discovery is optional indexing. Feed writes remain the source of truth.
  }
}

export function listRepliesForPost(postId: string): FeedPost[] {
  const rows = db
    .prepare(`
      SELECT * FROM feed_posts
      WHERE reply_to = ?
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 200
    `)
    .all(postId) as FeedPostRow[];

  return rows.map(rowToPost);
}

export function countRepliesForPost(postId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM feed_posts WHERE reply_to = ? AND deleted_at IS NULL`)
    .get(postId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function countRepostsForPost(postId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM feed_posts WHERE repost_of = ? AND deleted_at IS NULL`)
    .get(postId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getFeedPost(postId: string): FeedPost | null {
  const row = db
    .prepare("SELECT * FROM feed_posts WHERE post_id = ?")
    .get(postId) as FeedPostRow | undefined;

  return row === undefined ? null : rowToPost(row);
}

export function listFeedPosts(): FeedPost[] {
  const rows = db
    .prepare(`
      SELECT * FROM feed_posts
      WHERE deleted_at IS NULL
        AND visibility IN ('public', 'unlisted')
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .all() as FeedPostRow[];

  return rows.map(rowToPost);
}

export function listFeedPostsByAuthor(canonicalId: string): FeedPost[] {
  const rows = db
    .prepare(`
      SELECT * FROM feed_posts
      WHERE author_canonical_id = @canonicalId
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .all({ canonicalId }) as FeedPostRow[];

  return rows.map(rowToPost);
}

export function listRssFeedPostsByAuthor(canonicalId: string): FeedPost[] {
  const rows = db
    .prepare(`
      SELECT * FROM feed_posts
      WHERE author_canonical_id = ?
        AND deleted_at IS NULL
        AND visibility IN ('public', 'unlisted')
        AND body IS NOT NULL
        AND body != ''
      ORDER BY created_at DESC
      LIMIT 50
    `)
    .all(canonicalId) as FeedPostRow[];

  return rows.map(rowToPost);
}

export function softDeleteFeedPost(postId: string, deletedAt: string): FeedPost | null {
  const existing = getFeedPost(postId);
  if (existing === null) return null;

  const tombstone: FeedPost = {
    ...existing,
    body: undefined,
    encrypted_body: undefined,
    updated_at: deletedAt,
    deleted_at: deletedAt
  };

  db.prepare(`
    UPDATE feed_posts
    SET body = NULL,
        encrypted_body = NULL,
        updated_at = @updatedAt,
        deleted_at = @deletedAt,
        post_json = @postJson
    WHERE post_id = @postId
  `).run({
    postId,
    updatedAt: deletedAt,
    deletedAt,
    postJson: JSON.stringify(tombstone)
  });

  try {
    removeDiscoveryPostIndex(postId);
  } catch {
    // Discovery is optional indexing. Feed tombstones remain the source of truth.
  }

  return tombstone;
}

export function listLocalFeedPosts() {
  return localStreamPosts;
}

function rowParams(post: FeedPost): Record<string, unknown> {
  return {
    postId: post.post_id,
    authorCanonicalId: post.author_canonical_id,
    authorHandle: post.author_handle ?? null,
    visibility: post.visibility,
    body: post.body ?? null,
    encryptedBody: post.encrypted_body ?? null,
    publicMetadataJson: JSON.stringify(post.public_metadata),
    allowedRecipientsJson: JSON.stringify(post.allowed_recipients),
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    deletedAt: post.deleted_at,
    sequence: post.sequence,
    signature: post.signature,
    kind: post.kind ?? null,
    replyTo: post.reply_to ?? null,
    repostOf: post.repost_of ?? null,
    postJson: JSON.stringify(stripDecorators(post))
  };
}

function stripDecorators(post: FeedPost): FeedPost {
  // repost_of_post / reply_to_post are server-decorated for client
  // rendering and must not be persisted (or they'd recursively bloat
  // post_json on every save).
  const { repost_of_post: _r, reply_to_post: _y, ...rest } = post;
  return rest as FeedPost;
}

function rowToPost(row: FeedPostRow): FeedPost {
  const parsed = parseJson<FeedPost>(row.post_json);
  if (parsed !== null) {
    // Older rows may have been written before kind/reply_to/repost_of
    // existed. Backfill from row columns so callers always see them.
    if (parsed.kind === undefined && row.kind !== null) parsed.kind = row.kind as FeedPostKind;
    if (parsed.reply_to === undefined && row.reply_to !== null) parsed.reply_to = row.reply_to;
    if (parsed.repost_of === undefined && row.repost_of !== null) parsed.repost_of = row.repost_of;
    return parsed;
  }

  return {
    type: "sudo_feed_post",
    protocol_version: "0.1.0",
    post_id: row.post_id,
    author_canonical_id: row.author_canonical_id,
    author_handle: row.author_handle ?? undefined,
    visibility: row.visibility,
    body: row.body ?? undefined,
    encrypted_body: row.encrypted_body ?? undefined,
    public_metadata: parseJson(row.public_metadata_json) ?? { tags: [] },
    allowed_recipients: parseJson(row.allowed_recipients_json) ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    sequence: row.sequence,
    signature: row.signature ?? "dev-placeholder",
    kind: (row.kind ?? undefined) as FeedPostKind | undefined,
    reply_to: row.reply_to ?? undefined,
    repost_of: row.repost_of ?? undefined
  };
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

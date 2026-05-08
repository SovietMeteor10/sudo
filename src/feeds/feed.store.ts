import { db } from "../storage/db.js";
import type { FeedPost, FeedVisibility } from "./feed.types.js";
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
      @postJson
    )
  `).run(rowParams(post));
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
    postJson: JSON.stringify(post)
  };
}

function rowToPost(row: FeedPostRow): FeedPost {
  const parsed = parseJson<FeedPost>(row.post_json);
  if (parsed !== null) return parsed;

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
    signature: row.signature ?? "dev-placeholder"
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

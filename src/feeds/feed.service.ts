import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { signFeedPost, verifyCanonicalSignature } from "../crypto/signatures.js";
import { SUDO_PROTOCOL_VERSION, DEFAULT_MAX_TEXT_FEED_POST_BYTES } from "../protocol/constants.js";
import { getConnectionRelationship } from "../connections/connections.store.js";
import { getIdentityByCanonicalId } from "../identity/identity.store.js";
import type { FeedPost, FeedPostKind, FeedVisibility, SignableFeedPost } from "./feed.types.js";
import { FeedError, type CreateFeedPostInput } from "./feed.types.js";
import {
  getFeedPost,
  listFeedPosts as listStoredFeedPosts,
  listFeedPostsByAuthor,
  listLocalFeedPosts,
  listRepliesForPost,
  listRssFeedPostsByAuthor,
  saveFeedPost,
  softDeleteFeedPost
} from "./feed.store.js";

const allowedVisibilities = new Set<FeedVisibility>([
  "connections_only",
  "close_connections",
  "unlisted",
  "public",
  "public_metadata_encrypted_body"
]);

export function listFeedPosts() {
  const stored = listStoredFeedPosts();
  if (stored.length > 0) return stored;
  return listLocalFeedPosts();
}

export function createFeedPost(input: CreateFeedPostInput): FeedPost {
  const author = getIdentityByCanonicalId(input.author_canonical_id);
  if (author === null) {
    throw new FeedError("author_not_found", "author identity is not known", 404);
  }

  if (!allowedVisibilities.has(input.visibility)) {
    throw new FeedError("invalid_visibility", "unsupported feed visibility");
  }

  const body = normalizeOptionalText(input.body);
  const encryptedBody = normalizeOptionalText(input.encrypted_body);
  const metadata = {
    title: normalizeOptionalText(input.public_metadata?.title),
    summary: normalizeOptionalText(input.public_metadata?.summary),
    tags: normalizeTags(input.public_metadata?.tags)
  };
  const allowedRecipients = normalizeRecipients(input.allowed_recipients);
  const kind = normalizeKind(input.kind);
  const replyTo = normalizePostRef(input.reply_to);
  const repostOf = normalizePostRef(input.repost_of);

  validatePostContent(input.visibility, body, encryptedBody, metadata, allowedRecipients, kind, replyTo, repostOf);

  const createdAt = normalizeTimestamp(input.created_at) ?? new Date().toISOString();
  const updatedAt = normalizeTimestamp(input.updated_at) ?? createdAt;
  const signable: SignableFeedPost = {
    type: "sudo_feed_post",
    protocol_version: SUDO_PROTOCOL_VERSION,
    post_id: normalizePostId(input.post_id),
    author_canonical_id: input.author_canonical_id,
    author_handle: input.author_handle ?? author.document.handle,
    visibility: input.visibility,
    ...(body === undefined ? {} : { body }),
    ...(encryptedBody === undefined ? {} : { encrypted_body: encryptedBody }),
    public_metadata: metadata,
    allowed_recipients: allowedRecipients,
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: normalizeNullableTimestamp(input.deleted_at),
    sequence: normalizeSequence(input.sequence),
    ...(kind === undefined ? {} : { kind }),
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
    ...(repostOf === undefined ? {} : { repost_of: repostOf })
  };
  const signature = resolveFeedPostSignature(author, signable, input.signature);
  const post: FeedPost = {
    ...signable,
    signature
  };

  saveFeedPost(post);
  return post;
}

export function listRepliesForApi(
  postId: string,
  viewerCanonicalId: string | undefined
): { posts: FeedPost[] } {
  const replies = listRepliesForPost(postId)
    .map((post) => filterPostForViewer(post, viewerCanonicalId))
    .filter((post): post is FeedPost => post !== null)
    .map((post) => decorateRefs(post));
  return { posts: replies };
}

export function getPostForApi(postId: string): { post: FeedPost; warning?: string } {
  return getPostForApiWithViewer(postId, undefined);
}

export function getPostForApiWithViewer(
  postId: string,
  viewerCanonicalId: string | undefined
): { post: FeedPost; warning?: string } {
  const post = getFeedPost(postId);
  if (post === null || post.deleted_at !== null) {
    throw new FeedError("post_not_found", "feed post not found", 404);
  }

  if (post.visibility === "private_message") {
    throw new FeedError("not_feed_post", "private_message is not a feed post", 404);
  }

  if (viewerCanonicalId === undefined && post.visibility !== "public" && post.visibility !== "unlisted") {
    return {
      post: redactRestrictedPost(post),
      warning: "unsafe_dev_only_restricted_feed_fetch_without_auth"
    };
  }

  const visible = filterPostForViewer(post, viewerCanonicalId);
  if (visible === null) {
    throw new FeedError("not_feed_post", "post not visible to this viewer", 404);
  }

  return { post: decorateRefs(visible, viewerCanonicalId) };
}

export function listUserPostsForApi(
  canonicalId: string,
  viewerCanonicalId: string | undefined
): { posts: FeedPost[]; warning?: string } {
  const posts = listFeedPostsByAuthor(canonicalId);
  const filtered = posts
    .map((post) => filterPostForViewer(post, viewerCanonicalId))
    .filter((post): post is FeedPost => post !== null)
    .map((post) => decorateRefs(post, viewerCanonicalId));

  return {
    posts: filtered,
    warning: viewerCanonicalId === undefined ? undefined : "unsafe_dev_only_viewer_filter_applied"
  };
}

function decorateRefs(post: FeedPost, viewerCanonicalId?: string | undefined): FeedPost {
  // Hydrate the embedded original post for reposts/replies so the
  // client can render them inline without extra round-trips. We
  // intentionally only hydrate one level (no recursion).
  let decorated = post;
  if (post.repost_of !== undefined && post.repost_of !== null) {
    const original = getFeedPost(post.repost_of);
    const visibleOriginal = original === null || original.deleted_at !== null
      ? null
      : filterPostForViewer(original, viewerCanonicalId);
    decorated = { ...decorated, repost_of_post: visibleOriginal };
  }
  if (post.reply_to !== undefined && post.reply_to !== null) {
    const parent = getFeedPost(post.reply_to);
    const visibleParent = parent === null || parent.deleted_at !== null
      ? null
      : filterPostForViewer(parent, viewerCanonicalId);
    decorated = { ...decorated, reply_to_post: visibleParent };
  }
  return decorated;
}

export function getUserRssFeed(canonicalId: string, baseUrl: string): string {
  const author = getIdentityByCanonicalId(canonicalId);
  const title = author === null ? `sudo feed ${canonicalId}` : `${author.document.handle} sudo feed`;
  const posts = listRssFeedPostsByAuthor(canonicalId);
  const items = posts.map((post) => {
    const link = `${baseUrl}/api/feeds/posts/${encodeURIComponent(post.post_id)}`;
    const itemTitle = post.public_metadata.title ?? excerpt(post.body ?? "", 64);

    return [
      "    <item>",
      `      <title>${escapeXml(itemTitle)}</title>`,
      `      <link>${escapeXml(link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(post.post_id)}</guid>`,
      `      <pubDate>${new Date(post.created_at).toUTCString()}</pubDate>`,
      `      <description>${escapeXml(post.body ?? "")}</description>`,
      "    </item>"
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(`${baseUrl}/api/feeds/users/${encodeURIComponent(canonicalId)}`)}</link>`,
    "    <description>sudo signed text feed</description>",
    ...items,
    "  </channel>",
    "</rss>"
  ].join("\n");
}

export function deleteFeedPost(postId: string): FeedPost {
  const deleted = softDeleteFeedPost(postId, new Date().toISOString());
  if (deleted === null) {
    throw new FeedError("post_not_found", "feed post not found", 404);
  }

  return deleted;
}

function validatePostContent(
  visibility: FeedVisibility,
  body: string | undefined,
  encryptedBody: string | undefined,
  metadata: { title?: string; summary?: string; tags: string[] },
  allowedRecipients: string[],
  kind: FeedPostKind | undefined,
  replyTo: string | undefined,
  repostOf: string | undefined
): void {
  if (visibility === "close_connections" && allowedRecipients.length === 0) {
    throw new FeedError(
      "close_connections_requires_recipients",
      "close_connections posts require allowed_recipients"
    );
  }

  if (visibility === "public_metadata_encrypted_body" && encryptedBody === undefined) {
    throw new FeedError(
      "invalid_post",
      "public_metadata_encrypted_body requires encrypted_body"
    );
  }

  if (kind === "repost") {
    if (repostOf === undefined) {
      throw new FeedError("missing_repost_of", "repost requires repost_of");
    }
  } else if (kind === "reply") {
    if (replyTo === undefined) {
      throw new FeedError("missing_reply_to", "reply requires reply_to");
    }
    if (body === undefined && encryptedBody === undefined) {
      throw new FeedError("invalid_post", "reply requires body or encrypted_body");
    }
  } else if (body === undefined && encryptedBody === undefined && metadata.title === undefined) {
    throw new FeedError("invalid_post", "feed post requires body, encrypted_body, or public title");
  }

  const size = Buffer.byteLength(body ?? "", "utf8")
    + Buffer.byteLength(encryptedBody ?? "", "utf8")
    + Buffer.byteLength(JSON.stringify(metadata), "utf8");

  if (size > DEFAULT_MAX_TEXT_FEED_POST_BYTES) {
    throw new FeedError("post_too_large", "feed post is too large", 413);
  }
}

function normalizeKind(value: unknown): FeedPostKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "post" || value === "repost" || value === "reply") return value;
  throw new FeedError("invalid_kind", `unknown feed post kind: ${String(value)}`);
}

function normalizePostRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function filterPostForViewer(post: FeedPost, viewerCanonicalId: string | undefined): FeedPost | null {
  if (post.visibility === "public" || post.visibility === "unlisted") {
    return post;
  }

  if (post.visibility === "public_metadata_encrypted_body") {
    return viewerCanonicalId !== undefined && post.allowed_recipients.includes(viewerCanonicalId)
      ? post
      : {
          ...post,
          body: undefined,
          encrypted_body: undefined
        };
  }

  if (post.visibility === "connections_only") {
    return canSeeConnectionsOnly(viewerCanonicalId, post.author_canonical_id) ? post : null;
  }

  if (post.visibility === "close_connections") {
    return canSeeCloseConnections(viewerCanonicalId, post.author_canonical_id, post.allowed_recipients) ? post : null;
  }

  return null;
}

function redactRestrictedPost(post: FeedPost): FeedPost {
  return {
    ...post,
    body: post.visibility === "public_metadata_encrypted_body" ? undefined : post.body,
    encrypted_body: undefined
  };
}

function canSeeAuthorPosts(viewerCanonicalId: string | undefined, authorCanonicalId: string): boolean {
  if (viewerCanonicalId === undefined) return false;
  const relationship = getConnectionRelationship(viewerCanonicalId, authorCanonicalId);
  if (relationship === null) return false;
  return relationship.tier === "known" || relationship.tier === "close";
}

function canSeeConnectionsOnly(viewerCanonicalId: string | undefined, authorCanonicalId: string): boolean {
  return canSeeAuthorPosts(viewerCanonicalId, authorCanonicalId);
}

function canSeeCloseConnections(
  viewerCanonicalId: string | undefined,
  authorCanonicalId: string,
  allowedRecipients: string[]
): boolean {
  if (viewerCanonicalId === undefined) return false;
  if (allowedRecipients.includes(viewerCanonicalId)) return true;
  const relationship = getConnectionRelationship(viewerCanonicalId, authorCanonicalId);
  return relationship !== null && relationship.tier === "close";
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) return undefined;
  return normalized;
}

function normalizeNullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return normalizeTimestamp(value) ?? null;
}

function normalizeSequence(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizePostId(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return randomUUID();
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
    .filter((tag) => /^[a-z0-9_-]{1,32}$/.test(tag))
    .slice(0, 12);
}

function normalizeRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((recipient): recipient is string => (
    typeof recipient === "string" && recipient.startsWith("sudo:")
  )))].slice(0, 256);
}

function resolveFeedPostSignature(
  author: NonNullable<ReturnType<typeof getIdentityByCanonicalId>>,
  signable: SignableFeedPost,
  signature: string | undefined
): string {
  if (signature !== undefined) {
    const isValid = verifyCanonicalSignature(
      signable,
      signature,
      author.document.keys.feed.public_key,
      author.document.keys.feed.type ?? "ed25519"
    );

    if (!isValid) {
      throw new FeedError("invalid_signature", "invalid feed post signature");
    }

    return signature;
  }

  return signWithDevFeedKey(signable) ?? "dev-placeholder:feed-signature-unavailable";
}

function signWithDevFeedKey(post: SignableFeedPost): string | null {
  const keyPath = resolve("data/keys", `${post.author_canonical_id}.dev-feed-private-key.pem`);
  if (!existsSync(keyPath)) return null;

  try {
    // DEV ONLY: feed posts are signed server-side with plaintext dev keys until
    // feed signing moves to device-held client keys.
    return signFeedPost(post, readFileSync(keyPath, "utf8"));
  } catch {
    return null;
  }
}

function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

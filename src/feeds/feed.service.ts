import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { signFeedPost } from "../crypto/signatures.js";
import { SUDO_PROTOCOL_VERSION, DEFAULT_MAX_TEXT_FEED_POST_BYTES } from "../protocol/constants.js";
import { getIdentityByCanonicalId } from "../identity/identity.store.js";
import type { FeedPost, FeedVisibility, SignableFeedPost } from "./feed.types.js";
import { FeedError, type CreateFeedPostInput } from "./feed.types.js";
import {
  getFeedPost,
  listFeedPosts as listStoredFeedPosts,
  listFeedPostsByAuthor,
  listLocalFeedPosts,
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

  validatePostContent(input.visibility, body, encryptedBody, metadata, allowedRecipients);

  const now = new Date().toISOString();
  const signable: SignableFeedPost = {
    type: "sudo_feed_post",
    protocol_version: SUDO_PROTOCOL_VERSION,
    post_id: randomUUID(),
    author_canonical_id: input.author_canonical_id,
    author_handle: input.author_handle ?? author.document.handle,
    visibility: input.visibility,
    ...(body === undefined ? {} : { body }),
    ...(encryptedBody === undefined ? {} : { encrypted_body: encryptedBody }),
    public_metadata: metadata,
    allowed_recipients: allowedRecipients,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    sequence: 1
  };
  const post: FeedPost = {
    ...signable,
    signature: signWithDevFeedKey(signable) ?? "dev-placeholder:feed-signature-unavailable"
  };

  saveFeedPost(post);
  return post;
}

export function getPostForApi(postId: string): { post: FeedPost; warning?: string } {
  const post = getFeedPost(postId);
  if (post === null || post.deleted_at !== null) {
    throw new FeedError("post_not_found", "feed post not found", 404);
  }

  if (post.visibility === "private_message") {
    throw new FeedError("not_feed_post", "private_message is not a feed post", 404);
  }

  if (post.visibility === "connections_only" || post.visibility === "close_connections") {
    return {
      post,
      warning: "unsafe_dev_only_restricted_feed_fetch_without_auth"
    };
  }

  return { post };
}

export function listUserPostsForApi(
  canonicalId: string,
  includeRestricted: boolean
): { posts: FeedPost[]; warning?: string } {
  return {
    posts: listFeedPostsByAuthor(canonicalId, includeRestricted),
    warning: includeRestricted ? "unsafe_dev_only_includes_restricted_posts" : undefined
  };
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
  allowedRecipients: string[]
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

  if (body === undefined && encryptedBody === undefined && metadata.title === undefined) {
    throw new FeedError("invalid_post", "feed post requires body, encrypted_body, or public title");
  }

  const size = Buffer.byteLength(body ?? "", "utf8")
    + Buffer.byteLength(encryptedBody ?? "", "utf8")
    + Buffer.byteLength(JSON.stringify(metadata), "utf8");

  if (size > DEFAULT_MAX_TEXT_FEED_POST_BYTES) {
    throw new FeedError("post_too_large", "feed post is too large", 413);
  }
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized.length === 0 ? undefined : normalized;
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
    typeof recipient === "string" && recipient.startsWith("sudo:ed25519:")
  )))].slice(0, 256);
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

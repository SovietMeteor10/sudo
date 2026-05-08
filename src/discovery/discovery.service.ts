import { randomUUID } from "node:crypto";
import { generateIdentityGrid } from "../crypto/index.js";
import type { FeedPost } from "../feeds/feed.types.js";
import { getIdentityByCanonicalId } from "../identity/identity.store.js";
import type { RegistryIdentity } from "../identity/registry.js";
import { getFeedPost } from "../feeds/feed.store.js";
import type {
  DiscoveryPostIndex,
  DiscoveryReaction,
  IdentityFingerprint,
  SearchResult
} from "../protocol/types.js";
import { scoreHandle } from "./ranking.js";
import {
  insertDiscoveryReaction,
  listDiscoveryPostIndex,
  listSearchableIdentities,
  reactionExists,
  reindexDiscoveryPosts,
  refreshDiscoveryPostIndex,
  removeDiscoveryPostIndex,
  getDiscoveryPostIndex,
  upsertDiscoveryPostIndexFromFeedPost
} from "./discovery.store.js";
import { DiscoveryError } from "./discovery.types.js";

export function searchIdentityHandles(query: string): SearchResult[] {
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  return listSearchableIdentities()
    .map((row) => {
      const handleBody = row.handle.replace(/^@/, "").toLowerCase();
      const score = scoreHandle(handleBody, normalizedQuery);
      return { row, score };
    })
    .filter((item) => item.score !== null)
    .sort((left, right) => left.score! - right.score! || left.row.handle.localeCompare(right.row.handle))
    .slice(0, 10)
    .map(({ row }) => {
      const publicKey = row.identity_public_key ?? row.public_key;
      const fingerprintGrid = parseFingerprint(row.fingerprint_json) ?? generateIdentityGrid(publicKey);
      return {
        handle: row.handle,
        canonical: row.canonical_id,
        bio: "identity document",
        fingerprint: fingerprintGrid.fingerprint,
        fingerprint_grid: fingerprintGrid
      };
    });
}

export function createDiscoveryReaction(input: {
  post_id: string;
  actor_canonical_id: string;
  actor_handle?: string;
  reaction: DiscoveryReaction["reaction"];
}): { reaction: DiscoveryReaction; index: DiscoveryPostIndex } {
  const post = getFeedPost(input.post_id);
  if (post === null || post.deleted_at !== null) {
    throw new DiscoveryError("post_not_found", "feed post not found", 404);
  }

  if (!isDiscoverableVisibility(post.visibility)) {
    throw new DiscoveryError("not_discoverable", "post is not discoverable", 404);
  }

  if (reactionExists(input.post_id, input.actor_canonical_id, input.reaction)) {
    throw new DiscoveryError("duplicate_reaction", "duplicate reaction for this post", 409);
  }

  const now = new Date().toISOString();
  const reaction: DiscoveryReaction = {
    type: "sudo_discovery_reaction",
    protocol_version: "0.1.0",
    reaction_id: randomUUID(),
    post_id: input.post_id,
    actor_canonical_id: input.actor_canonical_id,
    actor_handle: input.actor_handle,
    reaction: input.reaction,
    created_at: now,
    signature: "dev-placeholder:discovery-signature-unavailable"
  };

  insertDiscoveryReaction(reaction);
  const index = refreshDiscoveryPostIndex(input.post_id);
  if (index === null) {
    throw new DiscoveryError("post_not_found", "feed post not found", 404);
  }

  return {
    reaction,
    index: decorateIndex(index)
  };
}

export function getDiscoveryPost(postId: string): DiscoveryPostIndex | null {
  const index = getDiscoveryPostIndex(postId);
  return index === null ? null : decorateIndex(index);
}

export function listDiscoveryRecent(limit = 20, offset = 0): DiscoveryPostIndex[] {
  return listDiscoveryPostIndex("recent", limit, offset).map(decorateIndex);
}

export function listDiscoveryHot(limit = 20, offset = 0): DiscoveryPostIndex[] {
  return listDiscoveryPostIndex("hot", limit, offset).map(decorateIndex);
}

export function listDiscoveryRising(limit = 20, offset = 0): DiscoveryPostIndex[] {
  return listDiscoveryPostIndex("rising", limit, offset).map(decorateIndex);
}

export function reindexDiscovery(): number {
  return reindexDiscoveryPosts();
}

export function removeDiscovery(postId: string): boolean {
  return removeDiscoveryPostIndex(postId);
}

export function upsertDiscoveryFromFeedPost(post: FeedPost): DiscoveryPostIndex | null {
  return upsertDiscoveryPostIndexFromFeedPost(post);
}

function decorateIndex(index: DiscoveryPostIndex): DiscoveryPostIndex {
  const identity = getIdentityByCanonicalId(index.author_canonical_id);
  if (identity === null) return index;

  const fingerprint = identity.document.visual_fingerprint ?? generateIdentityGrid(getIdentityPublicKey(identity));
  return {
    ...index,
    author_fingerprint_grid: fingerprint
  };
}

function isDiscoverableVisibility(visibility: string): visibility is "public" | "public_metadata_encrypted_body" {
  return visibility === "public" || visibility === "public_metadata_encrypted_body";
}

function getIdentityPublicKey(identity: RegistryIdentity): string {
  return identity.document.keys?.identity?.public_key ?? identity.document.public_key ?? "";
}

function parseFingerprint(value: string | null): IdentityFingerprint | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as IdentityFingerprint;
  } catch {
    return null;
  }
}

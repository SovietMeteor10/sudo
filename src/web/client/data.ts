import type { ChatSummary, LocalIdentity, StreamPost } from "./types.js";

// Inert default identity used before sign-in. No fake handle/bio.
export const localIdentity: LocalIdentity = {
  handle: "",
  bio: "",
  status: "locked",
  privacyMode: "account locked",
  onionState: "",
  fingerprintSnippet: "",
  portalTransport: "",
  relayTransport: "",
};

// Real feed posts come from /api/feeds. No demo posts are injected client-side.
export const streamPosts: StreamPost[] = [];

// Real chats come from local messages and contacts. No demo chats are injected.
export const chatSummaries: ChatSummary[] = [];

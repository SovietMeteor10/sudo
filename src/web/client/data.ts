import type { ChatSummary, LocalIdentity, StreamPost } from "./types.js";

// Inert default identity used before sign-in. No fake handle/bio.
// `status` and `privacyMode` are vestigial fields on LocalIdentity
// that no UI reads anymore; we leave them as empty strings instead
// of carrying the historical lock-themed placeholder copy. The
// LocalIdentity shape is the place to look if you want to clean
// these up structurally; doing so should be a separate commit
// because it touches the type definition.
export const localIdentity: LocalIdentity = {
  handle: "",
  bio: "",
  status: "",
  privacyMode: "",
  onionState: "",
  fingerprintSnippet: "",
  portalTransport: "",
  relayTransport: "",
};

// Real feed posts come from /api/feeds. No demo posts are injected client-side.
export const streamPosts: StreamPost[] = [];

// Real chats come from local messages and contacts. No demo chats are injected.
export const chatSummaries: ChatSummary[] = [];

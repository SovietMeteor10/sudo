import type {
  ChatSummary as ProtocolChatSummary,
  FeedPost as ProtocolFeedPost,
  IdentityFingerprint as ProtocolIdentityFingerprint,
  IdentityDocument as ProtocolIdentityDocument,
  SearchResult as ProtocolSearchResult,
  StreamPost as ProtocolStreamPost
} from "../../protocol/types.js";

export type IdentityDocument = ProtocolIdentityDocument;
export type IdentityFingerprint = ProtocolIdentityFingerprint;

export type LocalIdentity = {
  handle: string;
  bio: string;
  status: string;
  privacyMode: string;
  onionState: string;
  fingerprintSnippet: string;
};

export type LookupState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "resolved"; query: string; identity: IdentityDocument; fingerprint: string }
  | { status: "error"; query: string; message: string };

export type SignupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "created"; identity: IdentityDocument; fingerprint: string; backupCode: string }
  | { status: "error"; message: string };

export type SigninState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "signed_in"; identity: IdentityDocument }
  | { status: "error"; message: string };

export type SearchResult = ProtocolSearchResult;

export type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "results"; query: string; results: SearchResult[] }
  | { status: "error"; query: string; message: string };

export type StreamPost = ProtocolStreamPost;
export type FeedPost = ProtocolFeedPost;

export type ChatSummary = ProtocolChatSummary;

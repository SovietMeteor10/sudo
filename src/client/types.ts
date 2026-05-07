export type IdentityDocument = {
  handle: string;
  canonical: string;
  public_key: string;
  profile: string;
  finger: string;
  inbox: string;
  updated_at: string;
  signature: string;
};

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

export type SearchResult = {
  handle: string;
  canonical: string;
  bio: string;
  fingerprint: string;
};

export type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "results"; query: string; results: SearchResult[] }
  | { status: "error"; query: string; message: string };

export type StreamPost = {
  id: string;
  handle: string;
  at: string;
  body: string;
};

export type ChatSummary = {
  id: string;
  canonical?: string;
  handle: string;
  state: "quiet" | "draft" | "sealed";
  lastLine: string;
  fingerprint?: string;
};

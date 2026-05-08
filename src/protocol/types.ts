export type CanonicalId = string;
export type Handle = string;
export type PublicKey = string;
export type Signature = string;

export type IdentityKey = {
  type: string;
  public_key: PublicKey;
};

export type IdentityKeySet = {
  identity: IdentityKey & { type: "ed25519" };
  messaging: IdentityKey;
  feed: IdentityKey & { type: "ed25519" };
};

export type IdentityFingerprintCell = {
  x: number;
  y: number;
  on: boolean;
  color: string;
};

export type IdentityFingerprint = {
  fingerprint: string;
  grid_size: 8;
  bits: 32;
  cells: IdentityFingerprintCell[];
};

export type SignableIdentityDocument = {
  type: "sudo_identity";
  protocol_version: string;
  canonical_id: CanonicalId;
  handle: Handle;
  home_node: string;
  keys: IdentityKeySet;
  delivery_relays: string[];
  feed_endpoints: string[];
  created_at: string;
  updated_at: string;
  sequence: number;
};

export type IdentityDocument = SignableIdentityDocument & {
  signature: Signature;
  canonical?: string;
  public_key?: PublicKey;
  profile?: string;
  finger?: string;
  inbox?: string;
  visual_fingerprint?: IdentityFingerprint;
};

export type RelayEnvelopeStatus =
  | "queued_local"
  | "submitted_to_relay"
  | "stored_by_relay"
  | "delivered_to_recipient_device"
  | "acked"
  | "expired"
  | "failed"
  | "rejected";

export type RelayEnvelope = {
  type: "sudo_relay_envelope";
  protocol_version: string;
  message_id: string;
  sender_canonical_id: CanonicalId;
  recipient_canonical_id: CanonicalId;
  sender_handle?: Handle;
  recipient_handle?: Handle;
  ciphertext: string;
  ciphertext_scheme: "dev-placeholder" | string;
  created_at: string;
  expires_at: string;
  status: RelayEnvelopeStatus;
  sender_signature: Signature;
};

export type LegacyEncryptedMessageEnvelope = {
  from: Handle | CanonicalId;
  ciphertext: string;
  nonce: string;
  signature: Signature;
};

export type EncryptedMessageEnvelope = LegacyEncryptedMessageEnvelope;

export type StoredEncryptedMessage = LegacyEncryptedMessageEnvelope & {
  id: number;
  received_at: string;
};

export type SearchResult = {
  handle: string;
  canonical: string;
  bio: string;
  fingerprint: string;
  fingerprint_grid?: IdentityFingerprint;
};

export type FeedVisibility =
  | "private_message"
  | "connections_only"
  | "close_connections"
  | "unlisted"
  | "public"
  | "public_metadata_encrypted_body";

export type FeedPublicMetadata = {
  title?: string;
  summary?: string;
  tags: string[];
};

export type SignableFeedPost = {
  type: "sudo_feed_post";
  protocol_version: string;
  post_id: string;
  author_canonical_id: CanonicalId;
  author_handle?: Handle;
  visibility: FeedVisibility;
  body?: string;
  encrypted_body?: string;
  public_metadata: FeedPublicMetadata;
  allowed_recipients: CanonicalId[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sequence: number;
};

export type FeedPost = SignableFeedPost & {
  signature: Signature;
};

export type ConnectionTier = "unknown" | "known" | "close" | "blocked";

export type ConnectionRelationship = {
  type: "sudo_connection_relationship";
  owner_canonical_id: CanonicalId;
  subject_canonical_id: CanonicalId;
  subject_handle?: Handle;
  tier: ConnectionTier;
  subscribed: boolean;
  created_at: string;
  updated_at: string;
  notes?: string;
};

export type FeedSubscription = {
  type: "sudo_feed_subscription";
  owner_canonical_id: CanonicalId;
  author_canonical_id: CanonicalId;
  author_handle?: Handle;
  include_public: boolean;
  include_connections: boolean;
  include_close: boolean;
  muted: boolean;
  created_at: string;
  updated_at: string;
};

export type StreamPost = {
  id: string;
  handle: Handle;
  at: string;
  body: string;
  signature?: Signature;
};

export type DiscoveryReaction = {
  subject: CanonicalId | Handle;
  kind: "follow" | "mention" | "block" | "mute" | "unknown";
  created_at: string;
  signature?: Signature;
};

export type ChatSummary = {
  id: string;
  canonical?: string;
  handle: string;
  state: "quiet" | "draft" | "sealed";
  lastLine: string;
  fingerprint?: string;
};

export type CanonicalId = string;
export type Handle = string;
export type PublicKey = string;
export type Signature = string;

export type SigningKeyType = "ed25519" | "ecdsa-p256";
export type MessagingKeyType = "x25519" | "ecdh-p256" | "x25519_or_placeholder";
export type TransportType = "onion" | "https" | "local_dev";

export type RelayCapability = {
  type: "sudo_relay_capability";
  protocol_version: string;
  relay_id: string;
  transport: TransportType;
  url: string;
  priority: number;
  supports_store_and_forward: boolean;
  supports_ack: boolean;
  supports_unknown_sender_queue: boolean;
  max_message_bytes: number;
  unknown_sender_policy: {
    max_pending: number;
    ttl_hours: number;
  };
  known_sender_policy: {
    max_pending: number;
    ttl_days: number;
  };
};

export type IdentityKey = {
  type: SigningKeyType;
  public_key: PublicKey;
};

export type IdentityKeySet = {
  identity: IdentityKey;
  messaging: {
    type: MessagingKeyType;
    public_key: PublicKey;
  };
  feed: IdentityKey;
  device?: IdentityKey;
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
  delivery_relays: RelayCapability[];
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

export type NodeCapabilityDocument = {
  type: "sudo_node";
  protocol_version: string;
  node_id: string;
  name: string;
  public_base_url: string;
  onion_base_url: string | null;
  roles: string[];
  relay_capabilities: RelayCapability[];
  created_at: string;
  software: {
    name: "sudo";
    version: string;
  };
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

export type FeedPostKind = "post" | "repost" | "reply";

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
  kind?: FeedPostKind;
  reply_to?: string;
  repost_of?: string;
};

export type FeedPost = SignableFeedPost & {
  signature: Signature;
  // Populated server-side when the FeedPost is sent to clients so they
  // can render reposts/replies without a second round-trip. These
  // fields are NOT part of the signed canonical payload.
  repost_of_post?: FeedPost | null;
  reply_to_post?: FeedPost | null;
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

export type TrustedDevice = {
  type: "sudo_trusted_device";
  device_id: string;
  owner_canonical_id: CanonicalId;
  name: string;
  created_at: string;
  last_seen_at: string;
  trust_state: "active" | "revoked";
  device_public_key: PublicKey;
  capabilities: {
    can_sync: boolean;
    can_decrypt: boolean;
  };
};

export type DeviceSyncEvent = {
  type: "sudo_device_sync_event";
  event_id: string;
  owner_canonical_id: CanonicalId;
  device_id: string;
  event_type: string;
  created_at: string;
  encrypted_payload: string;
};

export type StreamPost = {
  id: string;
  handle: Handle;
  at: string;
  body: string;
  signature?: Signature;
};

export type DiscoveryReaction = {
  type: "sudo_discovery_reaction";
  protocol_version: string;
  reaction_id: string;
  post_id: string;
  actor_canonical_id: CanonicalId;
  actor_handle?: Handle;
  reaction: "recommend" | "downrank" | "reply" | "repost" | "report";
  created_at: string;
  signature: Signature;
};

export type DiscoveryPostIndex = {
  post_id: string;
  author_canonical_id: CanonicalId;
  author_handle?: Handle;
  visibility: "public" | "unlisted" | "public_metadata_encrypted_body";
  public_metadata: FeedPublicMetadata;
  body_excerpt: string;
  created_at: string;
  recommend_count: number;
  downrank_count: number;
  reply_count: number;
  repost_count: number;
  report_count: number;
  hot_score: number;
  rising_score: number;
  explanation: string;
  author_fingerprint_grid?: IdentityFingerprint;
  // Populated when the index is fetched with a viewer canonical id so
  // the client can render the user's vote state. Not part of the
  // ranking model — purely a UX read-through.
  viewer_reaction?: "recommend" | "downrank" | "reply" | "repost" | "report" | null;
  viewer_has_reposted?: boolean;
};

export type ChatSummary = {
  id: string;
  canonical?: string;
  handle: string;
  state: "quiet" | "draft" | "sealed";
  lastLine: string;
  fingerprint?: string;
};

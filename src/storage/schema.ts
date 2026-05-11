export const schemaSql = `
  CREATE TABLE IF NOT EXISTS identities (
    canonical_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    canonical TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    finger_url TEXT NOT NULL,
    inbox_url TEXT NOT NULL,
    home_node TEXT,
    identity_public_key TEXT,
    messaging_public_key TEXT,
    feed_public_key TEXT,
    document_json TEXT,
    fingerprint_json TEXT,
    created_at TEXT,
    updated_at TEXT NOT NULL,
    sequence INTEGER,
    signature TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS encrypted_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    signature TEXT NOT NULL,
    received_at TEXT NOT NULL,
    FOREIGN KEY (canonical_id) REFERENCES identities(canonical_id)
  );

  CREATE INDEX IF NOT EXISTS encrypted_messages_canonical_id_idx
    ON encrypted_messages(canonical_id, received_at);

  CREATE TABLE IF NOT EXISTS relay_envelopes (
    message_id TEXT PRIMARY KEY,
    sender_canonical_id TEXT NOT NULL,
    recipient_canonical_id TEXT NOT NULL,
    sender_handle TEXT,
    recipient_handle TEXT,
    ciphertext TEXT NOT NULL,
    ciphertext_scheme TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    sender_signature TEXT,
    envelope_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS relay_envelopes_recipient_status_idx
    ON relay_envelopes(recipient_canonical_id, status);

  CREATE INDEX IF NOT EXISTS relay_envelopes_sender_status_idx
    ON relay_envelopes(sender_canonical_id, status);

  CREATE INDEX IF NOT EXISTS relay_envelopes_expires_at_idx
    ON relay_envelopes(expires_at);

  CREATE INDEX IF NOT EXISTS relay_envelopes_pair_status_idx
    ON relay_envelopes(sender_canonical_id, recipient_canonical_id, status);

  CREATE TABLE IF NOT EXISTS relay_relationships (
    sender_canonical_id TEXT NOT NULL,
    recipient_canonical_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (sender_canonical_id, recipient_canonical_id)
  );

  CREATE TABLE IF NOT EXISTS connections (
    owner_canonical_id TEXT NOT NULL,
    subject_canonical_id TEXT NOT NULL,
    subject_handle TEXT,
    tier TEXT NOT NULL,
    subscribed INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_canonical_id, subject_canonical_id)
  );

  CREATE INDEX IF NOT EXISTS connections_owner_tier_idx
    ON connections(owner_canonical_id, tier);

  CREATE INDEX IF NOT EXISTS connections_subject_tier_idx
    ON connections(subject_canonical_id, tier);

  CREATE TABLE IF NOT EXISTS feed_subscriptions (
    owner_canonical_id TEXT NOT NULL,
    author_canonical_id TEXT NOT NULL,
    author_handle TEXT,
    include_public INTEGER NOT NULL DEFAULT 1,
    include_connections INTEGER NOT NULL DEFAULT 1,
    include_close INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_canonical_id, author_canonical_id)
  );

  CREATE INDEX IF NOT EXISTS feed_subscriptions_owner_muted_idx
    ON feed_subscriptions(owner_canonical_id, muted);

  CREATE INDEX IF NOT EXISTS feed_subscriptions_author_idx
    ON feed_subscriptions(author_canonical_id);

  CREATE TABLE IF NOT EXISTS trusted_devices (
    device_id TEXT PRIMARY KEY,
    owner_canonical_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    device_public_key TEXT NOT NULL,
    capabilities_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS trusted_devices_owner_idx
    ON trusted_devices(owner_canonical_id);

  CREATE INDEX IF NOT EXISTS trusted_devices_trust_state_idx
    ON trusted_devices(trust_state);

  CREATE TABLE IF NOT EXISTS device_sync_events (
    event_id TEXT PRIMARY KEY,
    owner_canonical_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS device_sync_events_owner_created_at_idx
    ON device_sync_events(owner_canonical_id, created_at);

  CREATE INDEX IF NOT EXISTS device_sync_events_device_created_at_idx
    ON device_sync_events(device_id, created_at);

  CREATE TABLE IF NOT EXISTS device_pairing_tokens (
    pairing_token TEXT PRIMARY KEY,
    owner_canonical_id TEXT NOT NULL,
    pairing_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    encrypted_account_bundle TEXT
  );

  CREATE INDEX IF NOT EXISTS device_pairing_tokens_code_idx
    ON device_pairing_tokens(pairing_code);

  -- Canonical trust object for trusted devices: the SignedDeviceMembership
  -- doc, signed by the owner's identity key. trusted_devices above is an
  -- index/cache derived from these rows so reads stay cheap; the index can
  -- be rebuilt from device_memberships if it's lost.
  CREATE TABLE IF NOT EXISTS device_memberships (
    device_id TEXT NOT NULL,
    owner_canonical_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    trust_state TEXT NOT NULL,
    membership_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS device_memberships_owner_idx
    ON device_memberships(owner_canonical_id, updated_at);

  CREATE INDEX IF NOT EXISTS device_memberships_device_idx
    ON device_memberships(device_id, sequence);

  -- Encrypted-only relay queue for SignedSyncEvent. The server stores
  -- ciphertext + signed envelope, never plaintext. server_seq is the
  -- monotonic cursor; (owner, origin_device, origin_device_seq) is
  -- unique to enforce per-device replay protection. This is a relay
  -- queue, not canonical storage — IndexedDB on each device remains
  -- the source of truth for the projected state.
  CREATE TABLE IF NOT EXISTS device_sync_log (
    server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    owner_canonical_id TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    origin_device_seq INTEGER NOT NULL,
    slice TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    server_received_at TEXT NOT NULL,
    signed_event_json TEXT NOT NULL,
    UNIQUE (owner_canonical_id, origin_device_id, origin_device_seq)
  );

  CREATE INDEX IF NOT EXISTS device_sync_log_owner_seq_idx
    ON device_sync_log(owner_canonical_id, server_seq);

  CREATE INDEX IF NOT EXISTS device_sync_log_origin_seq_idx
    ON device_sync_log(owner_canonical_id, origin_device_id, origin_device_seq);

  CREATE TABLE IF NOT EXISTS device_sync_cursors (
    owner_canonical_id TEXT NOT NULL,
    recipient_device_id TEXT NOT NULL,
    last_server_seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_canonical_id, recipient_device_id)
  );

  CREATE TABLE IF NOT EXISTS feed_posts (
    post_id TEXT PRIMARY KEY,
    author_canonical_id TEXT NOT NULL,
    author_handle TEXT,
    visibility TEXT NOT NULL,
    body TEXT,
    encrypted_body TEXT,
    public_metadata_json TEXT,
    allowed_recipients_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    sequence INTEGER NOT NULL,
    signature TEXT,
    kind TEXT,
    reply_to TEXT,
    repost_of TEXT,
    post_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS feed_posts_author_created_at_idx
    ON feed_posts(author_canonical_id, created_at);

  CREATE INDEX IF NOT EXISTS feed_posts_visibility_created_at_idx
    ON feed_posts(visibility, created_at);

  CREATE INDEX IF NOT EXISTS feed_posts_created_at_idx
    ON feed_posts(created_at);

  CREATE INDEX IF NOT EXISTS feed_posts_deleted_at_idx
    ON feed_posts(deleted_at);

  -- feed_posts_reply_to_idx and feed_posts_repost_of_idx are created in
  -- runMigrations() after addColumnIfMissing() guarantees the columns
  -- exist on legacy databases.

  CREATE TABLE IF NOT EXISTS discovery_reactions (
    reaction_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    actor_canonical_id TEXT NOT NULL,
    actor_handle TEXT,
    reaction TEXT NOT NULL,
    created_at TEXT NOT NULL,
    signature TEXT,
    reaction_json TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS discovery_reactions_actor_post_reaction_unique
    ON discovery_reactions(post_id, actor_canonical_id, reaction);

  CREATE INDEX IF NOT EXISTS discovery_reactions_post_reaction_idx
    ON discovery_reactions(post_id, reaction);

  CREATE INDEX IF NOT EXISTS discovery_reactions_actor_created_at_idx
    ON discovery_reactions(actor_canonical_id, created_at);

  CREATE TABLE IF NOT EXISTS discovery_post_index (
    post_id TEXT PRIMARY KEY,
    author_canonical_id TEXT NOT NULL,
    author_handle TEXT,
    visibility TEXT NOT NULL,
    public_metadata_json TEXT,
    body_excerpt TEXT,
    created_at TEXT NOT NULL,
    recommend_count INTEGER NOT NULL DEFAULT 0,
    downrank_count INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    repost_count INTEGER NOT NULL DEFAULT 0,
    report_count INTEGER NOT NULL DEFAULT 0,
    hot_score REAL NOT NULL DEFAULT 0,
    rising_score REAL NOT NULL DEFAULT 0,
    explanation TEXT
  );

  CREATE INDEX IF NOT EXISTS discovery_post_index_hot_score_idx
    ON discovery_post_index(hot_score);

  CREATE INDEX IF NOT EXISTS discovery_post_index_rising_score_idx
    ON discovery_post_index(rising_score);

  CREATE INDEX IF NOT EXISTS discovery_post_index_created_at_idx
    ON discovery_post_index(created_at);

  CREATE INDEX IF NOT EXISTS discovery_post_index_visibility_idx
    ON discovery_post_index(visibility);

  -- dev_account_access dropped in migration step 6. The table held
  -- password salts, password hashes, recovery answer hashes, and
  -- recovery secret hashes for the legacy /api/identity/{signup,signin,
  -- recover} surface; all three routes are gone, every account is
  -- client-key only, and runMigrations() drops the table on existing
  -- databases.

  CREATE TABLE IF NOT EXISTS dev_sessions (
    token_hash TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (canonical_id) REFERENCES identities(canonical_id)
  );

  CREATE INDEX IF NOT EXISTS dev_sessions_canonical_id_idx
    ON dev_sessions(canonical_id, expires_at);

  -- Single-use, short-TTL nonces issued by GET /api/identity/challenge
  -- and consumed by POST /api/identity/session-from-challenge. The
  -- nonce is the primary key (cryptographically random, ~256 bits) so
  -- replay protection comes for free: consume = DELETE, second attempt
  -- finds no row.
  CREATE TABLE IF NOT EXISTS identity_challenges (
    nonce TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (canonical_id) REFERENCES identities(canonical_id)
  );

  CREATE INDEX IF NOT EXISTS identity_challenges_canonical_idx
    ON identity_challenges(canonical_id, expires_at);
`;

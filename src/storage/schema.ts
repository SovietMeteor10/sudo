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

  CREATE TABLE IF NOT EXISTS dev_account_access (
    canonical_id TEXT PRIMARY KEY,
    password_salt TEXT,
    password_hash TEXT,
    recovery_secret_hash TEXT NOT NULL,
    recovery_phrase_salt TEXT,
    recovery_phrase_hash TEXT,
    recovery_question TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (canonical_id) REFERENCES identities(canonical_id)
  );

  CREATE TABLE IF NOT EXISTS dev_sessions (
    token_hash TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (canonical_id) REFERENCES identities(canonical_id)
  );

  CREATE INDEX IF NOT EXISTS dev_sessions_canonical_id_idx
    ON dev_sessions(canonical_id, expires_at);
`;

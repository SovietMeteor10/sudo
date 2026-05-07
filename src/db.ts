import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databasePath = resolve(process.env.SUDO_DB_PATH ?? "data/sudo.sqlite");

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    handle TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL UNIQUE,
    canonical TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    finger_url TEXT NOT NULL,
    inbox_url TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
`);

const devAccountColumns = db
  .prepare("PRAGMA table_info(dev_account_access)")
  .all() as Array<{ name: string }>;
const devAccountColumnNames = new Set(devAccountColumns.map((column) => column.name));

if (!devAccountColumnNames.has("recovery_phrase_salt")) {
  db.exec("ALTER TABLE dev_account_access ADD COLUMN recovery_phrase_salt TEXT");
}

if (!devAccountColumnNames.has("recovery_phrase_hash")) {
  db.exec("ALTER TABLE dev_account_access ADD COLUMN recovery_phrase_hash TEXT");
}

if (!devAccountColumnNames.has("password_salt")) {
  db.exec("ALTER TABLE dev_account_access ADD COLUMN password_salt TEXT");
}

if (!devAccountColumnNames.has("password_hash")) {
  db.exec("ALTER TABLE dev_account_access ADD COLUMN password_hash TEXT");
}

if (!devAccountColumnNames.has("recovery_question")) {
  db.exec("ALTER TABLE dev_account_access ADD COLUMN recovery_question TEXT");
}

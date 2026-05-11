import type Database from "better-sqlite3";
import { schemaSql } from "./schema.js";

export function runMigrations(db: Database.Database): void {
  db.exec(schemaSql);
  addColumnIfMissing(db, "identities", "home_node", "TEXT");
  addColumnIfMissing(db, "identities", "identity_public_key", "TEXT");
  addColumnIfMissing(db, "identities", "messaging_public_key", "TEXT");
  addColumnIfMissing(db, "identities", "feed_public_key", "TEXT");
  addColumnIfMissing(db, "identities", "document_json", "TEXT");
  addColumnIfMissing(db, "identities", "fingerprint_json", "TEXT");
  addColumnIfMissing(db, "identities", "created_at", "TEXT");
  addColumnIfMissing(db, "identities", "sequence", "INTEGER");

  addColumnIfMissing(db, "connections", "subject_handle", "TEXT");
  addColumnIfMissing(db, "connections", "notes", "TEXT");
  addColumnIfMissing(db, "connections", "subscribed", "INTEGER");
  addColumnIfMissing(db, "feed_subscriptions", "author_handle", "TEXT");
  addColumnIfMissing(db, "feed_subscriptions", "include_public", "INTEGER");
  addColumnIfMissing(db, "feed_subscriptions", "include_connections", "INTEGER");
  addColumnIfMissing(db, "feed_subscriptions", "include_close", "INTEGER");
  addColumnIfMissing(db, "feed_subscriptions", "muted", "INTEGER");

  addColumnIfMissing(db, "trusted_devices", "owner_canonical_id", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "name", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "created_at", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "last_seen_at", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "trust_state", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "device_public_key", "TEXT");
  addColumnIfMissing(db, "trusted_devices", "capabilities_json", "TEXT");

  addColumnIfMissing(db, "device_sync_events", "owner_canonical_id", "TEXT");
  addColumnIfMissing(db, "device_sync_events", "device_id", "TEXT");
  addColumnIfMissing(db, "device_sync_events", "event_type", "TEXT");
  addColumnIfMissing(db, "device_sync_events", "created_at", "TEXT");
  addColumnIfMissing(db, "device_sync_events", "encrypted_payload", "TEXT");

  addColumnIfMissing(db, "feed_posts", "kind", "TEXT");
  addColumnIfMissing(db, "feed_posts", "reply_to", "TEXT");
  addColumnIfMissing(db, "feed_posts", "repost_of", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS feed_posts_reply_to_idx ON feed_posts(reply_to)");
  db.exec("CREATE INDEX IF NOT EXISTS feed_posts_repost_of_idx ON feed_posts(repost_of)");
  // Replies are top-level-feed-excluded as of this fix; older
  // databases may still hold reply rows in discovery_post_index.
  // Drop them so discover doesn't surface stale standalone reply
  // cards.
  db.exec(`
    DELETE FROM discovery_post_index
    WHERE post_id IN (
      SELECT post_id FROM feed_posts WHERE reply_to IS NOT NULL
    )
  `);

  addColumnIfMissing(db, "discovery_reactions", "actor_handle", "TEXT");
  addColumnIfMissing(db, "discovery_reactions", "signature", "TEXT");
  addColumnIfMissing(db, "discovery_post_index", "public_metadata_json", "TEXT");
  addColumnIfMissing(db, "discovery_post_index", "body_excerpt", "TEXT");
  addColumnIfMissing(db, "discovery_post_index", "recommend_count", "INTEGER");
  addColumnIfMissing(db, "discovery_post_index", "downrank_count", "INTEGER");
  addColumnIfMissing(db, "discovery_post_index", "reply_count", "INTEGER");
  addColumnIfMissing(db, "discovery_post_index", "repost_count", "INTEGER");
  addColumnIfMissing(db, "discovery_post_index", "report_count", "INTEGER");
  addColumnIfMissing(db, "discovery_post_index", "hot_score", "REAL");
  addColumnIfMissing(db, "discovery_post_index", "rising_score", "REAL");
  addColumnIfMissing(db, "discovery_post_index", "explanation", "TEXT");

  // dev_account_access dropped in migration step 6. The legacy
  // /api/identity/{signup,signin,recover} surface that wrote and read
  // it is gone. DROP TABLE IF EXISTS so existing droplets shed the
  // table on first restart after this build lands; new installs
  // never create it (schema.ts no longer declares it).
  db.exec("DROP TABLE IF EXISTS dev_account_access");
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

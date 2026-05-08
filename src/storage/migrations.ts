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

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

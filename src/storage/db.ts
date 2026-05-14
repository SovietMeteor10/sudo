import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readNodeRuntimeConfig } from "../node/node.config.js";
import { runMigrations } from "./migrations.js";

const databasePath = readNodeRuntimeConfig().dbPath;

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Phase 14 MED-4: better-sqlite3 honors busy_timeout natively. Without
// it, a concurrent writer (smoke harness, periodic sweep, or a
// co-located sqlite3 CLI session) briefly holding the writer lock
// surfaces SQLITE_BUSY as a 500 to the client. 5 seconds lets the
// blocked statement retry transparently and is well below any
// reasonable HTTP timeout.
db.pragma("busy_timeout = 5000");

runMigrations(db);

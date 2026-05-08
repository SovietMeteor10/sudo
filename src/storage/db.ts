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

runMigrations(db);

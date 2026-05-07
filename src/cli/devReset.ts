import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dataPath = resolve("data");

console.warn("sudo dev reset: destructive local-dev only");
console.warn("deleting local SQLite registry, dev sessions, recovery hashes, and dev keys under data/");

if (existsSync(dataPath)) {
  rmSync(dataPath, { recursive: true, force: true });
}

mkdirSync(resolve(dataPath, "keys"), { recursive: true });
writeFileSync(resolve(dataPath, "keys/.gitkeep"), "");

const { db } = await import("../db.js");
db.close();

console.log("sudo dev reset complete");

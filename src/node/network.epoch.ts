// Phase 13: NETWORK_EPOCH — the network's generation marker.
//
// The epoch is an opaque string (a UUID v4 by default) persisted at
// `${dataDir}/.epoch`. Stale clients from a previous network
// generation compare this value to the one they last saw and, on
// mismatch, wipe their local IndexedDB + service-worker caches so
// they reconnect as a clean device.
//
// The reset script writes a fresh epoch value as part of the
// genesis-reset workflow. If the file is missing, the server mints
// a stable value at boot (so first-run installs don't keep churning
// clients).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readNodeRuntimeConfig } from "./node.config.js";

let cachedEpoch: string | null = null;

function epochFilePath(): string {
  const dir = readNodeRuntimeConfig().dataDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, ".epoch");
}

export function getNetworkEpoch(): string {
  if (cachedEpoch !== null) return cachedEpoch;
  const path = epochFilePath();
  if (existsSync(path)) {
    try {
      const value = readFileSync(path, "utf-8").trim();
      if (value.length > 0) {
        cachedEpoch = value;
        return value;
      }
    } catch { /* fall through to mint */ }
  }
  const fresh = randomUUID();
  try { writeFileSync(path, fresh, { mode: 0o644 }); }
  catch { /* keep in-memory even if persistence failed */ }
  cachedEpoch = fresh;
  return fresh;
}

// Used by scripts/reset-network.cjs — writes a new epoch + flushes
// the cache so a subsequent in-process read picks it up. Restart of
// the server is the real intended consumer; this helper exists for
// dev-loop in-process tests.
export function setNetworkEpoch(value: string): void {
  writeFileSync(epochFilePath(), value, { mode: 0o644 });
  cachedEpoch = value;
}

export function resetCachedNetworkEpoch(): void {
  cachedEpoch = null;
}

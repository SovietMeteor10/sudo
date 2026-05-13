// Phase 11.1: orphan-blob GC.
//
// The relay can't tell which blobs are referenced by which envelopes
// (attachment metadata is encrypted inside sudo_attachment_v1
// envelopes — Phase 8), so "orphan" can't be defined by reference
// counting. Instead we use access lifecycle: a blob whose
// last_accessed_at is older than the operator's retention window is
// presumed orphaned and deleted. The bookkeeping table's
// last_accessed_at is bumped on every download, so an actively
// referenced blob never goes stale.
//
// Conservative deletion guarantees:
//   - We never delete a blob whose last_accessed_at is within the
//     retention window. Bytes on disk WITH a corresponding DB row
//     but not yet stale are skipped.
//   - We never delete a blob that has no DB row (legacy / pre-11.1
//     blobs) without an explicit opt-in flag. The default sweep
//     only touches blobs we have full provenance for.
//   - We always delete the SQLite row before the file, so a crash
//     between the two leaves a bytes-on-disk-only state which is
//     recoverable (the next sweep will pick it up under the
//     prune-untracked path).

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { readNodeRuntimeConfig } from "../node/node.config.js";
import { deleteMediaBlob, getMediaBlob, listStaleMediaBlobs } from "./media.store.js";

const MAX_SWEEP_BATCH = 200;

export type OrphanGcResult = {
  retention_days: number;
  cutoff_iso: string;
  dry_run: boolean;
  candidates_found: number;
  bytes_freed: number;
  rows_deleted: number;
  files_deleted: number;
  errors: number;
};

// Sweep one batch of stale blobs. Returns counts so the caller (a
// timer or the dev diagnostics view) can summarize the work.
//
// `dryRun=true` returns the candidate set without deleting anything.
// This is the operator's first-look mode and the path the dry-run
// dev smoke exercises.
export function runOrphanBlobGc(options: { dryRun?: boolean } = {}): OrphanGcResult {
  const config = readNodeRuntimeConfig();
  const retentionDays = Math.max(1, config.mediaRetentionDays);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const dryRun = options.dryRun === true;

  const stale = listStaleMediaBlobs(cutoffIso, MAX_SWEEP_BATCH);
  const result: OrphanGcResult = {
    retention_days: retentionDays,
    cutoff_iso: cutoffIso,
    dry_run: dryRun,
    candidates_found: stale.length,
    bytes_freed: 0,
    rows_deleted: 0,
    files_deleted: 0,
    errors: 0
  };
  if (dryRun) {
    for (const row of stale) result.bytes_freed += row.size_bytes;
    return result;
  }

  const dir = resolve(config.dataDir, "media");
  for (const row of stale) {
    // Defense in depth: the blob_id regex is a tight fixed alphabet
    // so path traversal is impossible, but rebuild the resolved path
    // and verify it stays inside the media dir anyway.
    const path = resolve(dir, row.blob_id);
    if (!path.startsWith(dir)) { result.errors++; continue; }
    try {
      // SQLite row first so a crash mid-sweep doesn't leave a row
      // pointing at a deleted file (which would mis-tally the
      // owner's quota). The reverse — file gone, row present — is
      // a benign leak that the next sweep cleans up.
      deleteMediaBlob(row.blob_id);
      result.rows_deleted++;
      if (existsSync(path)) {
        unlinkSync(path);
        result.files_deleted++;
      }
      result.bytes_freed += row.size_bytes;
    } catch {
      result.errors++;
    }
  }
  return result;
}

// Operator diagnostic: find files on disk that have no SQLite row.
// These are either pre-11.1 legacy blobs (created before the
// bookkeeping table existed) or post-crash leftovers from a failed
// upload. The default GC does NOT delete these; the dev diagnostic
// just surfaces the count.
export function listUntrackedBlobs(): { blob_id: string; size_bytes: number; mtime: string }[] {
  const dir = resolve(readNodeRuntimeConfig().dataDir, "media");
  if (!existsSync(dir)) return [];
  const out: { blob_id: string; size_bytes: number; mtime: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{32}$/.test(name)) continue;
    const path = resolve(dir, name);
    if (!path.startsWith(dir)) continue;
    // One SQL roundtrip per disk entry. The media dir is small in
    // dev; production sweeps can move this to a JOIN if it grows.
    if (getMediaBlob(name) === undefined) {
      try {
        const stat = statSync(path);
        out.push({ blob_id: name, size_bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
      } catch { /* ignore */ }
    }
  }
  return out;
}

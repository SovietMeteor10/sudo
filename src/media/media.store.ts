// Phase 11.1: media-blob bookkeeping store.
//
// The blob bytes themselves are written to disk by media.routes.ts.
// This module owns the SQLite row that tracks size + access time +
// (optionally) the canonical_id that uploaded it, so we can enforce
// per-owner quotas and run the orphan-blob GC without touching the
// ciphertext on disk.

import { db } from "../storage/db.js";

export type MediaBlobRow = {
  blob_id: string;
  size_bytes: number;
  media_class: string;
  uploader_canonical_id: string | null;
  created_at: string;
  last_accessed_at: string;
};

// Insert a new row right after the bytes finish landing on disk.
// Idempotent on conflict so a re-upload with the same blob_id (which
// shouldn't happen — blob_ids are 32 random hex chars — but defensive)
// doesn't blow up.
export function recordMediaBlob(row: MediaBlobRow): void {
  db.prepare(`
    INSERT INTO media_blobs (
      blob_id, size_bytes, media_class, uploader_canonical_id,
      created_at, last_accessed_at
    ) VALUES (
      @blob_id, @size_bytes, @media_class, @uploader_canonical_id,
      @created_at, @last_accessed_at
    )
    ON CONFLICT (blob_id) DO NOTHING
  `).run(row);
}

// Mark a blob as accessed. Called from the download handler so the
// orphan GC's "stale = no access in N days" heuristic stays accurate.
// Cheap UPDATE; we don't bother batching since download volume is
// bounded by the per-IP rate limit anyway.
export function markMediaBlobAccessed(blobId: string, now: string): void {
  db.prepare(`
    UPDATE media_blobs SET last_accessed_at = ?
    WHERE blob_id = ?
  `).run(now, blobId);
}

export function getMediaBlob(blobId: string): MediaBlobRow | undefined {
  return db.prepare(`SELECT * FROM media_blobs WHERE blob_id = ?`).get(blobId) as MediaBlobRow | undefined;
}

// Total bytes attributed to one uploader. NULL uploader_canonical_id
// (anonymous uploads) are excluded from per-owner totals.
export function getMediaBytesForUploader(canonicalId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS total
    FROM media_blobs
    WHERE uploader_canonical_id = ?
  `).get(canonicalId) as { total: number } | undefined;
  return row?.total ?? 0;
}

// Orphan-blob GC: rows last accessed before the cutoff. The caller
// (media.gc.ts) decides what to do with the bytes on disk; we just
// surface the candidate list.
export function listStaleMediaBlobs(cutoffIso: string, limit: number): MediaBlobRow[] {
  return db.prepare(`
    SELECT * FROM media_blobs
    WHERE last_accessed_at < ?
    ORDER BY last_accessed_at ASC
    LIMIT ?
  `).all(cutoffIso, limit) as MediaBlobRow[];
}

export function deleteMediaBlob(blobId: string): void {
  db.prepare(`DELETE FROM media_blobs WHERE blob_id = ?`).run(blobId);
}

// Aggregate stats — used by dev diagnostics.
export function summarizeMediaStorage(): {
  total_blobs: number;
  total_bytes: number;
  by_class: { media_class: string; count: number; bytes: number }[];
  top_uploaders: { canonical_id: string; count: number; bytes: number }[];
} {
  const totals = db.prepare(`
    SELECT COUNT(*) AS total_blobs, COALESCE(SUM(size_bytes), 0) AS total_bytes
    FROM media_blobs
  `).get() as { total_blobs: number; total_bytes: number };
  const byClass = db.prepare(`
    SELECT media_class, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
    FROM media_blobs
    GROUP BY media_class
  `).all() as { media_class: string; count: number; bytes: number }[];
  const topUploaders = db.prepare(`
    SELECT uploader_canonical_id AS canonical_id, COUNT(*) AS count,
           COALESCE(SUM(size_bytes), 0) AS bytes
    FROM media_blobs
    WHERE uploader_canonical_id IS NOT NULL
    GROUP BY uploader_canonical_id
    ORDER BY bytes DESC
    LIMIT 10
  `).all() as { canonical_id: string; count: number; bytes: number }[];
  return { ...totals, by_class: byClass, top_uploaders: topUploaders };
}

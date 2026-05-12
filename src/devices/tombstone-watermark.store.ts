// Per-(owner, origin_device) tombstone purge watermark.
//
// A row asserts: "events from <origin_device_id> with
// sequence ≤ purged_before_sequence have been declared
// permanently retired by <origin_device_id>. The relay must
// reject message.upsert events at or below this sequence; the
// client projector must drop them on receipt."
//
// The watermark is only authoritative when set by the originating
// device — only origin_device_id can advance its own watermark.
// Server enforces this in the route handler by checking that
// event.origin_device_id === payload.origin_device_id.

import { db } from "../storage/db.js";

export type TombstoneWatermarkRow = {
  owner_canonical_id: string;
  origin_device_id: string;
  purged_before_sequence: number;
  updated_at: string;
};

// Upsert with a "never regress" guard: a watermark can only move
// forward. A late-arriving older watermark event must not undo a
// newer one that's already in place.
const upsertStmt = db.prepare(`
  INSERT INTO tombstone_watermarks (
    owner_canonical_id, origin_device_id, purged_before_sequence, updated_at
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_canonical_id, origin_device_id) DO UPDATE SET
    purged_before_sequence = MAX(purged_before_sequence, excluded.purged_before_sequence),
    updated_at = CASE
      WHEN excluded.purged_before_sequence > purged_before_sequence
      THEN excluded.updated_at
      ELSE updated_at
    END
`);

const getStmt = db.prepare(`
  SELECT owner_canonical_id, origin_device_id, purged_before_sequence, updated_at
  FROM tombstone_watermarks
  WHERE owner_canonical_id = ? AND origin_device_id = ?
`);

const listForOwnerStmt = db.prepare(`
  SELECT owner_canonical_id, origin_device_id, purged_before_sequence, updated_at
  FROM tombstone_watermarks
  WHERE owner_canonical_id = ?
  ORDER BY origin_device_id ASC
`);

const listAllStmt = db.prepare(`
  SELECT owner_canonical_id, origin_device_id, purged_before_sequence, updated_at
  FROM tombstone_watermarks
  ORDER BY owner_canonical_id, origin_device_id
`);

export function upsertTombstoneWatermark(
  ownerCanonicalId: string,
  originDeviceId: string,
  purgedBeforeSequence: number,
  now = new Date()
): TombstoneWatermarkRow {
  upsertStmt.run(ownerCanonicalId, originDeviceId, purgedBeforeSequence, now.toISOString());
  return getStmt.get(ownerCanonicalId, originDeviceId) as TombstoneWatermarkRow;
}

export function getTombstoneWatermark(
  ownerCanonicalId: string,
  originDeviceId: string
): TombstoneWatermarkRow | null {
  const row = getStmt.get(ownerCanonicalId, originDeviceId) as TombstoneWatermarkRow | undefined;
  return row ?? null;
}

export function listTombstoneWatermarksForOwner(
  ownerCanonicalId: string
): TombstoneWatermarkRow[] {
  return listForOwnerStmt.all(ownerCanonicalId) as TombstoneWatermarkRow[];
}

export function listAllTombstoneWatermarks(): TombstoneWatermarkRow[] {
  return listAllStmt.all() as TombstoneWatermarkRow[];
}

// Per-process counter of `message.upsert` events rejected because
// they fell below an origin device's announced watermark. Exposed
// via the dev diagnostics endpoint; never user-visible.
let staleUpsertRejectionCount = 0;
export function noteStaleUpsertRejected(): void {
  staleUpsertRejectionCount++;
}
export function readStaleUpsertRejectionCount(): number {
  return staleUpsertRejectionCount;
}
export function __resetStaleUpsertRejectionCountForTests(): void {
  staleUpsertRejectionCount = 0;
}

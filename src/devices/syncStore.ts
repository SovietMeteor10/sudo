// Server-side relay queue for SignedSyncEvent. Stores ciphertext-only
// envelopes; the server never decrypts the payload. Backed by
// device_sync_log + device_sync_cursors. The canonical projected state
// lives in each device's IndexedDB — this table is just a transport.

import { db } from "../storage/db.js";
import type { SignedSyncEvent } from "../protocol/types.js";

type SyncLogRow = {
  server_seq: number;
  event_id: string;
  owner_canonical_id: string;
  origin_device_id: string;
  origin_device_seq: number;
  slice: string;
  kind: string;
  created_at: string;
  server_received_at: string;
  signed_event_json: string;
};

export type StoredSyncEvent = {
  server_seq: number;
  signed_event: SignedSyncEvent;
};

export type InsertSyncResult =
  | { ok: true; created: true; server_seq: number; event: SignedSyncEvent }
  | { ok: true; created: false; server_seq: number; event: SignedSyncEvent }
  | { ok: false; error: "sequence_regression" };

export function insertSyncEvent(event: SignedSyncEvent): InsertSyncResult {
  // Idempotent on event_id: a retried POST with the same event_id
  // returns the existing row instead of creating a duplicate.
  const existing = db
    .prepare("SELECT * FROM device_sync_log WHERE event_id = ?")
    .get(event.event_id) as SyncLogRow | undefined;
  if (existing !== undefined) {
    return {
      ok: true,
      created: false,
      server_seq: existing.server_seq,
      event: JSON.parse(existing.signed_event_json) as SignedSyncEvent
    };
  }

  const maxSeq = getMaxOriginSequence(event.owner_canonical_id, event.origin_device_id);
  if (event.sequence <= maxSeq) {
    return { ok: false, error: "sequence_regression" };
  }

  const result = db.prepare(`
    INSERT INTO device_sync_log (
      event_id,
      owner_canonical_id,
      origin_device_id,
      origin_device_seq,
      slice,
      kind,
      created_at,
      server_received_at,
      signed_event_json
    ) VALUES (
      @event_id,
      @owner_canonical_id,
      @origin_device_id,
      @origin_device_seq,
      @slice,
      @kind,
      @created_at,
      @server_received_at,
      @signed_event_json
    )
  `).run({
    event_id: event.event_id,
    owner_canonical_id: event.owner_canonical_id,
    origin_device_id: event.origin_device_id,
    origin_device_seq: event.sequence,
    slice: event.slice,
    kind: event.kind,
    created_at: event.created_at,
    server_received_at: new Date().toISOString(),
    signed_event_json: JSON.stringify(event)
  });

  return {
    ok: true,
    created: true,
    server_seq: Number(result.lastInsertRowid),
    event
  };
}

export function getMaxOriginSequence(ownerCanonicalId: string, originDeviceId: string): number {
  const row = db
    .prepare(`
      SELECT MAX(origin_device_seq) AS max_seq
      FROM device_sync_log
      WHERE owner_canonical_id = ? AND origin_device_id = ?
    `)
    .get(ownerCanonicalId, originDeviceId) as { max_seq: number | null };
  return row.max_seq ?? 0;
}

export function listSyncEventsSince(
  ownerCanonicalId: string,
  sinceServerSeq: number,
  limit: number
): StoredSyncEvent[] {
  const rows = db
    .prepare(`
      SELECT * FROM device_sync_log
      WHERE owner_canonical_id = ? AND server_seq > ?
      ORDER BY server_seq ASC
      LIMIT ?
    `)
    .all(ownerCanonicalId, sinceServerSeq, limit) as SyncLogRow[];
  return rows.map((row) => ({
    server_seq: row.server_seq,
    signed_event: JSON.parse(row.signed_event_json) as SignedSyncEvent
  }));
}

export function setRecipientCursor(
  ownerCanonicalId: string,
  recipientDeviceId: string,
  lastServerSeq: number
): number {
  const now = new Date().toISOString();
  const existing = db
    .prepare(`
      SELECT last_server_seq FROM device_sync_cursors
      WHERE owner_canonical_id = ? AND recipient_device_id = ?
    `)
    .get(ownerCanonicalId, recipientDeviceId) as { last_server_seq: number } | undefined;

  // Cursors only move forward. A retry with a lower seq is a no-op.
  const next = existing === undefined ? lastServerSeq : Math.max(existing.last_server_seq, lastServerSeq);

  db.prepare(`
    INSERT INTO device_sync_cursors (
      owner_canonical_id,
      recipient_device_id,
      last_server_seq,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_canonical_id, recipient_device_id) DO UPDATE SET
      last_server_seq = excluded.last_server_seq,
      updated_at = excluded.updated_at
  `).run(ownerCanonicalId, recipientDeviceId, next, now);

  return next;
}

export function getRecipientCursor(
  ownerCanonicalId: string,
  recipientDeviceId: string
): number {
  const row = db
    .prepare(`
      SELECT last_server_seq FROM device_sync_cursors
      WHERE owner_canonical_id = ? AND recipient_device_id = ?
    `)
    .get(ownerCanonicalId, recipientDeviceId) as { last_server_seq: number } | undefined;
  return row?.last_server_seq ?? 0;
}

// For (owner, origin), find the highest origin_device_seq among
// events whose server_seq is <= the cap. Used by peer-progress to
// translate the peer's global recipient cursor into "how many of MY
// events the peer has applied", which is the only thing the calling
// device actually cares about. Returns 0 when the peer has applied
// nothing from this origin.
export function getMaxOriginSequenceAtCursor(
  ownerCanonicalId: string,
  originDeviceId: string,
  serverSeqCap: number
): number {
  if (!Number.isFinite(serverSeqCap) || serverSeqCap <= 0) return 0;
  const row = db
    .prepare(`
      SELECT MAX(origin_device_seq) AS max_seq
      FROM device_sync_log
      WHERE owner_canonical_id = ?
        AND origin_device_id = ?
        AND server_seq <= ?
    `)
    .get(ownerCanonicalId, originDeviceId, serverSeqCap) as { max_seq: number | null };
  return row.max_seq ?? 0;
}

// Aggregate stats for the operator stats endpoint. Returns only
// numeric/structural metadata — no event_id, owner_canonical_id, or
// encrypted_payload. Gating is the caller's responsibility (the
// route is dev-only today).
export type SyncStatsSummary = {
  device_sync_log: {
    total_rows: number;
    distinct_owners: number;
    oldest_row_age_ms: number | null;
    newest_row_age_ms: number | null;
  };
  rows_by_owner_top: Array<{ owner_canonical_id: string; count: number; latest_server_seq: number }>;
  memberships: { active: number; revoked: number };
  sync_lag: {
    max_behind: number;
    avg_behind: number;
    devices_observed: number;
  };
};

export function summarizeSyncStats(topOwners: number = 10): SyncStatsSummary {
  const logSummary = db
    .prepare(`
      SELECT
        COUNT(*)                    AS total_rows,
        COUNT(DISTINCT owner_canonical_id) AS distinct_owners,
        MIN(server_received_at)     AS oldest_at,
        MAX(server_received_at)     AS newest_at
      FROM device_sync_log
    `)
    .get() as {
      total_rows: number;
      distinct_owners: number;
      oldest_at: string | null;
      newest_at: string | null;
    };
  const now = Date.now();
  const oldestAge = logSummary.oldest_at !== null ? Math.max(0, now - Date.parse(logSummary.oldest_at)) : null;
  const newestAge = logSummary.newest_at !== null ? Math.max(0, now - Date.parse(logSummary.newest_at)) : null;

  const owners = db
    .prepare(`
      SELECT owner_canonical_id, COUNT(*) AS count, MAX(server_seq) AS latest_server_seq
      FROM device_sync_log
      GROUP BY owner_canonical_id
      ORDER BY count DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(100, Math.trunc(topOwners)))) as Array<{
      owner_canonical_id: string;
      count: number;
      latest_server_seq: number;
    }>;

  const memberships = db
    .prepare(`
      SELECT trust_state, COUNT(*) AS count
      FROM device_memberships
      GROUP BY trust_state
    `)
    .all() as Array<{ trust_state: string; count: number }>;
  let active = 0;
  let revoked = 0;
  for (const row of memberships) {
    if (row.trust_state === "active") active = row.count;
    else if (row.trust_state === "revoked") revoked = row.count;
  }

  // Sync lag: for each (owner, recipient_device) cursor row, the gap
  // between the latest server_seq for that owner and the cursor's
  // last_server_seq. A cursor of 0 against an owner with 200 events
  // means "200 events behind".
  const lagRows = db
    .prepare(`
      SELECT
        c.owner_canonical_id AS owner,
        c.last_server_seq    AS cursor,
        (SELECT MAX(server_seq) FROM device_sync_log WHERE owner_canonical_id = c.owner_canonical_id) AS latest
      FROM device_sync_cursors c
    `)
    .all() as Array<{ owner: string; cursor: number; latest: number | null }>;
  let maxBehind = 0;
  let totalBehind = 0;
  let observed = 0;
  for (const row of lagRows) {
    if (row.latest === null) continue;
    const behind = Math.max(0, row.latest - row.cursor);
    maxBehind = Math.max(maxBehind, behind);
    totalBehind += behind;
    observed++;
  }
  const avgBehind = observed > 0 ? totalBehind / observed : 0;

  return {
    device_sync_log: {
      total_rows: logSummary.total_rows,
      distinct_owners: logSummary.distinct_owners,
      oldest_row_age_ms: oldestAge,
      newest_row_age_ms: newestAge
    },
    rows_by_owner_top: owners,
    memberships: { active, revoked },
    sync_lag: {
      max_behind: maxBehind,
      avg_behind: avgBehind,
      devices_observed: observed
    }
  };
}

// Operator/dev diagnostic: counts of stored sync events grouped by
// (owner, slice, kind) plus the latest server_seq and the latest
// server_received_at. This deliberately exposes ONLY plaintext
// metadata fields — never event_id (UUIDs are sensitive linkability
// material to a third party who later learns who an owner is) and
// never the encrypted_payload. Callers should still gate the route
// to operator/dev-only contexts.
export type SyncCountsRow = {
  owner_canonical_id: string;
  slice: string;
  kind: string;
  count: number;
  latest_server_seq: number;
  latest_server_received_at: string;
};

export function listSyncCounts(): SyncCountsRow[] {
  const rows = db
    .prepare(`
      SELECT
        owner_canonical_id,
        slice,
        kind,
        COUNT(*) AS count,
        MAX(server_seq) AS latest_server_seq,
        MAX(server_received_at) AS latest_server_received_at
      FROM device_sync_log
      GROUP BY owner_canonical_id, slice, kind
      ORDER BY owner_canonical_id, slice, kind
    `)
    .all() as Array<{
      owner_canonical_id: string;
      slice: string;
      kind: string;
      count: number;
      latest_server_seq: number;
      latest_server_received_at: string;
    }>;
  return rows;
}

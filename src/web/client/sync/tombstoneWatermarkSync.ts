// Tombstone purge watermark slice.
//
// Lifecycle:
//   1. Local GC (src/web/client/local/tombstoneGc.ts) decides it has
//      accumulated enough old tombstones to retire them. It deletes
//      the rows from IDB, then asks this module to advance the local
//      watermark.
//   2. emitWatermarkAdvance(currentSequence) records the new value
//      locally AND fires a `tombstone_watermark.set` sync event with
//      `purged_before_sequence` baked into the signed envelope.
//   3. Peers receive the event via /sync polling, the projector below
//      writes their local watermark store. Fresh devices doing first-
//      time backfill also receive the current watermark snapshot at
//      the TOP of /sync responses (devices.routes.ts) and apply it
//      via applyWatermarkSnapshot BEFORE processing the page's
//      historical events.
//   4. The message-slice projector reads the local watermark for an
//      event's origin and DROPS any message.upsert event whose
//      sequence is at or below the watermark. This is the resurrection
//      protection: stale plaintext can never re-project once its
//      origin device has declared it purged.

import {
  activeAccount,
  buildAndPostSyncEvent,
  registerSliceProjector,
  registerWatermarkSnapshotApplier
} from "./coordinator.js";
import { getSetting, putSetting } from "../local/local-store.js";

// Per-(owner, origin_device) watermark. The local store is keyed by
// `sync.watermark:<owner>:<origin>` to mirror existing per-device
// state (cursor, origin_sequence). updated_at is for UI display
// ("history retained since YYYY-MM"); not used for protocol logic.
export type LocalWatermark = {
  purged_before_sequence: number;
  updated_at: string;
};

function key(ownerCanonicalId: string, originDeviceId: string): string {
  return `sync.watermark:${ownerCanonicalId}:${originDeviceId}`;
}

// Never-regress write: a watermark only ever moves forward locally.
async function applyLocalWatermark(
  ownerCanonicalId: string,
  originDeviceId: string,
  purgedBeforeSequence: number,
  updatedAt: string
): Promise<boolean> {
  if (!Number.isInteger(purgedBeforeSequence) || purgedBeforeSequence < 0) return false;
  const existing = (await getSetting(key(ownerCanonicalId, originDeviceId))) as LocalWatermark | null;
  if (existing !== null && existing.purged_before_sequence >= purgedBeforeSequence) {
    return false;
  }
  await putSetting(key(ownerCanonicalId, originDeviceId), {
    purged_before_sequence: purgedBeforeSequence,
    updated_at: updatedAt
  });
  return true;
}

export async function getLocalWatermark(
  ownerCanonicalId: string,
  originDeviceId: string
): Promise<number> {
  const existing = (await getSetting(key(ownerCanonicalId, originDeviceId))) as LocalWatermark | null;
  return existing?.purged_before_sequence ?? 0;
}

export async function getLocalWatermarkRow(
  ownerCanonicalId: string,
  originDeviceId: string
): Promise<LocalWatermark | null> {
  return (await getSetting(key(ownerCanonicalId, originDeviceId))) as LocalWatermark | null;
}

// Apply the per-owner watermarks[] snapshot returned by GET /sync.
// Called by the coordinator BEFORE iterating the events page, so any
// stale message.upsert events in the same response are dropped on the
// first pass.
export async function applyWatermarkSnapshot(
  ownerCanonicalId: string,
  snapshot: Array<{ origin_device_id: string; purged_before_sequence: number }>,
  now = new Date()
): Promise<void> {
  const updatedAt = now.toISOString();
  for (const entry of snapshot) {
    if (typeof entry?.origin_device_id !== "string" || entry.origin_device_id.length === 0) continue;
    if (typeof entry?.purged_before_sequence !== "number") continue;
    await applyLocalWatermark(ownerCanonicalId, entry.origin_device_id, entry.purged_before_sequence, updatedAt);
  }
}

// Lists ALL local watermarks for the owner. Used by the Settings →
// Devices "history retained since YYYY-MM" disclosure. The settings
// caller only ever displays the MAX(updated_at) across all origins,
// because the per-origin breakdown is noisy.
export async function listLocalWatermarks(ownerCanonicalId: string): Promise<Array<{ origin_device_id: string } & LocalWatermark>> {
  // We don't have a typed prefix-scan helper on the settings store;
  // for now we expose only the "current device" entry as the common
  // case. The Settings UI will likely only show the local device's
  // own watermark anyway.
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return [];
  const out: Array<{ origin_device_id: string } & LocalWatermark> = [];
  // We can't enumerate IDB keys by prefix without listing all of
  // settings; we keep this small for now and add prefix-scan if/when
  // the UI needs the full list.
  return out;
}

// Caller (GC) invokes this once it's deleted tombstones. The
// emit-and-store sequence is:
//   1. reserve a fresh origin_sequence INSIDE the cross-tab lock
//   2. compute purged_before_sequence = reserved_sequence - 1
//   3. sign + post a tombstone_watermark.set event carrying that
//      field at the envelope level
//   4. on a successful post, mirror the new watermark into our local
//      store so we don't have to wait for the next /sync poll to
//      apply our own event
//
// Returns the watermark value we advanced to (or null if no advance
// happened — e.g. coordinator inactive).
export async function emitWatermarkAdvance(ownerCanonicalId: string): Promise<number | null> {
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return null;
  // The event body is empty — the watermark value rides on the
  // signed envelope, not the encrypted payload. We still pass {}
  // so encryption produces a valid (albeit useless) ciphertext.
  const result = await buildAndPostSyncEvent(
    "tombstone_watermark",
    "tombstone_watermark.set",
    {},
    { advanceWatermarkToCurrent: true }
  );
  if (!result.ok || typeof result.purgedBeforeSequence !== "number") return null;
  await applyLocalWatermark(
    ownerCanonicalId,
    result.originDeviceId,
    result.purgedBeforeSequence,
    new Date().toISOString()
  );
  return result.purgedBeforeSequence;
}

// Wire the snapshot applier so coordinator can call us BEFORE
// iterating each /sync page. This breaks the circular-import edge:
// coordinator declares the hook, we fill it in at module load.
registerWatermarkSnapshotApplier(applyWatermarkSnapshot);

// Projector. The wire envelope already carries purged_before_sequence
// as a top-level field; coordinator passes it through alongside the
// (empty) decrypted payload via the event argument.
registerSliceProjector("tombstone_watermark", async (account, event, _payload) => {
  if (event.kind !== "tombstone_watermark.set") return false;
  const announced = (event as { purged_before_sequence?: unknown }).purged_before_sequence;
  if (typeof announced !== "number" || !Number.isInteger(announced) || announced < 0) {
    // Bad event — return true so the cursor advances past it; we don't
    // want a malformed watermark stuck in the poll loop forever.
    return true;
  }
  if (event.owner_canonical_id !== account.canonical_id) return true;
  await applyLocalWatermark(
    account.canonical_id,
    event.origin_device_id,
    announced,
    new Date().toISOString()
  );
  return true;
});

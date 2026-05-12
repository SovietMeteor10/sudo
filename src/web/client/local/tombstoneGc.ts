// Tombstone garbage collection.
//
// Goal: keep the messages object store from growing unboundedly with
// `deleted_at`-marked rows over the lifetime of an account, while
// guaranteeing that the deleted plaintext stays deleted everywhere
// (server, peers, future devices) even after the local tombstones
// are gone.
//
// Mechanism:
//   1. Scan local messages, count tombstones (deleted_at set).
//   2. Gate: don't run unless count ≥ TOMBSTONE_GC_COUNT_THRESHOLD
//      AND it's been ≥ TOMBSTONE_GC_COOLDOWN_MS since the last run.
//      The threshold keeps a small account from sweeping on every
//      startup; the cooldown keeps a noisy account from sweeping
//      every poll cycle.
//   3. Compute cutoff = now - TOMBSTONE_GC_MONTHS. Find tombstones
//      whose deleted_at is older than the cutoff.
//   4. Delete those rows from IDB.
//   5. If any rows were removed, emit a tombstone_watermark.set
//      sync event that advances OUR watermark to (current
//      origin_sequence). This is the protocol-level handshake: we
//      are declaring our past events permanently retired so peers
//      (and the server) refuse to apply or accept any replays from
//      below the watermark.
//   6. Record last_gc_at + tombstones_removed so the gate works
//      and observability can surface "history retained since
//      YYYY-MM" in the Settings dialog.

import { emitWatermarkAdvance } from "../sync/tombstoneWatermarkSync.js";
import {
  getSetting,
  listLocalMessages,
  putSetting
} from "./local-store.js";
import { openLocalDb, txDone } from "./local-db.js";

// Defaults are conservative — flip them via SUDO_TOMBSTONE_GC_*
// settings (not yet exposed to the user) for future tuning.
export const TOMBSTONE_GC_MONTHS = 12;
export const TOMBSTONE_GC_COUNT_THRESHOLD = 500;
export const TOMBSTONE_GC_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type GcMeta = {
  last_gc_at: string;
  last_tombstones_removed: number;
};

function gcMetaKey(ownerCanonicalId: string): string {
  return `tombstone.gc_meta:${ownerCanonicalId}`;
}

async function readGcMeta(ownerCanonicalId: string): Promise<GcMeta | null> {
  return (await getSetting(gcMetaKey(ownerCanonicalId))) as GcMeta | null;
}

async function writeGcMeta(ownerCanonicalId: string, meta: GcMeta): Promise<void> {
  await putSetting(gcMetaKey(ownerCanonicalId), meta);
}

export type TombstoneGcResult = {
  ran: boolean;
  reason?: "below_threshold" | "cooldown" | "no_eligible_rows" | "no_active_session";
  tombstone_count?: number;
  removed?: number;
  watermark_advanced_to?: number | null;
  cutoff_iso?: string;
};

// Best-effort entry point. Never throws. Should be called from
// setSignedIn (so a freshly-restored account sweeps once) and any
// long-lived maintenance hook the UI registers later.
export async function runTombstoneGc(ownerCanonicalId: string, now: Date = new Date()): Promise<TombstoneGcResult> {
  try {
    return await runTombstoneGcUnsafe(ownerCanonicalId, now);
  } catch (error) {
    console.warn("[tombstone-gc] failed", error instanceof Error ? error.message : error);
    return { ran: false };
  }
}

async function runTombstoneGcUnsafe(ownerCanonicalId: string, now: Date): Promise<TombstoneGcResult> {
  const messages = await listLocalMessages(ownerCanonicalId);
  const tombstones = messages.filter((m) => typeof m.deleted_at === "string");
  const count = tombstones.length;
  if (count < TOMBSTONE_GC_COUNT_THRESHOLD) {
    return { ran: false, reason: "below_threshold", tombstone_count: count };
  }

  const meta = await readGcMeta(ownerCanonicalId);
  if (meta !== null) {
    const last = Date.parse(meta.last_gc_at);
    if (Number.isFinite(last) && (now.valueOf() - last) < TOMBSTONE_GC_COOLDOWN_MS) {
      return { ran: false, reason: "cooldown", tombstone_count: count };
    }
  }

  const cutoff = new Date(now.valueOf() - TOMBSTONE_GC_MONTHS * 30 * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const eligible = tombstones.filter((m) => {
    const deletedAt = typeof m.deleted_at === "string" ? Date.parse(m.deleted_at) : Number.NaN;
    return Number.isFinite(deletedAt) && deletedAt < cutoff.valueOf();
  });
  if (eligible.length === 0) {
    // Even though there were many tombstones, none are old enough.
    // Mark last_gc_at so we don't re-scan on every startup; the
    // cooldown prevents that anyway, but recording the scan here is
    // a useful signal for observability.
    await writeGcMeta(ownerCanonicalId, {
      last_gc_at: now.toISOString(),
      last_tombstones_removed: 0
    });
    return { ran: true, reason: "no_eligible_rows", tombstone_count: count, removed: 0, cutoff_iso: cutoffIso };
  }

  // Delete the eligible rows in one transaction. IDB delete is
  // synchronous per call, so a 1000-row purge is well within a
  // single transaction's lifetime.
  const db = await openLocalDb();
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  for (const t of eligible) store.delete(t.message_id);
  await txDone(tx);

  // Advance our local watermark + announce it. This is the part
  // that makes the GC safe at the protocol level — without it,
  // a peer could backfill us with the upserts we just forgot
  // about and resurrect the plaintext locally.
  const watermark = await emitWatermarkAdvance(ownerCanonicalId);

  await writeGcMeta(ownerCanonicalId, {
    last_gc_at: now.toISOString(),
    last_tombstones_removed: eligible.length
  });

  return {
    ran: true,
    tombstone_count: count,
    removed: eligible.length,
    watermark_advanced_to: watermark,
    cutoff_iso: cutoffIso
  };
}

// Observability: read for the Settings → Devices "history retained
// since" disclosure. Returns null if no GC has ever run.
export async function readLastGcMeta(ownerCanonicalId: string): Promise<GcMeta | null> {
  return readGcMeta(ownerCanonicalId);
}

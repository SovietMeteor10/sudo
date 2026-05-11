// Per-device sync health summary. Reads existing sources only —
// trusted_devices for trust_state / last_seen_at, backfill_state for
// per-device replay progress, and the coordinator's settings keys for
// the recipient cursor + origin sequence (advanced view). Nothing
// here decrypts ciphertext or surfaces relay/internal terminology;
// the UI surfaces only the small set of human-readable status labels
// declared by DeviceSyncStatus.
//
// Why a dedicated module rather than baking this into the dialog
// renderer: the same summary is needed by the smoke harness and any
// future operator-facing surface (e.g. an "all linked devices health"
// CLI). Keeping it pure-functional + side-effect-free (other than IDB
// reads) lets us assert it in tests without spinning up the UI.

import { getBackfillState, getSetting } from "../local/local-store.js";
import type { TrustedDevice } from "../../../protocol/types.js";
import type { BackfillAttempt } from "../local/local-types.js";

// Mirrored from main.ts so this module stays decoupled from the
// device-pairing surface. If the values diverge, the user-visible
// retry copy will be wrong; the smokes assert both happy and
// retry-eligible labels.
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];
export const MAX_BACKFILL_ATTEMPTS = 5;

export type DeviceSyncStatus =
  | "current"
  | "synced"
  | "syncing"
  | "retry_pending"
  | "failed"
  | "revoked"
  | "unknown";

export type DeviceSyncHealth = {
  status: DeviceSyncStatus;
  // Short, calm, user-facing line. No technical terms, no relay/IDB
  // wording. Examples: "synced", "syncing…", "sync will retry in 2m",
  // "sync failed — will retry", "revoked", "this device".
  label: string;
  // "last seen 4m ago" or "" if the device has no meaningful
  // timestamp. Rendered as a separate muted line so locale-relative
  // text doesn't clutter the main status.
  lastSeenLine: string;
  // Epoch ms when the next automatic retry fires. null when no retry
  // is scheduled (synced / revoked / running / unknown).
  retryEligibleAt: number | null;
  // Whether the "retry sync" button should be shown for this row.
  canRetry: boolean;
  advanced: {
    deviceIdShort: string;
    attempts?: number;
    lastAttemptAt?: string;
    lastError?: string;
    totalEvents?: number;
    sliceProgress?: { [slice: string]: number };
    // The local "how far this device has applied inbound events" and
    // "how many events this device has emitted". Useful when a user
    // is asking "is my desktop ahead of my phone?". Both come from
    // the coordinator's settings keys; absent if the coordinator has
    // never run for this device pair.
    recipientCursor?: number;
    originSequence?: number;
    // Ring buffer of recent backfill attempts (newest first when
    // rendered). Comes straight from backfill_state.attempt_history.
    attemptHistory?: BackfillAttempt[];
    // Inbound peer-progress (caller's perspective). Populated when
    // the dialog's poll has fetched /sync/peer-progress for this
    // peer. null when the endpoint hasn't been hit yet, the peer is
    // revoked (we skip the call), or the network errored. The
    // numbers are pure metadata: max sequences and a freshness
    // timestamp. No plaintext.
    ourLastOriginSequence?: number;
    peerRecipientCursor?: number;
    inboundBehindBy?: number;
    peerProgressFreshAt?: number;
  };
};

export type PeerProgressInput = {
  peer_recipient_cursor: number;
  our_last_origin_sequence: number;
  inbound_behind_by: number;
  fresh_as_of_ms: number;
};

// When inbound_behind_by exceeds this threshold, the user-facing
// status label gains a non-alarming qualifier ("synced — peer is N
// events behind"). Below it the row keeps the plain "synced" copy:
// small drift is normal (the peer polls every ~5s and we may have
// just emitted) and we don't want to nag.
export const INBOUND_BEHIND_USER_THRESHOLD = 10;

export async function computeDeviceSyncHealth(
  ownerCanonicalId: string,
  currentDeviceId: string | null,
  device: TrustedDevice,
  now: number = Date.now(),
  peerProgress: PeerProgressInput | null = null
): Promise<DeviceSyncHealth> {
  const advanced: DeviceSyncHealth["advanced"] = {
    deviceIdShort: device.device_id.slice(0, 8)
  };

  if (peerProgress !== null) {
    advanced.ourLastOriginSequence = peerProgress.our_last_origin_sequence;
    advanced.peerRecipientCursor = peerProgress.peer_recipient_cursor;
    advanced.inboundBehindBy = peerProgress.inbound_behind_by;
    advanced.peerProgressFreshAt = peerProgress.fresh_as_of_ms;
  }

  // Recipient cursor + origin sequence are best-effort. A revoked or
  // never-active device may not have them yet.
  try {
    const cursor = await getSetting(`sync.recipient_cursor:${ownerCanonicalId}:${device.device_id}`);
    if (typeof cursor === "number") advanced.recipientCursor = cursor;
  } catch { /* ignore */ }
  try {
    const seq = await getSetting(`sync.origin_sequence:${ownerCanonicalId}:${device.device_id}`);
    if (typeof seq === "number") advanced.originSequence = seq;
  } catch { /* ignore */ }

  const lastSeenLine = humanizeLastSeen(device.last_seen_at, now);

  if (device.device_id === currentDeviceId) {
    return {
      status: "current",
      label: "this device",
      lastSeenLine: "",
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  if (device.trust_state === "revoked") {
    return {
      status: "revoked",
      label: "revoked",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  // Backfill state is keyed by (owner, target_device_id). A row only
  // exists if we (this device) have ever attempted to push state to
  // the target. Absent row = this device has never been the source
  // of a backfill toward `device` (typical for a peer who pre-existed
  // the backfill_state feature). Treat that case as "synced" without
  // scary copy: there is no known reason to flag it.
  let state;
  try {
    state = await getBackfillState(ownerCanonicalId, device.device_id);
  } catch {
    state = null;
  }

  if (state !== null) {
    advanced.attempts = state.attempts;
    advanced.lastAttemptAt = state.last_attempt_at;
    if (typeof state.last_error === "string") advanced.lastError = state.last_error;
    if (typeof state.total_events === "number") advanced.totalEvents = state.total_events;
    if (state.slice_progress !== undefined) advanced.sliceProgress = state.slice_progress;
    if (Array.isArray(state.attempt_history) && state.attempt_history.length > 0) {
      advanced.attemptHistory = state.attempt_history;
    }
  }

  if (state === null) {
    return {
      status: "synced",
      label: syncedLabelWithInboundQualifier(peerProgress),
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  if (state.status === "running") {
    // First-ever attempt → "syncing…" (fresh device coming online).
    // Subsequent attempts → "retrying sync…" (the user clicked retry
    // or the auto-retry fired). Distinguishing these gives the user
    // accurate feedback about whether this is the initial backfill
    // or a recovery attempt.
    const isRetry = (state.attempts ?? 1) > 1;
    return {
      status: "syncing",
      label: isRetry ? "retrying sync…" : "syncing…",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  if (state.status === "complete") {
    return {
      status: "synced",
      label: syncedLabelWithInboundQualifier(peerProgress),
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  // pending or failed — attempts may be exhausted. We deliberately
  // keep the user-facing copy short and non-alarming. The exact
  // remaining-time and raw error live in the "advanced" disclosure
  // (lastError + attempt history). Two cases:
  //
  //   1. Attempts exhausted (>= MAX_BACKFILL_ATTEMPTS):
  //      "sync paused — retry available". The auto-loop has given up;
  //      the user has to click retry. Status is `failed`.
  //   2. Within the backoff window (auto-retry will fire later):
  //      "sync will retry soon". Status is `retry_pending`.
  if (state.attempts >= MAX_BACKFILL_ATTEMPTS) {
    return {
      status: "failed",
      label: "sync paused — retry available",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: true,
      advanced
    };
  }
  const backoffIdx = Math.max(0, Math.min(state.attempts - 1, RETRY_BACKOFF_MS.length - 1));
  const backoff = RETRY_BACKOFF_MS[backoffIdx] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  const lastAttemptMs = Date.parse(state.last_attempt_at);
  const eligible = Number.isFinite(lastAttemptMs) ? lastAttemptMs + backoff : now;
  return {
    status: "retry_pending",
    label: "sync will retry soon",
    lastSeenLine,
    retryEligibleAt: eligible,
    canRetry: true,
    advanced
  };
}

function syncedLabelWithInboundQualifier(progress: PeerProgressInput | null): string {
  if (progress === null) return "synced";
  if (progress.inbound_behind_by <= INBOUND_BEHIND_USER_THRESHOLD) return "synced";
  // Calm, non-alarming qualifier. Pluralization is the common case
  // ("12 events behind"); we don't bother with the singular edge
  // because the threshold is 10.
  return `synced — peer is ${progress.inbound_behind_by} events behind`;
}

function humanizeLastSeen(lastSeenAt: string, now: number): string {
  if (typeof lastSeenAt !== "string" || lastSeenAt.length === 0) return "";
  const t = Date.parse(lastSeenAt);
  if (!Number.isFinite(t)) return "";
  const delta = now - t;
  if (delta < 0) return ""; // future timestamp; don't surface
  return `last seen ${humanizeDuration(delta)} ago`;
}

function humanizeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

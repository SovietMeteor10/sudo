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
  };
};

export async function computeDeviceSyncHealth(
  ownerCanonicalId: string,
  currentDeviceId: string | null,
  device: TrustedDevice,
  now: number = Date.now()
): Promise<DeviceSyncHealth> {
  const advanced: DeviceSyncHealth["advanced"] = {
    deviceIdShort: device.device_id.slice(0, 8)
  };

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
  }

  if (state === null) {
    return {
      status: "synced",
      label: "synced",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  if (state.status === "running") {
    return {
      status: "syncing",
      label: "syncing…",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  if (state.status === "complete") {
    return {
      status: "synced",
      label: "synced",
      lastSeenLine,
      retryEligibleAt: null,
      canRetry: false,
      advanced
    };
  }

  // pending or failed — attempts may be exhausted.
  if (state.attempts >= MAX_BACKFILL_ATTEMPTS) {
    return {
      status: "failed",
      label: "sync failed",
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
  const remaining = eligible - now;
  if (remaining > 0) {
    return {
      status: "retry_pending",
      label: `sync will retry in ${humanizeDuration(remaining)}`,
      lastSeenLine,
      retryEligibleAt: eligible,
      canRetry: true,
      advanced
    };
  }
  return {
    status: "retry_pending",
    label: "sync failed — will retry",
    lastSeenLine,
    retryEligibleAt: eligible,
    canRetry: true,
    advanced
  };
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

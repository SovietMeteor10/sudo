import { randomUUID } from "node:crypto";
import { Router } from "express";
import { verifyDeviceMembership, verifySyncEvent } from "../crypto/signatures.js";
import { getIdentityByCanonicalId } from "../identity/registry.js";
import type {
  DeviceSyncEvent,
  SignedDeviceMembership,
  SignedSyncEvent,
  TrustedDevice
} from "../protocol/types.js";
import {
  cancelPairingToken,
  consumePairingCode,
  createPairingToken,
  getLatestDeviceMembership,
  getPairingHandoffBundle,
  insertDeviceSyncEvent,
  listDeviceMemberships,
  listTrustedDevices,
  revokeTrustedDevice,
  setPairingHandoffBundle,
  upsertDeviceMembership,
  upsertTrustedDevice
} from "./devices.store.js";
import { checkPairHandoffRate } from "./pair-handoff-rate-limit.js";
import { checkSyncRate } from "./sync-rate-limit.js";
import { checkOwnerReadRate } from "./owner-read-rate-limit.js";
import { emitRateLimited } from "./rate-limit-response.js";
import {
  getRecipientCursor,
  getMaxOriginSequence,
  getMaxOriginSequenceAtCursor,
  insertSyncEvent,
  listSyncEventsSince,
  setRecipientCursor
} from "./syncStore.js";
import {
  getTombstoneWatermark,
  listTombstoneWatermarksForOwner,
  noteStaleUpsertRejected,
  upsertTombstoneWatermark
} from "./tombstone-watermark.store.js";

export const devicesRouter = Router();

// Verify a SignedDeviceMembership submitted by a client. Looks up the
// owner's identity public key from the registry and uses it to verify
// the signature. Returns a structured result so the route can decide
// what HTTP status to surface.
type MembershipAcceptance =
  | { ok: true; membership: SignedDeviceMembership }
  | { ok: false; error: "owner_unknown" | "invalid_membership_signature" | "owner_mismatch" | "device_mismatch" | "sequence_regression" };

function acceptSignedMembership(
  candidate: unknown,
  expected: { ownerCanonicalId: string; deviceId: string; trustState: SignedDeviceMembership["trust_state"] }
): MembershipAcceptance {
  if (typeof candidate !== "object" || candidate === null) {
    return { ok: false, error: "invalid_membership_signature" };
  }
  const membership = candidate as SignedDeviceMembership;
  if (membership.owner_canonical_id !== expected.ownerCanonicalId) return { ok: false, error: "owner_mismatch" };
  if (membership.device_id !== expected.deviceId) return { ok: false, error: "device_mismatch" };
  if (membership.trust_state !== expected.trustState) return { ok: false, error: "device_mismatch" };

  const owner = getIdentityByCanonicalId(expected.ownerCanonicalId);
  if (owner === null) return { ok: false, error: "owner_unknown" };
  const ownerKey = owner.document.keys?.identity;
  if (!ownerKey) return { ok: false, error: "owner_unknown" };

  if (!verifyDeviceMembership(membership, ownerKey.public_key, ownerKey.type ?? "ed25519")) {
    return { ok: false, error: "invalid_membership_signature" };
  }

  const latest = getLatestDeviceMembership(expected.deviceId);
  if (latest !== null && membership.sequence < latest.sequence) {
    return { ok: false, error: "sequence_regression" };
  }

  return { ok: true, membership };
}

devicesRouter.get("/:ownerCanonicalId", (request, response) => {
  if (rejectIfOwnerReadRateLimited(request, response, request.params.ownerCanonicalId)) return;
  // `devices` remains the trusted_devices cache (for current UI).
  // `memberships` exposes the canonical signed docs alongside it; old
  // clients that don't read this field are unaffected.
  response.json({
    devices: listTrustedDevices(request.params.ownerCanonicalId),
    memberships: listDeviceMemberships(request.params.ownerCanonicalId)
  });
});

devicesRouter.post("/register", (request, response) => {
  const body = request.body as {
    owner_canonical_id?: unknown;
    device_id?: unknown;
    name?: unknown;
    device_public_key?: unknown;
    trust_state?: unknown;
    capabilities?: unknown;
    signed_membership?: unknown;
  };

  if (
    typeof body.owner_canonical_id !== "string"
    || typeof body.device_id !== "string"
    || typeof body.name !== "string"
    || typeof body.device_public_key !== "string"
  ) {
    response.status(400).json({ ok: false, error: "invalid_device" });
    return;
  }

  const trustState: "active" | "revoked" = body.trust_state === "revoked" ? "revoked" : "active";

  let acceptedMembership: SignedDeviceMembership | null = null;
  if (body.signed_membership !== undefined) {
    const result = acceptSignedMembership(body.signed_membership, {
      ownerCanonicalId: body.owner_canonical_id,
      deviceId: body.device_id,
      trustState
    });
    if (!result.ok) {
      response.status(400).json({ ok: false, error: result.error });
      return;
    }
    acceptedMembership = result.membership;
  }

  const device: TrustedDevice = {
    type: "sudo_trusted_device",
    device_id: body.device_id,
    owner_canonical_id: body.owner_canonical_id,
    name: body.name,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    trust_state: trustState,
    device_public_key: body.device_public_key,
    capabilities: normalizeCapabilities(body.capabilities)
  };

  upsertTrustedDevice(device);

  if (acceptedMembership !== null) {
    upsertDeviceMembership(acceptedMembership);
  }

  response.status(201).json({ ok: true, device, membership: acceptedMembership });
});

devicesRouter.post("/pair/start", (request, response) => {
  if (rejectIfPairRateLimited(request, response, null)) return;
  const body = request.body as { owner_canonical_id?: unknown; device_name?: unknown };
  if (typeof body.owner_canonical_id !== "string" || body.owner_canonical_id.trim().length === 0) {
    response.status(400).json({ ok: false, error: "invalid_owner" });
    return;
  }

  const token = createPairingToken(body.owner_canonical_id);
  response.status(201).json({ ok: true, ...token });
});

// Resolve the remote IP we'll feed into the pair-handoff rate
// limiter. Mirrors the pattern in identity-auth.handlers.ts —
// trust X-Real-IP from nginx, fall back to request.ip / connection
// peer for safety.
function resolveRemoteIpForPair(request: import("express").Request): string {
  const realIp = request.get("x-real-ip");
  if (typeof realIp === "string" && realIp.length > 0) return realIp;
  return request.ip ?? "";
}

function rejectIfPairRateLimited(
  request: import("express").Request,
  response: import("express").Response,
  pairingCode: string | null
): boolean {
  const result = checkPairHandoffRate(resolveRemoteIpForPair(request), pairingCode);
  if (result.ok) return false;
  emitRateLimited(response, result, {
    message: `too many pair requests; retry in ${result.retry_after_seconds}s`
  });
  return true;
}

function rejectIfOwnerReadRateLimited(
  request: import("express").Request,
  response: import("express").Response,
  ownerCanonicalId: string
): boolean {
  const result = checkOwnerReadRate(resolveRemoteIpForPair(request), ownerCanonicalId);
  if (result.ok) return false;
  emitRateLimited(response, result);
  return true;
}

// POST /api/devices/pair/handoff
// Body: { pairing_code, encrypted_account_bundle }
//
// Existing device pushes its encrypted crypto_account bundle into
// the pairing channel. The bundle is opaque to the server: the
// existing device wraps the already-passphrase-encrypted bundle
// once more with PBKDF2(pairing_code) before posting. The server's
// only role is relay + rate-limit + TTL.
devicesRouter.post("/pair/handoff", (request, response) => {
  const body = request.body as { pairing_code?: unknown; encrypted_account_bundle?: unknown };
  if (typeof body.pairing_code !== "string" || typeof body.encrypted_account_bundle !== "string") {
    if (rejectIfPairRateLimited(request, response, null)) return;
    response.status(400).json({ ok: false, error: "invalid_handoff_payload" });
    return;
  }
  if (rejectIfPairRateLimited(request, response, body.pairing_code)) return;
  if (body.encrypted_account_bundle.length > 65536) {
    // Belt-and-braces cap. The express body limit is 64kb; this
    // mirrors it so a borderline body doesn't slip through and
    // bloat the row indefinitely.
    response.status(413).json({ ok: false, error: "bundle_too_large" });
    return;
  }
  const result = setPairingHandoffBundle(body.pairing_code, body.encrypted_account_bundle);
  if (!result.ok) {
    if (result.reason === "not_found") response.status(404).json({ ok: false, error: "pairing_code_not_found" });
    else if (result.reason === "consumed") response.status(410).json({ ok: false, error: "pairing_code_consumed" });
    else response.status(410).json({ ok: false, error: "pairing_code_expired" });
    return;
  }
  response.status(201).json({ ok: true });
});

// GET /api/devices/pair/handoff/:pairing_code
//
// New device fetches the encrypted bundle. Does NOT consume the
// pairing code — pair/complete is what consumes. The 404-on-anything
// behavior is intentional: an attacker brute-forcing this endpoint
// can't tell "wrong code" from "code right but bundle not deposited
// yet" from "code right but already consumed".
devicesRouter.get("/pair/handoff/:pairing_code", (request, response) => {
  const code = request.params.pairing_code;
  if (typeof code !== "string" || code.length === 0) {
    if (rejectIfPairRateLimited(request, response, null)) return;
    response.status(400).json({ ok: false, error: "invalid_pairing_code" });
    return;
  }
  if (rejectIfPairRateLimited(request, response, code)) return;
  const handoff = getPairingHandoffBundle(code);
  if (handoff === null) {
    response.status(404).json({ ok: false, error: "pairing_handoff_not_found" });
    return;
  }
  // Echo back the owner's canonical id and (if known to the registry)
  // the handle, so the new device can show "linking @alice's account"
  // before the user types the passphrase. Both are derivable from a
  // valid pairing code anyway; no additional info leakage.
  const identity = getIdentityByCanonicalId(handoff.owner_canonical_id);
  response.json({
    ok: true,
    encrypted_account_bundle: handoff.encrypted_account_bundle,
    owner_canonical_id: handoff.owner_canonical_id,
    owner_handle: identity?.document.handle ?? null
  });
});

// POST /api/devices/pair/cancel
// Body: { pairing_token }
//
// Existing device cancels a pending pair before the new device picks
// it up. Authenticated by the long pairing_token (only the existing
// device knows it; pairing_code alone won't cancel). Idempotent — a
// missing or already-consumed row returns ok: true so the UI can
// fire-and-forget on dialog close.
devicesRouter.post("/pair/cancel", (request, response) => {
  const body = request.body as { pairing_token?: unknown };
  if (typeof body.pairing_token !== "string" || body.pairing_token.length === 0) {
    response.status(400).json({ ok: false, error: "invalid_pairing_token" });
    return;
  }
  cancelPairingToken(body.pairing_token);
  response.json({ ok: true });
});

devicesRouter.post("/pair/complete", (request, response) => {
  // Pair-complete consumes a passcode; gate it on the same limiter
  // as pair/handoff so an attacker can't brute the 12-char code
  // window. We rate-limit before reading the body to keep cost low.
  if (rejectIfPairRateLimited(request, response, null)) return;
  const body = request.body as {
    pairing_code?: unknown;
    device_id?: unknown;
    owner_canonical_id?: unknown;
    name?: unknown;
    device_public_key?: unknown;
    encrypted_bootstrap_payload?: unknown;
    signed_membership?: unknown;
  };

  if (
    typeof body.pairing_code !== "string"
    || typeof body.device_id !== "string"
    || typeof body.name !== "string"
    || typeof body.device_public_key !== "string"
    || typeof body.encrypted_bootstrap_payload !== "string"
  ) {
    response.status(400).json({ ok: false, error: "invalid_pairing_payload" });
    return;
  }

  const token = consumePairingCode(body.pairing_code);
  if (token === null) {
    response.status(404).json({ ok: false, error: "pairing_code_not_found" });
    return;
  }

  let acceptedMembership: SignedDeviceMembership | null = null;
  if (body.signed_membership !== undefined) {
    const result = acceptSignedMembership(body.signed_membership, {
      ownerCanonicalId: token.owner_canonical_id,
      deviceId: body.device_id,
      trustState: "active"
    });
    if (!result.ok) {
      response.status(400).json({ ok: false, error: result.error });
      return;
    }
    acceptedMembership = result.membership;
  }

  const device: TrustedDevice = {
    type: "sudo_trusted_device",
    device_id: body.device_id,
    owner_canonical_id: token.owner_canonical_id,
    name: body.name,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    trust_state: "active",
    device_public_key: body.device_public_key,
    capabilities: {
      can_sync: true,
      can_decrypt: true
    }
  };
  upsertTrustedDevice(device);

  if (acceptedMembership !== null) {
    upsertDeviceMembership(acceptedMembership);
  }

  const syncEvent: DeviceSyncEvent = {
    type: "sudo_device_sync_event",
    event_id: randomUUID(),
    owner_canonical_id: token.owner_canonical_id,
    device_id: body.device_id,
    event_type: "pairing.complete",
    created_at: new Date().toISOString(),
    encrypted_payload: body.encrypted_bootstrap_payload
  };
  insertDeviceSyncEvent(syncEvent);

  response.status(201).json({
    ok: true,
    device,
    pairing_code: body.pairing_code,
    membership: acceptedMembership
  });
});

devicesRouter.post("/:deviceId/revoke", (request, response) => {
  const body = request.body as { owner_canonical_id?: unknown; signed_membership?: unknown };
  if (typeof body.owner_canonical_id !== "string") {
    response.status(400).json({ ok: false, error: "invalid_owner" });
    return;
  }

  let acceptedMembership: SignedDeviceMembership | null = null;
  if (body.signed_membership !== undefined) {
    const result = acceptSignedMembership(body.signed_membership, {
      ownerCanonicalId: body.owner_canonical_id,
      deviceId: request.params.deviceId,
      trustState: "revoked"
    });
    if (!result.ok) {
      response.status(400).json({ ok: false, error: result.error });
      return;
    }
    acceptedMembership = result.membership;
  }

  const device = revokeTrustedDevice(body.owner_canonical_id, request.params.deviceId);
  if (device === null) {
    response.status(404).json({ ok: false, error: "device_not_found" });
    return;
  }

  if (acceptedMembership !== null) {
    upsertDeviceMembership(acceptedMembership);
  }

  response.json({ ok: true, device, membership: acceptedMembership });
});

// Resolves a device's active SignedDeviceMembership for an owner.
// Returns null if no membership exists or the latest is not "active".
// Used both as the source of truth for sync-event signature
// verification (origin device) and as the gate for sync delivery
// (recipient device).
function resolveActiveMembership(
  ownerCanonicalId: string,
  deviceId: string
): SignedDeviceMembership | null {
  const latest = getLatestDeviceMembership(deviceId);
  if (latest === null) return null;
  if (latest.owner_canonical_id !== ownerCanonicalId) return null;
  if (latest.trust_state !== "active") return null;
  return latest;
}

// POST /api/devices/:ownerCanonicalId/sync
// Body: { signed_event: SignedSyncEvent }
// Verifies that:
//   - event.owner_canonical_id matches the route owner
//   - origin_device has a non-revoked SignedDeviceMembership
//   - signature verifies against the origin device key
//   - sequence is strictly increasing per (owner, origin_device)
// Idempotent on event_id: a retry returns 200 with `created: false`.
devicesRouter.post("/:ownerCanonicalId/sync", (request, response) => {
  const ownerCanonicalId = request.params.ownerCanonicalId;
  // Per-IP + per-owner rate limit. Backfills are deliberately bursty
  // (one event per contact/subscription/message/draft/profile) so the
  // cap is generous; 600/min per IP gives a 1000-message account
  // headroom to backfill at ~10 events/sec without tripping. Owner
  // bucket prevents a single compromised account from flooding the
  // relay across IPs.
  const rateResult = checkSyncRate(resolveRemoteIpForPair(request), ownerCanonicalId);
  if (!rateResult.ok) {
    emitRateLimited(response, rateResult);
    return;
  }
  const body = request.body as { signed_event?: unknown };
  if (typeof body.signed_event !== "object" || body.signed_event === null) {
    response.status(400).json({ ok: false, error: "invalid_sync_event" });
    return;
  }
  const event = body.signed_event as SignedSyncEvent;
  if (
    event.type !== "sudo_sync_event"
    || typeof event.event_id !== "string"
    || typeof event.origin_device_id !== "string"
    || typeof event.signature !== "string"
    || typeof event.encrypted_payload !== "string"
    || typeof event.sequence !== "number"
    || !isKnownSliceKind(event.slice, event.kind)
  ) {
    response.status(400).json({ ok: false, error: "invalid_sync_event" });
    return;
  }
  if (event.owner_canonical_id !== ownerCanonicalId) {
    response.status(400).json({ ok: false, error: "owner_mismatch" });
    return;
  }

  const originMembership = resolveActiveMembership(ownerCanonicalId, event.origin_device_id);
  if (originMembership === null) {
    response.status(403).json({ ok: false, error: "origin_not_authorized" });
    return;
  }

  if (!verifySyncEvent(event, originMembership.device_public_key, originMembership.device_key_type ?? "ed25519")) {
    response.status(400).json({ ok: false, error: "invalid_sync_signature" });
    return;
  }

  // Watermark gating: a message.upsert from origin D at sequence S
  // must satisfy S > watermark[owner, D]. The originating device
  // declared its own watermark; the relay refuses to accept its old
  // replays so stale plaintext cannot resurrect after tombstone GC.
  if (event.slice === "message" && event.kind === "message.upsert") {
    const watermark = getTombstoneWatermark(ownerCanonicalId, event.origin_device_id);
    if (watermark !== null && event.sequence <= watermark.purged_before_sequence) {
      noteStaleUpsertRejected();
      response.status(409).json({
        ok: false,
        error: "stale_below_watermark",
        purged_before_sequence: watermark.purged_before_sequence
      });
      return;
    }
  }

  // Watermark declarations: only the originating device can advance
  // its own watermark. Validate the field, then persist.
  if (event.slice === "tombstone_watermark" && event.kind === "tombstone_watermark.set") {
    const announced = event.purged_before_sequence;
    if (typeof announced !== "number" || !Number.isInteger(announced) || announced < 0) {
      response.status(400).json({ ok: false, error: "invalid_watermark" });
      return;
    }
    // The announced watermark must be strictly less than the event's
    // own sequence — you can't retroactively purge yourself.
    if (announced >= event.sequence) {
      response.status(400).json({ ok: false, error: "watermark_not_below_event_sequence" });
      return;
    }
  }

  const result = insertSyncEvent(event);
  if (!result.ok) {
    response.status(409).json({ ok: false, error: result.error });
    return;
  }

  // Post-insert bookkeeping. The watermark store has a "never regress"
  // guard so an out-of-order older watermark event cannot undo a newer
  // one. The (event.origin_device_id, announced) pair has already
  // been validated.
  if (event.slice === "tombstone_watermark" && event.kind === "tombstone_watermark.set") {
    upsertTombstoneWatermark(
      ownerCanonicalId,
      event.origin_device_id,
      event.purged_before_sequence as number
    );
  }

  response.status(result.created ? 201 : 200).json({
    ok: true,
    created: result.created,
    server_seq: result.server_seq,
    event_id: event.event_id
  });
});

// GET /api/devices/:ownerCanonicalId/sync?device_id=<recipient>&since=<cursor>&limit=N
// The recipient device must have a non-revoked SignedDeviceMembership;
// revocation enforcement happens here, so a revoked device gets 403
// regardless of any cursor it remembers. This is best-effort gating —
// the encrypted_payload remains the durable secrecy boundary.
devicesRouter.get("/:ownerCanonicalId/sync", (request, response) => {
  const ownerCanonicalId = request.params.ownerCanonicalId;
  const recipientDeviceId = typeof request.query.device_id === "string" ? request.query.device_id : null;
  if (recipientDeviceId === null || recipientDeviceId.length === 0) {
    response.status(400).json({ ok: false, error: "missing_device_id" });
    return;
  }

  if (resolveActiveMembership(ownerCanonicalId, recipientDeviceId) === null) {
    response.status(403).json({ ok: false, error: "recipient_not_authorized" });
    return;
  }

  const since = Number(request.query.since ?? 0);
  const sinceCursor = Number.isFinite(since) && since >= 0 ? since : 0;
  const limitRaw = Number(request.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;

  const events = listSyncEventsSince(ownerCanonicalId, sinceCursor, limit);
  const nextCursor = events.length > 0 ? events[events.length - 1]!.server_seq : sinceCursor;
  // Tombstone purge watermark snapshot. A fresh device pulling its
  // first /sync page receives the current per-origin-device
  // watermarks BEFORE the historical events, so it can drop any
  // stale message.upsert events it sees during backfill instead of
  // re-projecting them and then having to re-tombstone. Mature
  // clients re-fetch every page anyway, so the snapshot is small +
  // cheap to include on every response.
  const watermarks = listTombstoneWatermarksForOwner(ownerCanonicalId).map((row) => ({
    origin_device_id: row.origin_device_id,
    purged_before_sequence: row.purged_before_sequence
  }));
  response.json({ events, next_cursor: nextCursor, watermarks });
});

// POST /api/devices/:ownerCanonicalId/sync/ack
// Body: { recipient_device_id, last_server_seq }
// Records that the recipient device has durably stored events up to
// last_server_seq. The cursor is monotonic: a stale ack does not
// regress the recorded value.
devicesRouter.post("/:ownerCanonicalId/sync/ack", (request, response) => {
  const ownerCanonicalId = request.params.ownerCanonicalId;
  const body = request.body as { recipient_device_id?: unknown; last_server_seq?: unknown };
  if (typeof body.recipient_device_id !== "string" || typeof body.last_server_seq !== "number") {
    response.status(400).json({ ok: false, error: "invalid_ack" });
    return;
  }
  if (resolveActiveMembership(ownerCanonicalId, body.recipient_device_id) === null) {
    response.status(403).json({ ok: false, error: "recipient_not_authorized" });
    return;
  }
  const stored = setRecipientCursor(ownerCanonicalId, body.recipient_device_id, body.last_server_seq);
  response.json({ ok: true, last_server_seq: stored });
});

// GET /api/devices/:ownerCanonicalId/sync/peer-progress
//   ?device_id=<peerDeviceId>&caller_device_id=<selfDeviceId>
//
// Lets the calling device ask "how many of MY emitted events has
// <peer> acked?". Returns:
//
//   {
//     peer_recipient_cursor:      max origin_device_seq of MY events
//                                  the peer has applied (origin = caller)
//     our_last_origin_sequence:   max origin_device_seq I've emitted
//     inbound_behind_by:          our_last - peer_recipient_cursor
//     fresh_as_of_ms:             server clock at the moment of read
//   }
//
// Auth is the same shape as /sync GET and /sync/ack: the caller
// supplies caller_device_id and must hold an active membership for
// :ownerCanonicalId. We deliberately use two separate query params
// (rather than overloading `device_id`) so the calling and target
// devices are distinguishable in logs.
//
// Cross-owner access leaks NO existence: any failure (caller not a
// member, peer not in the owner's device list, owner unknown)
// returns 404. Revoked CALLER → 403 (same as /sync GET). Revoked
// PEER → 200 with the numbers, because the UI already knows the
// peer is revoked and the cursor math is harmless metadata at that
// point.
//
// Brief in-memory cache (3s per tuple) means the dialog's 5s
// refresh doesn't hammer SQL. Cache lives in the route module; a
// single droplet is the deploy unit, so process-local caching is
// fine.
const PEER_PROGRESS_CACHE_TTL_MS = 3000;
type PeerProgressBody = {
  peer_recipient_cursor: number;
  our_last_origin_sequence: number;
  inbound_behind_by: number;
  fresh_as_of_ms: number;
};
const peerProgressCache = new Map<string, { expires_at: number; body: PeerProgressBody }>();
function peerProgressCacheKey(owner: string, caller: string, peer: string): string {
  return `${owner}|${caller}|${peer}`;
}
devicesRouter.get("/:ownerCanonicalId/sync/peer-progress", (request, response) => {
  const ownerCanonicalId = request.params.ownerCanonicalId;
  if (rejectIfOwnerReadRateLimited(request, response, ownerCanonicalId)) return;
  const peerDeviceId = typeof request.query.device_id === "string" ? request.query.device_id : null;
  const callerDeviceId = typeof request.query.caller_device_id === "string" ? request.query.caller_device_id : null;
  if (peerDeviceId === null || peerDeviceId.length === 0 || callerDeviceId === null || callerDeviceId.length === 0) {
    response.status(400).json({ ok: false, error: "missing_device_id" });
    return;
  }
  // Owner existence + caller membership in one combined 404/403
  // shape: any failure to authorize the caller as a member of this
  // owner returns 404 to avoid leaking the owner's existence to
  // strangers. The one exception is a revoked caller-of-the-right-
  // owner, which gets 403 (matching /sync GET's contract).
  const ownerExists = getIdentityByCanonicalId(ownerCanonicalId) !== null;
  if (!ownerExists) {
    response.status(404).json({ ok: false, error: "owner_unknown" });
    return;
  }
  const callerMembership = getLatestDeviceMembership(callerDeviceId);
  if (callerMembership === null || callerMembership.owner_canonical_id !== ownerCanonicalId) {
    response.status(404).json({ ok: false, error: "caller_not_in_owner" });
    return;
  }
  if (callerMembership.trust_state !== "active") {
    response.status(403).json({ ok: false, error: "caller_not_authorized" });
    return;
  }
  // Peer existence must also be owner-scoped.
  const peerMembership = getLatestDeviceMembership(peerDeviceId);
  if (peerMembership === null || peerMembership.owner_canonical_id !== ownerCanonicalId) {
    response.status(404).json({ ok: false, error: "peer_not_in_owner" });
    return;
  }

  const key = peerProgressCacheKey(ownerCanonicalId, callerDeviceId, peerDeviceId);
  const now = Date.now();
  const cached = peerProgressCache.get(key);
  if (cached !== undefined && cached.expires_at > now) {
    response.json(cached.body);
    return;
  }

  const ourLastOriginSequence = getMaxOriginSequence(ownerCanonicalId, callerDeviceId);
  const peerGlobalCursor = getRecipientCursor(ownerCanonicalId, peerDeviceId);
  const peerRecipientCursor = getMaxOriginSequenceAtCursor(ownerCanonicalId, callerDeviceId, peerGlobalCursor);
  const inboundBehindBy = Math.max(0, ourLastOriginSequence - peerRecipientCursor);

  const body: PeerProgressBody = {
    peer_recipient_cursor: peerRecipientCursor,
    our_last_origin_sequence: ourLastOriginSequence,
    inbound_behind_by: inboundBehindBy,
    fresh_as_of_ms: now
  };
  peerProgressCache.set(key, { expires_at: now + PEER_PROGRESS_CACHE_TTL_MS, body });
  response.json(body);
});

// GET /api/devices/:ownerCanonicalId/sync/cursor?device_id=<recipient>
// Convenience for clients that lost their local cursor and want to
// resume from the last server-acknowledged position.
devicesRouter.get("/:ownerCanonicalId/sync/cursor", (request, response) => {
  const ownerCanonicalId = request.params.ownerCanonicalId;
  const recipientDeviceId = typeof request.query.device_id === "string" ? request.query.device_id : null;
  if (recipientDeviceId === null || recipientDeviceId.length === 0) {
    response.status(400).json({ ok: false, error: "missing_device_id" });
    return;
  }
  if (resolveActiveMembership(ownerCanonicalId, recipientDeviceId) === null) {
    response.status(403).json({ ok: false, error: "recipient_not_authorized" });
    return;
  }
  response.json({
    ok: true,
    last_server_seq: getRecipientCursor(ownerCanonicalId, recipientDeviceId)
  });
});

// Known sync slice/kind pairs accepted on POST /:owner/sync. New
// slices register here as they come online so unknown payloads are
// rejected at the edge instead of silently relayed.
function isKnownSliceKind(slice: unknown, kind: unknown): boolean {
  if (slice === "contact") return kind === "contact.upsert" || kind === "contact.delete";
  if (slice === "subscription") return kind === "subscription.upsert" || kind === "subscription.delete";
  if (slice === "message") return kind === "message.upsert" || kind === "message.delete";
  if (slice === "draft") return kind === "draft.upsert" || kind === "draft.delete";
  if (slice === "profile") return kind === "profile.upsert";
  if (slice === "read_state") return kind === "read_state.upsert";
  if (slice === "conversation_settings") return kind === "conversation_settings.upsert";
  if (slice === "tombstone_watermark") return kind === "tombstone_watermark.set";
  if (slice === "message_reaction") return kind === "message_reaction.upsert";
  if (slice === "message_attachment") return kind === "message_attachment.upsert";
  return false;
}

function normalizeCapabilities(value: unknown): TrustedDevice["capabilities"] {
  if (typeof value === "object" && value !== null) {
    const candidate = value as { can_sync?: unknown; can_decrypt?: unknown };
    return {
      can_sync: candidate.can_sync !== false,
      can_decrypt: candidate.can_decrypt !== false
    };
  }

  return {
    can_sync: true,
    can_decrypt: true
  };
}

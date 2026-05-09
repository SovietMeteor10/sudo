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
  consumePairingCode,
  createPairingToken,
  getLatestDeviceMembership,
  insertDeviceSyncEvent,
  listDeviceMemberships,
  listTrustedDevices,
  revokeTrustedDevice,
  upsertDeviceMembership,
  upsertTrustedDevice
} from "./devices.store.js";
import {
  getRecipientCursor,
  insertSyncEvent,
  listSyncEventsSince,
  setRecipientCursor
} from "./syncStore.js";

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
  const body = request.body as { owner_canonical_id?: unknown; device_name?: unknown };
  if (typeof body.owner_canonical_id !== "string" || body.owner_canonical_id.trim().length === 0) {
    response.status(400).json({ ok: false, error: "invalid_owner" });
    return;
  }

  const token = createPairingToken(body.owner_canonical_id);
  response.status(201).json({ ok: true, ...token });
});

devicesRouter.post("/pair/complete", (request, response) => {
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

  const result = insertSyncEvent(event);
  if (!result.ok) {
    response.status(409).json({ ok: false, error: result.error });
    return;
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
  response.json({ events, next_cursor: nextCursor });
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
  if (slice === "message") return kind === "message.upsert";
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

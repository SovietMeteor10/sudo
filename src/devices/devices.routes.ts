import { randomUUID } from "node:crypto";
import { Router } from "express";
import { verifyDeviceMembership } from "../crypto/signatures.js";
import { getIdentityByCanonicalId } from "../identity/registry.js";
import type {
  DeviceSyncEvent,
  SignedDeviceMembership,
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

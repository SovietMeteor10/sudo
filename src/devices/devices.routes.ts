import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { DeviceSyncEvent, TrustedDevice } from "../protocol/types.js";
import {
  consumePairingCode,
  createPairingToken,
  insertDeviceSyncEvent,
  listTrustedDevices,
  revokeTrustedDevice,
  upsertTrustedDevice
} from "./devices.store.js";

export const devicesRouter = Router();

devicesRouter.get("/:ownerCanonicalId", (request, response) => {
  response.json({ devices: listTrustedDevices(request.params.ownerCanonicalId) });
});

devicesRouter.post("/register", (request, response) => {
  const body = request.body as {
    owner_canonical_id?: unknown;
    device_id?: unknown;
    name?: unknown;
    device_public_key?: unknown;
    trust_state?: unknown;
    capabilities?: unknown;
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

  const device: TrustedDevice = {
    type: "sudo_trusted_device",
    device_id: body.device_id,
    owner_canonical_id: body.owner_canonical_id,
    name: body.name,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    trust_state: body.trust_state === "revoked" ? "revoked" : "active",
    device_public_key: body.device_public_key,
    capabilities: normalizeCapabilities(body.capabilities)
  };

  upsertTrustedDevice(device);
  response.status(201).json({ ok: true, device });
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

  response.status(201).json({ ok: true, device, pairing_code: body.pairing_code });
});

devicesRouter.post("/:deviceId/revoke", (request, response) => {
  const body = request.body as { owner_canonical_id?: unknown };
  if (typeof body.owner_canonical_id !== "string") {
    response.status(400).json({ ok: false, error: "invalid_owner" });
    return;
  }

  const device = revokeTrustedDevice(body.owner_canonical_id, request.params.deviceId);
  if (device === null) {
    response.status(404).json({ ok: false, error: "device_not_found" });
    return;
  }

  response.json({ ok: true, device });
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

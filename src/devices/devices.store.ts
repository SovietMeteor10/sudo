import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../storage/db.js";
import type { DeviceSyncEvent, TrustedDevice } from "../protocol/types.js";

type TrustedDeviceRow = {
  device_id: string;
  owner_canonical_id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
  trust_state: string;
  device_public_key: string;
  capabilities_json: string;
};

type PairingTokenRow = {
  pairing_token: string;
  owner_canonical_id: string;
  pairing_code: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export function listTrustedDevices(ownerCanonicalId: string): TrustedDevice[] {
  const rows = db
    .prepare("SELECT * FROM trusted_devices WHERE owner_canonical_id = ? ORDER BY last_seen_at DESC, created_at DESC")
    .all(ownerCanonicalId) as TrustedDeviceRow[];
  return rows.map(rowToTrustedDevice);
}

export function upsertTrustedDevice(device: TrustedDevice): TrustedDevice {
  db.prepare(`
    INSERT INTO trusted_devices (
      device_id,
      owner_canonical_id,
      name,
      created_at,
      last_seen_at,
      trust_state,
      device_public_key,
      capabilities_json
    ) VALUES (
      @device_id,
      @owner_canonical_id,
      @name,
      @created_at,
      @last_seen_at,
      @trust_state,
      @device_public_key,
      @capabilities_json
    )
    ON CONFLICT(device_id) DO UPDATE SET
      owner_canonical_id = excluded.owner_canonical_id,
      name = excluded.name,
      last_seen_at = excluded.last_seen_at,
      trust_state = excluded.trust_state,
      device_public_key = excluded.device_public_key,
      capabilities_json = excluded.capabilities_json
  `).run({
    ...device,
    capabilities_json: JSON.stringify(device.capabilities)
  });

  return device;
}

export function revokeTrustedDevice(ownerCanonicalId: string, deviceId: string): TrustedDevice | null {
  const device = getTrustedDevice(deviceId);
  if (device === null || device.owner_canonical_id !== ownerCanonicalId) {
    return null;
  }

  const revoked = { ...device, trust_state: "revoked" as const, last_seen_at: new Date().toISOString() };
  upsertTrustedDevice(revoked);
  return revoked;
}

export function getTrustedDevice(deviceId: string): TrustedDevice | null {
  const row = db
    .prepare("SELECT * FROM trusted_devices WHERE device_id = ?")
    .get(deviceId) as TrustedDeviceRow | undefined;
  return row ? rowToTrustedDevice(row) : null;
}

export function createPairingToken(ownerCanonicalId: string): { pairing_code: string; pairing_token: string; expires_at: string } {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.valueOf() + 15 * 60 * 1000);
  const pairingCode = createPairingCode();
  const pairingToken = randomUUID();

  db.prepare(`
    INSERT INTO device_pairing_tokens (
      pairing_token,
      owner_canonical_id,
      pairing_code,
      created_at,
      expires_at,
      consumed_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `).run(pairingToken, ownerCanonicalId, pairingCode, createdAt.toISOString(), expiresAt.toISOString());

  return {
    pairing_code: pairingCode,
    pairing_token: pairingToken,
    expires_at: expiresAt.toISOString()
  };
}

export function consumePairingCode(pairingCode: string): PairingTokenRow | null {
  const row = db
    .prepare("SELECT * FROM device_pairing_tokens WHERE pairing_code = ?")
    .get(pairingCode) as PairingTokenRow | undefined;

  if (!row) return null;
  if (row.consumed_at !== null) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  db.prepare("UPDATE device_pairing_tokens SET consumed_at = ? WHERE pairing_token = ?").run(new Date().toISOString(), row.pairing_token);
  return row;
}

export function insertDeviceSyncEvent(event: DeviceSyncEvent): void {
  db.prepare(`
    INSERT INTO device_sync_events (
      event_id,
      owner_canonical_id,
      device_id,
      event_type,
      created_at,
      encrypted_payload
    ) VALUES (
      @event_id,
      @owner_canonical_id,
      @device_id,
      @event_type,
      @created_at,
      @encrypted_payload
    )
  `).run(event);
}

function rowToTrustedDevice(row: TrustedDeviceRow): TrustedDevice {
  const capabilities = normalizeCapabilities(parseJson(row.capabilities_json));
  return {
    type: "sudo_trusted_device",
    device_id: row.device_id,
    owner_canonical_id: row.owner_canonical_id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    trust_state: row.trust_state === "revoked" ? "revoked" : "active",
    device_public_key: row.device_public_key,
    capabilities
  };
}

function createPairingCode(): string {
  return `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`.toUpperCase();
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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

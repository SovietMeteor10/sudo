import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../storage/db.js";
import type { DeviceSyncEvent, SignedDeviceMembership, TrustedDevice } from "../protocol/types.js";

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

type DeviceMembershipRow = {
  device_id: string;
  owner_canonical_id: string;
  sequence: number;
  trust_state: string;
  membership_json: string;
  created_at: string;
  updated_at: string;
};

// Persists the canonical signed membership doc and returns it. Caller
// is responsible for verifying the signature first; the store will
// reject inserts that go backwards in sequence (replay protection).
export function upsertDeviceMembership(membership: SignedDeviceMembership): SignedDeviceMembership {
  const latest = getLatestDeviceMembership(membership.device_id);
  if (latest !== null && membership.sequence < latest.sequence) {
    throw new Error("device membership sequence regression");
  }

  db.prepare(`
    INSERT INTO device_memberships (
      device_id,
      owner_canonical_id,
      sequence,
      trust_state,
      membership_json,
      created_at,
      updated_at
    ) VALUES (
      @device_id,
      @owner_canonical_id,
      @sequence,
      @trust_state,
      @membership_json,
      @created_at,
      @updated_at
    )
    ON CONFLICT(device_id, sequence) DO UPDATE SET
      owner_canonical_id = excluded.owner_canonical_id,
      trust_state = excluded.trust_state,
      membership_json = excluded.membership_json,
      updated_at = excluded.updated_at
  `).run({
    device_id: membership.device_id,
    owner_canonical_id: membership.owner_canonical_id,
    sequence: membership.sequence,
    trust_state: membership.trust_state,
    membership_json: JSON.stringify(membership),
    created_at: membership.created_at,
    updated_at: membership.updated_at
  });

  return membership;
}

export function getLatestDeviceMembership(deviceId: string): SignedDeviceMembership | null {
  const row = db
    .prepare("SELECT * FROM device_memberships WHERE device_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(deviceId) as DeviceMembershipRow | undefined;
  return row ? rowToMembership(row) : null;
}

export function listDeviceMemberships(ownerCanonicalId: string): SignedDeviceMembership[] {
  // Latest doc per device_id, restricted to this owner. Older sequences
  // are kept for audit/rebuild but the listing surfaces only the
  // current canonical state.
  const rows = db
    .prepare(`
      SELECT m.* FROM device_memberships m
      INNER JOIN (
        SELECT device_id, MAX(sequence) AS max_sequence
        FROM device_memberships
        WHERE owner_canonical_id = ?
        GROUP BY device_id
      ) latest
        ON latest.device_id = m.device_id AND latest.max_sequence = m.sequence
      WHERE m.owner_canonical_id = ?
      ORDER BY m.updated_at DESC
    `)
    .all(ownerCanonicalId, ownerCanonicalId) as DeviceMembershipRow[];
  return rows.map(rowToMembership);
}

function rowToMembership(row: DeviceMembershipRow): SignedDeviceMembership {
  return JSON.parse(row.membership_json) as SignedDeviceMembership;
}

// Rebuild the trusted_devices index from the canonical membership log
// for a single owner. Useful when the cache table is wiped or skewed
// from the canonical record. Not wired into a live route — reserved
// for ops/recovery work.
export function rebuildTrustedDevicesFromMemberships(ownerCanonicalId: string): TrustedDevice[] {
  const memberships = listDeviceMemberships(ownerCanonicalId);
  const rebuilt: TrustedDevice[] = memberships.map((membership) => ({
    type: "sudo_trusted_device",
    device_id: membership.device_id,
    owner_canonical_id: membership.owner_canonical_id,
    name: membership.name,
    created_at: membership.created_at,
    last_seen_at: membership.updated_at,
    trust_state: membership.trust_state,
    device_public_key: membership.device_public_key,
    capabilities: {
      can_sync: membership.capabilities.can_sync !== false,
      can_decrypt: membership.capabilities.can_decrypt !== false
    }
  }));

  for (const device of rebuilt) {
    upsertTrustedDevice(device);
  }

  return rebuilt;
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

// push_subscriptions DB ops. One row per (device_id, endpoint).
//
// Threat model: an attacker who reads this table sees opaque FCM /
// Mozilla / Apple endpoints + their per-subscription crypto material.
// They can NOT recover plaintext messages (push payloads only ever
// contain non-secret metadata — see push.service.ts). The worst they
// can do is enumerate "device X has a subscription on endpoint Y".

import { db } from "../storage/db.js";

export type PushSubscriptionRow = {
  id: number;
  owner_canonical_id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_seen_at: string;
};

export type PushSubscriptionInsert = {
  owner_canonical_id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const upsertStmt = db.prepare(`
  INSERT INTO push_subscriptions (
    owner_canonical_id, device_id, endpoint, p256dh, auth, created_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, endpoint) DO UPDATE SET
    owner_canonical_id = excluded.owner_canonical_id,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    last_seen_at = excluded.last_seen_at
`);

const listByRecipientStmt = db.prepare(`
  SELECT id, owner_canonical_id, device_id, endpoint, p256dh, auth, created_at, last_seen_at
  FROM push_subscriptions
  WHERE owner_canonical_id = ?
`);

const listByDeviceStmt = db.prepare(`
  SELECT id, owner_canonical_id, device_id, endpoint, p256dh, auth, created_at, last_seen_at
  FROM push_subscriptions
  WHERE device_id = ?
`);

const deleteByDeviceStmt = db.prepare(`
  DELETE FROM push_subscriptions WHERE device_id = ?
`);

const deleteByDeviceAndEndpointStmt = db.prepare(`
  DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?
`);

const deleteByEndpointStmt = db.prepare(`
  DELETE FROM push_subscriptions WHERE endpoint = ?
`);

const deleteByOwnerStmt = db.prepare(`
  DELETE FROM push_subscriptions WHERE owner_canonical_id = ?
`);

const countByOwnerStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner_canonical_id = ?
`);

export function upsertPushSubscription(input: PushSubscriptionInsert, now = new Date()): PushSubscriptionRow {
  const iso = now.toISOString();
  upsertStmt.run(
    input.owner_canonical_id,
    input.device_id,
    input.endpoint,
    input.p256dh,
    input.auth,
    iso,
    iso
  );
  const row = db.prepare(`
    SELECT id, owner_canonical_id, device_id, endpoint, p256dh, auth, created_at, last_seen_at
    FROM push_subscriptions
    WHERE device_id = ? AND endpoint = ?
  `).get(input.device_id, input.endpoint) as PushSubscriptionRow;
  return row;
}

export function listPushSubscriptionsForRecipient(ownerCanonicalId: string): PushSubscriptionRow[] {
  return listByRecipientStmt.all(ownerCanonicalId) as PushSubscriptionRow[];
}

export function listPushSubscriptionsForDevice(deviceId: string): PushSubscriptionRow[] {
  return listByDeviceStmt.all(deviceId) as PushSubscriptionRow[];
}

export function deletePushSubscriptionsForDevice(deviceId: string): number {
  return deleteByDeviceStmt.run(deviceId).changes;
}

export function deletePushSubscriptionByDeviceAndEndpoint(deviceId: string, endpoint: string): number {
  return deleteByDeviceAndEndpointStmt.run(deviceId, endpoint).changes;
}

// Used by the delivery path when the push provider returns 404/410 —
// the endpoint is dead and any row referencing it should be evicted.
export function deletePushSubscriptionsByEndpoint(endpoint: string): number {
  return deleteByEndpointStmt.run(endpoint).changes;
}

export function deletePushSubscriptionsForOwner(ownerCanonicalId: string): number {
  return deleteByOwnerStmt.run(ownerCanonicalId).changes;
}

export function countPushSubscriptionsForOwner(ownerCanonicalId: string): number {
  const row = countByOwnerStmt.get(ownerCanonicalId) as { n: number };
  return row.n;
}

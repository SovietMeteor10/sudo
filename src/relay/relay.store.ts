import { db } from "../storage/db.js";
import {
  connectionTierToRelayTier,
  getConnectionEffectiveTier,
  upsertConnectionRelationship
} from "../connections/connections.store.js";
import type { RelayEnvelope, RelayEnvelopeStatus, RelayRelationship, RelayTier } from "./relay.types.js";

const pendingStatus = "stored_by_relay";

type RelayEnvelopeRow = {
  message_id: string;
  sender_canonical_id: string;
  recipient_canonical_id: string;
  sender_handle: string | null;
  recipient_handle: string | null;
  ciphertext: string;
  ciphertext_scheme: string;
  created_at: string;
  expires_at: string;
  status: RelayEnvelopeStatus;
  sender_signature: string | null;
  envelope_json: string;
};

type RelationshipRow = RelayRelationship;

export function insertRelayEnvelope(envelope: RelayEnvelope): void {
  db.prepare(`
    INSERT INTO relay_envelopes (
      message_id,
      sender_canonical_id,
      recipient_canonical_id,
      sender_handle,
      recipient_handle,
      ciphertext,
      ciphertext_scheme,
      created_at,
      expires_at,
      status,
      sender_signature,
      envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelope.message_id,
    envelope.sender_canonical_id,
    envelope.recipient_canonical_id,
    envelope.sender_handle ?? null,
    envelope.recipient_handle ?? null,
    envelope.ciphertext,
    envelope.ciphertext_scheme,
    envelope.created_at,
    envelope.expires_at,
    envelope.status,
    envelope.sender_signature,
    JSON.stringify(envelope)
  );
}

export function listPendingRelayEnvelopesForRecipient(recipientCanonicalId: string, now: Date): RelayEnvelope[] {
  const rows = db.prepare(`
    SELECT *
    FROM relay_envelopes
    WHERE recipient_canonical_id = ?
      AND status = ?
      AND expires_at > ?
    ORDER BY created_at ASC
  `).all(recipientCanonicalId, pendingStatus, now.toISOString()) as RelayEnvelopeRow[];

  return rows.map(rowToEnvelope);
}

export function getRelayRelationshipTier(
  senderCanonicalId: string,
  recipientCanonicalId: string
): RelayTier {
  const effectiveTier = getConnectionEffectiveTier(recipientCanonicalId, senderCanonicalId);
  if (effectiveTier !== "unknown") {
    return connectionTierToRelayTier(effectiveTier);
  }

  const row = db.prepare(`
    SELECT tier
    FROM relay_relationships
    WHERE sender_canonical_id = ?
      AND recipient_canonical_id = ?
  `).get(senderCanonicalId, recipientCanonicalId) as { tier: RelayTier } | undefined;

  if (row?.tier === "known" || row?.tier === "blocked" || row?.tier === "unknown") {
    return row.tier;
  }

  return "unknown";
}

export function upsertRelayRelationship(
  senderCanonicalId: string,
  recipientCanonicalId: string,
  tier: RelayTier,
  now: Date
): RelayRelationship {
  const relationship = upsertConnectionRelationship(
    recipientCanonicalId,
    senderCanonicalId,
    tier === "blocked" ? "blocked" : tier === "known" ? "known" : "unknown",
    tier !== "blocked",
    undefined,
    undefined,
    now
  );

  return {
    sender_canonical_id: senderCanonicalId,
    recipient_canonical_id: recipientCanonicalId,
    tier: connectionTierToRelayTier(relationship.tier),
    created_at: relationship.created_at,
    updated_at: relationship.updated_at
  };
}

export function getPendingCounts(
  senderCanonicalId: string,
  recipientCanonicalId: string,
  now: Date
): { global: number; recipient: number; sender: number; pair: number } {
  const nowIso = now.toISOString();
  return {
    global: countPending("SELECT COUNT(*) AS count FROM relay_envelopes WHERE status = ? AND expires_at > ?", [pendingStatus, nowIso]),
    recipient: countPending("SELECT COUNT(*) AS count FROM relay_envelopes WHERE recipient_canonical_id = ? AND status = ? AND expires_at > ?", [recipientCanonicalId, pendingStatus, nowIso]),
    sender: countPending("SELECT COUNT(*) AS count FROM relay_envelopes WHERE sender_canonical_id = ? AND status = ? AND expires_at > ?", [senderCanonicalId, pendingStatus, nowIso]),
    pair: countPending("SELECT COUNT(*) AS count FROM relay_envelopes WHERE sender_canonical_id = ? AND recipient_canonical_id = ? AND status = ? AND expires_at > ?", [senderCanonicalId, recipientCanonicalId, pendingStatus, nowIso])
  };
}

export function relayEnvelopeExists(messageId: string): boolean {
  const row = db.prepare("SELECT message_id FROM relay_envelopes WHERE message_id = ?").get(messageId);
  return row !== undefined;
}

export function ackRelayEnvelope(messageId: string): boolean {
  const row = db.prepare("SELECT * FROM relay_envelopes WHERE message_id = ?").get(messageId) as RelayEnvelopeRow | undefined;
  if (!row) return false;

  const envelope = {
    ...rowToEnvelope(row),
    status: "acked" as const,
    ciphertext: ""
  };

  const result = db.prepare(`
    UPDATE relay_envelopes
    SET status = 'acked',
        ciphertext = '',
        envelope_json = ?
    WHERE message_id = ?
  `).run(JSON.stringify(redactEnvelope(envelope)), messageId);

  return result.changes > 0;
}

export function expireRelayEnvelopes(now: Date): number {
  const rows = db.prepare(`
    SELECT *
    FROM relay_envelopes
    WHERE status = ?
      AND expires_at <= ?
  `).all(pendingStatus, now.toISOString()) as RelayEnvelopeRow[];

  const update = db.prepare(`
    UPDATE relay_envelopes
    SET status = 'expired',
        ciphertext = '',
        envelope_json = ?
    WHERE message_id = ?
  `);

  const expire = db.transaction((expiredRows: RelayEnvelopeRow[]) => {
    for (const row of expiredRows) {
      const envelope = {
        ...rowToEnvelope(row),
        status: "expired" as const,
        ciphertext: ""
      };
      update.run(JSON.stringify(redactEnvelope(envelope)), row.message_id);
    }
  });

  expire(rows);
  return rows.length;
}

function rowToEnvelope(row: RelayEnvelopeRow): RelayEnvelope {
  try {
    const parsed = JSON.parse(row.envelope_json) as RelayEnvelope;
    return {
      ...parsed,
      ciphertext: row.ciphertext,
      status: row.status
    };
  } catch {
    return {
      type: "sudo_relay_envelope",
      protocol_version: "0.1.0",
      message_id: row.message_id,
      sender_canonical_id: row.sender_canonical_id,
      recipient_canonical_id: row.recipient_canonical_id,
      sender_handle: row.sender_handle ?? undefined,
      recipient_handle: row.recipient_handle ?? undefined,
      ciphertext: row.ciphertext,
      ciphertext_scheme: row.ciphertext_scheme,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: row.status,
      sender_signature: row.sender_signature ?? "placeholder"
    };
  }
}

function redactEnvelope(envelope: RelayEnvelope): Omit<RelayEnvelope, "ciphertext"> & { ciphertext_redacted: true } {
  const { ciphertext, ...rest } = envelope;
  void ciphertext;
  return {
    ...rest,
    ciphertext_redacted: true
  };
}

function countPending(sql: string, parameters: unknown[]): number {
  const row = db.prepare(sql).get(...parameters) as { count: number };
  return row.count;
}

export { listEncryptedMessages, storeEncryptedMessage } from "./messageStore.js";
export type { RelayDeliveryResult } from "./messageStore.js";

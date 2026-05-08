import { db } from "../storage/db.js";
import { getIdentityByCanonicalId } from "../identity/registry.js";
import type { EncryptedMessageEnvelope, StoredEncryptedMessage } from "../protocol/types.js";

type MessageRow = {
  id: number;
  sender: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  received_at: string;
};

export type RelayDeliveryResult =
  | { status: "accepted" }
  | { status: "recipient_not_found" };

export function storeEncryptedMessage(
  canonicalId: string,
  envelope: EncryptedMessageEnvelope
): RelayDeliveryResult {
  const identity = getIdentityByCanonicalId(canonicalId);

  if (!identity) {
    return { status: "recipient_not_found" };
  }

  // The relay is only a blind encrypted blob store. Payloads must not be logged.
  db.prepare(`
    INSERT INTO encrypted_messages (
      canonical_id,
      sender,
      ciphertext,
      nonce,
      signature,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    identity.canonicalId,
    envelope.from,
    envelope.ciphertext,
    envelope.nonce,
    envelope.signature,
    new Date().toISOString()
  );

  return { status: "accepted" };
}

export function listEncryptedMessages(canonicalId: string): StoredEncryptedMessage[] | null {
  const identity = getIdentityByCanonicalId(canonicalId);

  if (!identity) {
    return null;
  }

  const rows = db
    .prepare(`
      SELECT id, sender, ciphertext, nonce, signature, received_at
      FROM encrypted_messages
      WHERE canonical_id = ?
      ORDER BY received_at DESC
    `)
    .all(identity.canonicalId) as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    from: row.sender,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    signature: row.signature,
    received_at: row.received_at
  }));
}

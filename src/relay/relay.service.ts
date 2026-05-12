import { randomUUID } from "node:crypto";
import { verifyCanonicalSignature } from "../crypto/signatures.js";
import { SUDO_PROTOCOL_VERSION } from "../protocol/constants.js";
import { getIdentityByCanonicalId } from "../identity/identity.store.js";
import { fireAndForgetPush } from "../push/push.service.js";
import { evaluateRelayPolicy } from "./relay.policy.js";
import type {
  LegacyEncryptedMessageEnvelope,
  RelayEnvelope,
  RelayRelationship,
  RelayTier,
  SubmitRelayEnvelopeResult
} from "./relay.types.js";
import {
  ackRelayEnvelope,
  expireRelayEnvelopes,
  getPendingCounts,
  getRelayRelationshipTier,
  insertRelayEnvelope,
  listEncryptedMessages,
  listPendingRelayEnvelopesForRecipient,
  relayEnvelopeExists,
  storeEncryptedMessage,
  upsertRelayRelationship
} from "./relay.store.js";

export function deliverRelayEnvelope(canonicalId: string, envelope: LegacyEncryptedMessageEnvelope) {
  return storeEncryptedMessage(canonicalId, envelope);
}

export function listRelayEnvelopes(canonicalId: string) {
  return listEncryptedMessages(canonicalId);
}

export function submitRelayEnvelope(input: unknown, now = new Date()): SubmitRelayEnvelopeResult {
  const parsed = parseRelayEnvelopeInput(input);
  if (parsed === null) {
    return { ok: false, error: "invalid_envelope" };
  }

  if (relayEnvelopeExists(parsed.message_id)) {
    return { ok: false, error: "duplicate_message" };
  }

  const tier = getRelayRelationshipTier(parsed.sender_canonical_id, parsed.recipient_canonical_id);
  const counts = getPendingCounts(parsed.sender_canonical_id, parsed.recipient_canonical_id, now);
  const ciphertextBytes = Buffer.byteLength(parsed.ciphertext, "utf8");
  const decision = evaluateRelayPolicy(tier, counts, ciphertextBytes);
  if (!decision.ok) {
    return { ok: false, error: decision.error };
  }

  if (parsed.sender_signature !== "dev-placeholder" && parsed.sender_signature !== "dev-placeholder:relay-signature-unavailable") {
    const sender = getIdentityByCanonicalId(parsed.sender_canonical_id);
    if (sender === null) {
      return { ok: false, error: "invalid_envelope" };
    }

    const isValid = verifyCanonicalSignature(
      relaySignableEnvelope(parsed),
      parsed.sender_signature,
      sender.document.keys.identity.public_key,
      sender.document.keys.identity.type ?? "ed25519"
    );

    if (!isValid) {
      return { ok: false, error: "invalid_envelope" };
    }
  }

  const createdAt = normalizeCreatedAt(parsed.created_at, now);
  const expiresAt = normalizeExpiresAt(parsed.expires_at, createdAt, decision.ttlHours);
  if (expiresAt.valueOf() <= now.valueOf()) {
    return { ok: false, error: "expired" };
  }

  const envelope: RelayEnvelope = {
    ...parsed,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    status: "stored_by_relay"
  };

  try {
    insertRelayEnvelope(envelope);
  } catch (error) {
    if (isSqliteDuplicate(error)) {
      return { ok: false, error: "duplicate_message" };
    }
    throw error;
  }

  // Best-effort push fan-out. We pass only metadata the relay already
  // sees in plaintext (sender handle + recipient canonical_id); the
  // ciphertext stays opaque. The push payload itself is shaped in
  // push.service.ts — the relay path does not influence whether
  // preview text is shown (that decision lives in the SW, using local
  // conversation_settings).
  fireAndForgetPush({
    recipientCanonicalId: envelope.recipient_canonical_id,
    senderCanonicalId: envelope.sender_canonical_id,
    senderHandle: typeof envelope.sender_handle === "string" && envelope.sender_handle.length > 0
      ? envelope.sender_handle
      : envelope.sender_canonical_id,
    unreadCount: counts.recipient + 1
  });

  return {
    ok: true,
    message_id: envelope.message_id,
    status: "stored_by_relay",
    expires_at: envelope.expires_at
  };
}

export function listRecipientRelayInbox(recipientCanonicalId: string, now = new Date()): RelayEnvelope[] {
  return listPendingRelayEnvelopesForRecipient(recipientCanonicalId, now);
}

export function ackStoredRelayEnvelope(messageId: string): { ok: true } | { ok: false; error: "not_found" } {
  return ackRelayEnvelope(messageId) ? { ok: true } : { ok: false, error: "not_found" };
}

export function setRelayRelationship(
  senderCanonicalId: string,
  recipientCanonicalId: string,
  tier: RelayTier,
  now = new Date()
): RelayRelationship {
  return upsertRelayRelationship(senderCanonicalId, recipientCanonicalId, tier, now);
}

export function expireStoredRelayEnvelopes(now = new Date()): { expired: number } {
  return { expired: expireRelayEnvelopes(now) };
}

export function createCompatibilityRelayEnvelope(
  recipientCanonicalId: string,
  envelope: LegacyEncryptedMessageEnvelope,
  now = new Date()
): RelayEnvelope {
  const sender = String(envelope.from);
  return {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: randomUUID(),
    sender_canonical_id: sender.startsWith("sudo:") ? sender : `dev:${sender}`,
    recipient_canonical_id: recipientCanonicalId,
    sender_handle: sender.startsWith("@") ? sender : undefined,
    ciphertext: envelope.ciphertext,
    ciphertext_scheme: "dev-placeholder",
    created_at: now.toISOString(),
    expires_at: new Date(now.valueOf() + 72 * 60 * 60 * 1000).toISOString(),
    status: "submitted_to_relay",
    sender_signature: envelope.signature
  };
}

function parseRelayEnvelopeInput(input: unknown): RelayEnvelope | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Partial<RelayEnvelope>;

  if (
    value.type !== "sudo_relay_envelope" ||
    value.protocol_version !== SUDO_PROTOCOL_VERSION ||
    typeof value.sender_canonical_id !== "string" ||
    typeof value.recipient_canonical_id !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.ciphertext_scheme !== "string"
  ) {
    return null;
  }

  const envelope: RelayEnvelope = {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: typeof value.message_id === "string" && value.message_id.length > 0 ? value.message_id : randomUUID(),
    sender_canonical_id: value.sender_canonical_id,
    recipient_canonical_id: value.recipient_canonical_id,
    sender_handle: typeof value.sender_handle === "string" ? value.sender_handle : undefined,
    recipient_handle: typeof value.recipient_handle === "string" ? value.recipient_handle : undefined,
    ciphertext: value.ciphertext,
    ciphertext_scheme: value.ciphertext_scheme,
    created_at: typeof value.created_at === "string" ? value.created_at : new Date().toISOString(),
    expires_at: typeof value.expires_at === "string" ? value.expires_at : "",
    status: "submitted_to_relay",
    sender_signature: typeof value.sender_signature === "string" ? value.sender_signature : "dev-placeholder"
  };
  // Optional cross-user reply pointer + forwarded flag. These are
  // additive — older clients (and the dev-placeholder signing path)
  // simply omit them. The relay treats them as opaque pass-through
  // metadata; receiver-side handling is the canonical interpreter.
  if (typeof value.reply_to_relay_message_id === "string" && value.reply_to_relay_message_id.length > 0) {
    envelope.reply_to_relay_message_id = value.reply_to_relay_message_id;
  }
  if (value.is_forwarded === true) {
    envelope.is_forwarded = true;
  }
  return envelope;
}

function relaySignableEnvelope(envelope: RelayEnvelope): Omit<RelayEnvelope, "sender_signature" | "status"> {
  const { sender_signature: _senderSignature, status: _status, ...signable } = envelope;
  return signable;
}

function normalizeCreatedAt(value: string, fallback: Date): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return fallback;
  return parsed;
}

function normalizeExpiresAt(value: string, createdAt: Date, ttlHours: number): Date {
  const parsed = new Date(value);
  const maxExpiresAt = new Date(createdAt.valueOf() + ttlHours * 60 * 60 * 1000);
  if (Number.isNaN(parsed.valueOf()) || parsed.valueOf() > maxExpiresAt.valueOf()) {
    return maxExpiresAt;
  }
  return parsed;
}

function isSqliteDuplicate(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) || (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed")
  );
}

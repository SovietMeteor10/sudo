import type { RelayEnvelope } from "../../../protocol/types.js";
import { DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS } from "../../../protocol/constants.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import { decryptPrivateMessage, encryptPrivateMessage, type BrowserEncryptedMessage } from "../crypto/messaging.js";
import { signRelayEnvelope } from "../crypto/signing.js";
import { base64Url, base64UrlToBytes } from "./crypto.js";
import {
  appendLocalEvent,
  saveLocalMessage,
  savePendingOutbound
} from "./local-store.js";
import type { LocalMessage, PendingOutbound } from "./local-types.js";

const SUDO_PROTOCOL_VERSION = "0.1.0";

export async function queueAndSubmitLocalMessage(options: {
  senderCanonicalId: string;
  recipientCanonicalId: string;
  senderHandle?: string;
  recipientHandle?: string;
  body: string;
  senderAccount?: BrowserCryptoAccount | null;
  recipientMessagingPublicKey?: string;
  recipientMessagingKeyType?: "x25519" | "ecdh-p256";
}): Promise<{ ok: boolean; message_id: string; error?: string }> {
  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const conversationId = conversationIdFor(options.senderCanonicalId, options.recipientCanonicalId);
  const encrypted = await createEnvelopeCiphertext(options);
  const expiresAt = new Date(Date.parse(now) + DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS * 60 * 60 * 1000).toISOString();
  const ciphertext = encrypted.scheme === "dev-placeholder"
    ? encrypted.ciphertext
    : base64Url(new TextEncoder().encode(JSON.stringify(encrypted)));
  const envelope: RelayEnvelope = {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: messageId,
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId,
    sender_handle: options.senderHandle,
    recipient_handle: options.recipientHandle,
    ciphertext,
    ciphertext_scheme: encrypted.scheme,
    created_at: now,
    expires_at: expiresAt,
    status: "queued_local",
    sender_signature: "dev-placeholder"
  };

  if (
    options.senderAccount !== undefined
    && options.senderAccount !== null
    && options.recipientMessagingPublicKey !== undefined
    && options.recipientMessagingKeyType !== undefined
  ) {
    envelope.sender_signature = await signRelayEnvelope(
      {
        type: envelope.type,
        protocol_version: envelope.protocol_version,
        message_id: envelope.message_id,
        sender_canonical_id: envelope.sender_canonical_id,
        recipient_canonical_id: envelope.recipient_canonical_id,
        sender_handle: envelope.sender_handle,
        recipient_handle: envelope.recipient_handle,
        ciphertext: envelope.ciphertext,
        ciphertext_scheme: envelope.ciphertext_scheme,
        created_at: envelope.created_at,
        expires_at: envelope.expires_at
      },
      options.senderAccount.identity_key,
      options.senderAccount.identity_key_type
    );
  }

  // DEV ONLY: local plaintext message bodies are stored until real
  // client-side encryption lands. Encrypted backup export protects at-rest
  // backup files; browser storage still depends on this device profile.
  const message: LocalMessage = {
    message_id: messageId,
    conversation_id: conversationId,
    direction: "sent",
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId,
    body: options.body,
    ciphertext,
    created_at: now,
    updated_at: now,
    status: "queued_local",
    relay_message_id: envelope.message_id
  };

  const outbound: PendingOutbound = {
    local_queue_id: crypto.randomUUID(),
    message_id: messageId,
    recipient_canonical_id: options.recipientCanonicalId,
    status: "queued_local",
    envelope,
    created_at: now,
    updated_at: now
  };

  await saveLocalMessage(message);
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: "message.sent.local",
    created_at: now,
    subject_id: messageId,
    data: { status: "queued_local" }
  });
  await savePendingOutbound(outbound);

  try {
    const response = await fetch("/api/relay/envelopes", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(envelope)
    });
    const result = await response.json() as { ok?: boolean; status?: string; error?: string; expires_at?: string };
    const updatedAt = new Date().toISOString();

    if (response.ok && result.ok === true) {
      await saveLocalMessage({
        ...message,
        updated_at: updatedAt,
        status: "stored_by_relay"
      });
      await savePendingOutbound({
        ...outbound,
        updated_at: updatedAt,
        status: "stored_by_relay",
        envelope: {
          ...envelope,
          status: "stored_by_relay",
          expires_at: result.expires_at ?? envelope.expires_at
        }
      });
      return { ok: true, message_id: messageId };
    }

    await markFailed(message, outbound, result.error ?? `relay rejected: ${response.status}`);
    return { ok: false, message_id: messageId, error: result.error ?? "relay_rejected" };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "relay submit failed";
    await markFailed(message, outbound, messageText);
    return { ok: false, message_id: messageId, error: messageText };
  }
}

export async function retrieveRelayInboxAfterLocalSave(
  recipientCanonicalId: string,
  options: {
    recipientAccount?: BrowserCryptoAccount | null;
    senderMessagingPublicKey?: string;
    senderMessagingKeyType?: "x25519" | "ecdh-p256";
  } = {}
): Promise<number> {
  const response = await fetch(`/api/relay/inbox/${encodeURIComponent(recipientCanonicalId)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`relay inbox failed: ${response.status}`);

  const body = await response.json() as { envelopes?: RelayEnvelope[] };
  const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];

  for (const envelope of envelopes) {
    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const plaintext = await maybeDecryptEnvelope(envelope, options);
    const message: LocalMessage = {
      message_id: messageId,
      conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
      direction: "received",
      sender_canonical_id: envelope.sender_canonical_id,
      recipient_canonical_id: envelope.recipient_canonical_id,
      body: plaintext,
      ciphertext: envelope.ciphertext,
      created_at: envelope.created_at,
      updated_at: now,
      status: "delivered_to_recipient_device",
      relay_message_id: envelope.message_id
    };

    await saveLocalMessage(message);
    await appendLocalEvent({
      event_id: crypto.randomUUID(),
      type: "message.received.local",
      created_at: now,
      subject_id: messageId,
      data: { relay_message_id: envelope.message_id }
    });

    const ackResponse = await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
      method: "POST",
      headers: { accept: "application/json" }
    });

    if (ackResponse.ok) {
      await appendLocalEvent({
        event_id: crypto.randomUUID(),
        type: "message.acked.local",
        created_at: new Date().toISOString(),
        subject_id: messageId,
        data: { relay_message_id: envelope.message_id }
      });
    }
  }

  return envelopes.length;
}

async function createEnvelopeCiphertext(options: {
  body: string;
  senderAccount?: BrowserCryptoAccount | null;
  recipientMessagingPublicKey?: string;
  recipientMessagingKeyType?: "x25519" | "ecdh-p256";
}): Promise<{ ciphertext: string; scheme: string }> {
  if (
    options.senderAccount !== undefined
    && options.senderAccount !== null
    && options.recipientMessagingPublicKey !== undefined
    && options.recipientMessagingKeyType !== undefined
  ) {
    const encrypted = await encryptPrivateMessage({
      plaintext: options.body,
      senderPrivateMessagingKey: options.senderAccount.messaging_key,
      senderMessagingKeyType: options.senderAccount.messaging_key_type,
      recipientMessagingPublicKey: options.recipientMessagingPublicKey,
      recipientMessagingKeyType: options.recipientMessagingKeyType
    });
    return { ciphertext: encrypted.ciphertext, scheme: encrypted.scheme };
  }

  return {
    ciphertext: `dev-placeholder:${btoa(unescape(encodeURIComponent(options.body)))}`,
    scheme: "dev-placeholder"
  };
}

async function maybeDecryptEnvelope(
  envelope: RelayEnvelope,
  options: {
    recipientAccount?: BrowserCryptoAccount | null;
    senderMessagingPublicKey?: string;
    senderMessagingKeyType?: "x25519" | "ecdh-p256";
  } = {}
): Promise<string> {
  if (
    options.recipientAccount !== undefined
    && options.recipientAccount !== null
    && options.senderMessagingPublicKey !== undefined
    && options.senderMessagingKeyType !== undefined
    && envelope.ciphertext_scheme !== "dev-placeholder"
  ) {
    try {
      const packed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(envelope.ciphertext))) as BrowserEncryptedMessage;
      const encrypted: BrowserEncryptedMessage = {
        scheme: envelope.ciphertext_scheme === "x25519-aes-gcm-v1" ? "x25519-aes-gcm-v1" : "ecdh-p256-aes-gcm-v1",
        iv: packed.iv,
        ciphertext: packed.ciphertext
      };
      return await decryptPrivateMessage({
        encrypted,
        recipientPrivateMessagingKey: options.recipientAccount.messaging_key,
        senderMessagingPublicKey: options.senderMessagingPublicKey,
        senderMessagingKeyType: options.senderMessagingKeyType
      });
    } catch {
      return "";
    }
  }

  return "";
}

async function markFailed(message: LocalMessage, outbound: PendingOutbound, error: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await saveLocalMessage({ ...message, updated_at: updatedAt, status: "failed" });
  await savePendingOutbound({ ...outbound, updated_at: updatedAt, status: "failed", last_error: error });
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: "message.failed.local",
    created_at: updatedAt,
    subject_id: message.message_id,
    data: { error }
  });
}

function conversationIdFor(left: string, right: string): string {
  return [left, right].sort().join("|");
}

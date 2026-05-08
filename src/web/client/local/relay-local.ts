import type { IdentityDocument, RelayEnvelope } from "../../../protocol/types.js";
import { DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS } from "../../../protocol/constants.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import { decryptPrivateMessage, encryptPrivateMessage, type BrowserEncryptedMessage } from "../crypto/messaging.js";
import { signRelayEnvelope } from "../crypto/signing.js";
import { base64Url, base64UrlToBytes } from "./crypto.js";
import { selectRelayForRecipient } from "../transport/relay-transport.js";
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
  recipientIdentityDocument?: Pick<IdentityDocument, "delivery_relays"> | null;
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

  // Stored locally on the sender's device — the sender IS the owner of
  // this row. Account isolation depends on this owner stamp.
  const ownerCanonicalId = options.senderCanonicalId;

  // DEV ONLY: local plaintext message bodies are stored until real
  // client-side encryption lands. Encrypted backup export protects at-rest
  // backup files; browser storage still depends on this device profile.
  const message: LocalMessage = {
    message_id: messageId,
    owner_canonical_id: ownerCanonicalId,
    conversation_id: conversationId,
    direction: "sent",
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId,
    sender_handle: options.senderHandle,
    recipient_handle: options.recipientHandle,
    body: options.body,
    ciphertext,
    created_at: now,
    updated_at: now,
    status: "queued_local",
    relay_message_id: envelope.message_id
  };

  const outbound: PendingOutbound = {
    local_queue_id: crypto.randomUUID(),
    owner_canonical_id: ownerCanonicalId,
    message_id: messageId,
    recipient_canonical_id: options.recipientCanonicalId,
    status: "queued_local",
    envelope,
    created_at: now,
    updated_at: now
  };

  await saveLocalMessage(ownerCanonicalId, message);
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "message.sent.local",
    created_at: now,
    subject_id: messageId,
    data: { status: "queued_local" }
  });
  await savePendingOutbound(ownerCanonicalId, outbound);

  try {
    if (options.recipientIdentityDocument !== undefined && options.recipientIdentityDocument !== null) {
      const relaySelection = selectRelayForRecipient(options.recipientIdentityDocument);

      if (!relaySelection.ok) {
        await markFailed(ownerCanonicalId, message, outbound, "no delivery relay advertised");
        return { ok: false, message_id: messageId, error: relaySelection.error };
      }

      const portalOrigin = window.location.origin;
      const relayOrigin = new URL(relaySelection.relay.url).origin;
      const portalTransport = new URL(portalOrigin).hostname.endsWith(".onion")
        ? "onion"
        : new URL(portalOrigin).protocol === "https:"
          ? "https"
          : "local_dev";

      if (relaySelection.relay.transport === "onion" && portalTransport !== "onion") {
        await markFailed(ownerCanonicalId, message, outbound, relaySelection.warning ?? "onion transport unavailable in this browser");
        return { ok: false, message_id: messageId, error: "onion_transport_unavailable" };
      }

      if (relaySelection.relay.transport !== "onion" && relayOrigin !== portalOrigin) {
        await markFailed(ownerCanonicalId, message, outbound, relaySelection.warning ?? "relay transport requires same-origin submission");
        return { ok: false, message_id: messageId, error: "relay_cross_origin_unavailable" };
      }
    }

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
      await saveLocalMessage(ownerCanonicalId, {
        ...message,
        updated_at: updatedAt,
        status: "stored_by_relay"
      });
      await savePendingOutbound(ownerCanonicalId, {
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

    await markFailed(ownerCanonicalId, message, outbound, result.error ?? `relay rejected: ${response.status}`);
    return { ok: false, message_id: messageId, error: result.error ?? "relay_rejected" };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "relay submit failed";
    await markFailed(ownerCanonicalId, message, outbound, messageText);
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
): Promise<LocalMessage[]> {
  const response = await fetch(`/api/relay/inbox/${encodeURIComponent(recipientCanonicalId)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`relay inbox failed: ${response.status}`);

  const body = await response.json() as { envelopes?: RelayEnvelope[] };
  const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];

  const saved: LocalMessage[] = [];

  // The recipient is the local owner of every received envelope.
  const ownerCanonicalId = recipientCanonicalId;

  for (const envelope of envelopes) {
    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const plaintext = await decodeEnvelopeBody(envelope, options);
    const message: LocalMessage = {
      message_id: messageId,
      owner_canonical_id: ownerCanonicalId,
      conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
      direction: "received",
      sender_canonical_id: envelope.sender_canonical_id,
      recipient_canonical_id: envelope.recipient_canonical_id,
      sender_handle: envelope.sender_handle,
      recipient_handle: envelope.recipient_handle,
      body: plaintext,
      ciphertext: envelope.ciphertext,
      created_at: envelope.created_at,
      updated_at: now,
      status: "delivered_to_recipient_device",
      relay_message_id: envelope.message_id
    };

    try {
      await saveLocalMessage(ownerCanonicalId, message);
      saved.push(message);
    } catch (error) {
      // Don't ACK if local save failed. The relay will keep the envelope until
      // we successfully persist it on a future poll.
      const reason = error instanceof Error ? error.message : "save failed";
      await appendLocalEvent(ownerCanonicalId, {
        event_id: crypto.randomUUID(),
        type: "message.receive.failed.local",
        created_at: now,
        subject_id: messageId,
        data: { relay_message_id: envelope.message_id, reason }
      });
      continue;
    }

    await appendLocalEvent(ownerCanonicalId, {
      event_id: crypto.randomUUID(),
      type: "message.received.local",
      created_at: now,
      subject_id: messageId,
      data: { relay_message_id: envelope.message_id }
    });

    try {
      const ackResponse = await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
        method: "POST",
        headers: { accept: "application/json" }
      });
      if (ackResponse.ok) {
        await appendLocalEvent(ownerCanonicalId, {
          event_id: crypto.randomUUID(),
          type: "message.acked.local",
          created_at: new Date().toISOString(),
          subject_id: messageId,
          data: { relay_message_id: envelope.message_id }
        });
      }
    } catch {
      // Ignore ACK errors; the next poll will retry.
    }
  }

  return saved;
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

async function decodeEnvelopeBody(
  envelope: RelayEnvelope,
  options: {
    recipientAccount?: BrowserCryptoAccount | null;
    senderMessagingPublicKey?: string;
    senderMessagingKeyType?: "x25519" | "ecdh-p256";
  } = {}
): Promise<string> {
  // Real ECDH/X25519 ciphertext: try to decrypt if we have the right keys.
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
      // fall through to placeholder decode below
    }
  }

  // Dev placeholder ciphertext: ciphertext format is `dev-placeholder:<b64>`.
  // The body is recoverable until real client-side encryption replaces this
  // path. Without recovering the body the recipient never sees the message.
  if (envelope.ciphertext_scheme === "dev-placeholder" && typeof envelope.ciphertext === "string") {
    const prefix = "dev-placeholder:";
    const payload = envelope.ciphertext.startsWith(prefix)
      ? envelope.ciphertext.slice(prefix.length)
      : envelope.ciphertext;
    try {
      return decodeURIComponent(escape(atob(payload)));
    } catch {
      return "";
    }
  }

  return "";
}

async function markFailed(ownerCanonicalId: string, message: LocalMessage, outbound: PendingOutbound, error: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await saveLocalMessage(ownerCanonicalId, { ...message, updated_at: updatedAt, status: "failed" });
  await savePendingOutbound(ownerCanonicalId, { ...outbound, updated_at: updatedAt, status: "failed", last_error: error });
  await appendLocalEvent(ownerCanonicalId, {
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

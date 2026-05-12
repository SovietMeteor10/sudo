import type { IdentityDocument, RelayEnvelope } from "../../../protocol/types.js";
import { DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS } from "../../../protocol/constants.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import { decryptPrivateMessage, encryptPrivateMessage, type BrowserEncryptedMessage } from "../crypto/messaging.js";
import { signRelayEnvelope } from "../crypto/signing.js";
import { base64Url, base64UrlToBytes } from "./crypto.js";
import { selectRelayForRecipient } from "../transport/relay-transport.js";
import {
  appendLocalEvent,
  applyMessageReceipt,
  saveLocalMessage,
  savePendingOutbound
} from "./local-store.js";
import type { LocalMessage, PendingOutbound } from "./local-types.js";
import { notifyMessageUpsert } from "../sync/messageSync.js";
import {
  REACTION_CIPHERTEXT_SCHEME,
  applyIncomingReactionFromRelay,
  decodeReactionEnvelopeBody
} from "../sync/messageReactionSync.js";
import {
  ATTACHMENT_CIPHERTEXT_SCHEME,
  applyIncomingAttachmentFromRelay,
  decodeAttachmentEnvelopeBody
} from "../sync/messageAttachmentSync.js";

const SUDO_PROTOCOL_VERSION = "0.1.0";

// Ciphertext scheme tag for the cross-user delivery/read receipt
// envelope. The receipt body is JSON: { target_relay_message_id,
// delivered_at?, read_at? }. The relay treats it like any other
// envelope (server is content-agnostic); recipient routes by scheme.
export const CHAT_RECEIPT_SCHEME = "sudo_chat_receipt_v1";

type ChatReceiptBody = {
  target_relay_message_id: string;
  delivered_at?: string;
  read_at?: string;
};

function encodeChatReceiptBody(body: ChatReceiptBody): string {
  const json = JSON.stringify(body);
  return `${CHAT_RECEIPT_SCHEME}:${btoa(unescape(encodeURIComponent(json)))}`;
}

function decodeChatReceiptEnvelope(envelope: RelayEnvelope): ChatReceiptBody | null {
  if (envelope.ciphertext_scheme !== CHAT_RECEIPT_SCHEME) return null;
  if (typeof envelope.ciphertext !== "string") return null;
  const prefix = `${CHAT_RECEIPT_SCHEME}:`;
  const payload = envelope.ciphertext.startsWith(prefix)
    ? envelope.ciphertext.slice(prefix.length)
    : envelope.ciphertext;
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(escape(atob(payload))));
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const obj = decoded as Partial<ChatReceiptBody>;
  if (typeof obj.target_relay_message_id !== "string" || obj.target_relay_message_id.length === 0) return null;
  const out: ChatReceiptBody = { target_relay_message_id: obj.target_relay_message_id };
  if (typeof obj.delivered_at === "string") out.delivered_at = obj.delivered_at;
  if (typeof obj.read_at === "string") out.read_at = obj.read_at;
  return out;
}

// Best-effort fire-and-forget receipt send. Caller passes the
// peer (the original sender), the receipt body, and signs as the
// receipt-emitting account. Failure is silent — receipts are a UX
// nicety, not a delivery guarantee.
export async function sendChatReceipt(
  ownerCanonicalId: string,
  peerCanonicalId: string,
  body: ChatReceiptBody,
  options: { senderAccount?: BrowserCryptoAccount | null; senderHandle?: string; peerHandle?: string } = {}
): Promise<boolean> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  const envelope: RelayEnvelope = {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: crypto.randomUUID(),
    sender_canonical_id: ownerCanonicalId,
    recipient_canonical_id: peerCanonicalId,
    sender_handle: options.senderHandle,
    recipient_handle: options.peerHandle,
    ciphertext: encodeChatReceiptBody(body),
    ciphertext_scheme: CHAT_RECEIPT_SCHEME,
    created_at: now,
    expires_at: expiresAt,
    status: "queued_local",
    sender_signature: "dev-placeholder"
  };
  if (options.senderAccount !== undefined && options.senderAccount !== null) {
    try {
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
    } catch {
      // Sign failure → still try to POST with placeholder; relay
      // may reject signature but that's fine — receipts are best-effort.
    }
  }
  try {
    const response = await fetch("/api/relay/envelopes", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function queueAndSubmitLocalMessage(options: {
  senderCanonicalId: string;
  recipientCanonicalId: string;
  senderHandle?: string;
  recipientHandle?: string;
  body: string;
  // Phase 9: ALL three crypto inputs are now required. Send must
  // fail closed if the caller can't supply them. No more dev-
  // placeholder fallback in the send path.
  senderAccount: BrowserCryptoAccount;
  recipientMessagingPublicKey: string;
  recipientMessagingKeyType: "x25519" | "ecdh-p256";
  recipientIdentityDocument?: Pick<IdentityDocument, "delivery_relays"> | null;
  replyToMessageId?: string;
  replyToRelayMessageId?: string;
  forwarded?: boolean;
  // Attachment hint that piggybacks on this carrier message. Lives
  // INSIDE the encrypted payload so the server never sees the
  // filename / mime / size.
  attachmentSummary?: { blob_id: string; mime: string; filename: string; size_bytes: number };
}): Promise<{ ok: boolean; message_id: string; error?: string }> {
  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const conversationId = conversationIdFor(options.senderCanonicalId, options.recipientCanonicalId);
  const expiresAt = new Date(Date.parse(now) + DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS * 60 * 60 * 1000).toISOString();
  // Pack everything that used to leak through envelope top-level
  // fields into the encrypted ChatEnvelopePayload. The relay sees
  // only the opaque ciphertext below.
  const payload: ChatEnvelopePayload = {
    body: options.body,
    created_at: now,
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId
  };
  if (typeof options.replyToRelayMessageId === "string" && options.replyToRelayMessageId.length > 0) {
    payload.reply_to_relay_message_id = options.replyToRelayMessageId;
  }
  if (options.forwarded === true) payload.is_forwarded = true;
  if (options.attachmentSummary !== undefined) payload.attachment_summary = options.attachmentSummary;

  const encrypted = await createEnvelopeCiphertext({
    payload,
    senderAccount: options.senderAccount,
    recipientMessagingPublicKey: options.recipientMessagingPublicKey,
    recipientMessagingKeyType: options.recipientMessagingKeyType
  });
  const envelope: RelayEnvelope = {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: messageId,
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId,
    sender_handle: options.senderHandle,
    recipient_handle: options.recipientHandle,
    ciphertext: encrypted.ciphertext,
    ciphertext_scheme: encrypted.scheme,
    created_at: now,
    expires_at: expiresAt,
    status: "queued_local",
    sender_signature: "dev-placeholder"
  };
  // Phase 9: reply_to_relay_message_id and is_forwarded are NOT set
  // at the envelope top level anymore — they live inside the
  // encrypted payload. Server never sees them.

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
    ciphertext: envelope.ciphertext,
    created_at: now,
    updated_at: now,
    status: "queued_local",
    relay_message_id: envelope.message_id,
    reply_to_message_id: options.replyToMessageId,
    reply_to_relay_message_id: options.replyToRelayMessageId,
    forwarded: options.forwarded === true ? true : undefined
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
  // Stamp owner_canonical_id explicitly for the sync coordinator —
  // the local row already has it; this hands the same shape to the
  // sync layer without a re-read.
  void notifyMessageUpsert(ownerCanonicalId, { ...message, owner_canonical_id: ownerCanonicalId });
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
      const storedRow: LocalMessage = {
        ...message,
        owner_canonical_id: ownerCanonicalId,
        updated_at: updatedAt,
        status: "stored_by_relay"
      };
      await saveLocalMessage(ownerCanonicalId, storedRow);
      void notifyMessageUpsert(ownerCanonicalId, storedRow);
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

export type SenderMessagingKey = {
  public_key: string;
  type: "x25519" | "ecdh-p256";
};

export type SenderKeyResolver = (canonicalId: string) => Promise<SenderMessagingKey | null>;

export async function retrieveRelayInboxAfterLocalSave(
  recipientCanonicalId: string,
  options: {
    recipientAccount?: BrowserCryptoAccount | null;
    resolveSenderMessagingKey?: SenderKeyResolver;
    // Direct override for tests / single-sender flows.
    senderMessagingPublicKey?: string;
    senderMessagingKeyType?: "x25519" | "ecdh-p256";
  } = {}
): Promise<LocalMessage[]> {
  // Per-poll cache of sender-canonical → messaging key. The resolver
  // may hit the network on first lookup; cache hits keep the rest of
  // the inbox's envelopes from re-fetching the same profile.
  const senderKeyCache = new Map<string, SenderMessagingKey | null>();
  async function lookupSenderKey(canonicalId: string): Promise<SenderMessagingKey | null> {
    if (senderKeyCache.has(canonicalId)) return senderKeyCache.get(canonicalId) ?? null;
    if (typeof options.senderMessagingPublicKey === "string"
        && options.senderMessagingPublicKey.length > 0
        && options.senderMessagingKeyType !== undefined) {
      const direct: SenderMessagingKey = {
        public_key: options.senderMessagingPublicKey,
        type: options.senderMessagingKeyType
      };
      senderKeyCache.set(canonicalId, direct);
      return direct;
    }
    if (options.resolveSenderMessagingKey === undefined) {
      senderKeyCache.set(canonicalId, null);
      return null;
    }
    try {
      const resolved = await options.resolveSenderMessagingKey(canonicalId);
      senderKeyCache.set(canonicalId, resolved);
      return resolved;
    } catch {
      senderKeyCache.set(canonicalId, null);
      return null;
    }
  }
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
    // Chat-receipt envelopes carry the peer's delivered/read state
    // for one of OUR sent messages — they're metadata, not chat
    // content. Decode, apply to the matching local row, then ACK
    // and skip the message-save path.
    if (envelope.ciphertext_scheme === CHAT_RECEIPT_SCHEME) {
      try {
        const receipt = decodeChatReceiptEnvelope(envelope);
        if (receipt !== null) {
          await applyMessageReceipt(ownerCanonicalId, receipt.target_relay_message_id, {
            delivered_at: receipt.delivered_at,
            read_at: receipt.read_at
          });
        }
      } catch { /* malformed — drop, still ACK below */ }
      try {
        await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
          method: "POST",
          headers: { accept: "application/json" }
        });
      } catch { /* ACK retry on next poll */ }
      continue;
    }
    // Attachment envelopes carry encrypted media metadata + a
    // wrapped key addressed to OUR messaging key. The blob itself
    // lives at /api/media/<blob_id>; this row is the renderer's
    // entry point. Skip the message-save path — the visible chat
    // row is the SEPARATE message.upsert that the sender posted
    // alongside this envelope.
    if (envelope.ciphertext_scheme === ATTACHMENT_CIPHERTEXT_SCHEME) {
      try {
        const body = decodeAttachmentEnvelopeBody(envelope.ciphertext);
        if (body !== null) {
          await applyIncomingAttachmentFromRelay(ownerCanonicalId, {
            sender_canonical_id: envelope.sender_canonical_id,
            relay_message_id: envelope.message_id,
            body,
            created_at: envelope.created_at
          });
        }
      } catch { /* malformed — drop, still ACK below */ }
      try {
        await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
          method: "POST",
          headers: { accept: "application/json" }
        });
      } catch { /* ACK retry on next poll */ }
      continue;
    }
    // Reaction envelopes are metadata about an existing message, not
    // chat content. Decode, apply to the local reaction store, ACK,
    // and skip the message-save path.
    if (envelope.ciphertext_scheme === REACTION_CIPHERTEXT_SCHEME) {
      try {
        const body = decodeReactionEnvelopeBody(envelope.ciphertext);
        if (body !== null) {
          await applyIncomingReactionFromRelay(ownerCanonicalId, {
            owner_canonical_id: ownerCanonicalId,
            relay_message_id: body.relay_message_id,
            reactor_canonical_id: body.reactor_canonical_id,
            emoji: body.emoji,
            updated_at: body.updated_at,
            removed_at: body.removed_at
          });
        }
      } catch { /* malformed — drop, still ACK below */ }
      try {
        await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
          method: "POST",
          headers: { accept: "application/json" }
        });
      } catch { /* ACK retry on next poll */ }
      continue;
    }
    const messageId = crypto.randomUUID();
    // Resolve THIS envelope's sender key. The poll loop can carry
    // envelopes from many different senders, so we look up per-row
    // rather than passing a single sender key into the function.
    const senderKey = await lookupSenderKey(envelope.sender_canonical_id);
    const decoded = await decodeEnvelopeBody(envelope, {
      recipientAccount: options.recipientAccount ?? null,
      senderMessagingPublicKey: senderKey?.public_key,
      senderMessagingKeyType: senderKey?.type
    });
    // Phase 9: chat metadata (reply pointer, forwarded flag) lives
    // INSIDE the encrypted payload for sudo_chat_v1 envelopes. For
    // legacy schemes (real-ECDH chat / dev-placeholder) we still
    // fall back to the envelope's top-level fields. A failed
    // decrypt on a sudo_chat_v1 envelope yields body="" with the
    // "could not be decrypted" placeholder that the renderer paints.
    const renderBody = decoded.decryption_ok
      ? decoded.body
      : (envelope.ciphertext_scheme === SUDO_CHAT_CIPHERTEXT_SCHEME
          ? "[message could not be decrypted]"
          : "");
    const replyTo = decoded.reply_to_relay_message_id
      ?? (typeof envelope.reply_to_relay_message_id === "string" ? envelope.reply_to_relay_message_id : undefined);
    const forwarded = decoded.is_forwarded === true
      ? true
      : (envelope.is_forwarded === true ? true : undefined);
    const message: LocalMessage = {
      message_id: messageId,
      owner_canonical_id: ownerCanonicalId,
      conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
      direction: "received",
      sender_canonical_id: envelope.sender_canonical_id,
      recipient_canonical_id: envelope.recipient_canonical_id,
      sender_handle: envelope.sender_handle,
      recipient_handle: envelope.recipient_handle,
      body: renderBody,
      ciphertext: envelope.ciphertext,
      created_at: envelope.created_at,
      updated_at: now,
      status: "delivered_to_recipient_device",
      relay_message_id: envelope.message_id,
      reply_to_relay_message_id: replyTo,
      forwarded
    };

    try {
      await saveLocalMessage(ownerCanonicalId, message);
      void notifyMessageUpsert(ownerCanonicalId, message);
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

    // Emit a cross-user "delivered" receipt back to the original
    // sender. Fire-and-forget — UI tick is a nicety; if the receipt
    // fails to land the message still arrived correctly, the
    // sender simply won't see the double-tick flip.
    void sendChatReceipt(
      ownerCanonicalId,
      envelope.sender_canonical_id,
      {
        target_relay_message_id: envelope.message_id,
        delivered_at: new Date().toISOString()
      },
      {
        senderAccount: options.recipientAccount ?? null,
        senderHandle: envelope.recipient_handle,
        peerHandle: envelope.sender_handle
      }
    );
  }

  return saved;
}

export const SUDO_CHAT_CIPHERTEXT_SCHEME = "sudo_chat_v1";

// What's encrypted inside a sudo_chat_v1 envelope. Everything that
// would have leaked to the relay as a plaintext top-level field
// (reply pointer, forwarded flag, body, attachment hint) now lives
// here. The server sees only the opaque ciphertext + the routing
// metadata it absolutely needs to deliver the envelope.
export type ChatEnvelopePayload = {
  body: string;
  reply_to_relay_message_id?: string;
  is_forwarded?: boolean;
  attachment_summary?: { blob_id: string; mime: string; filename: string; size_bytes: number };
  created_at: string;
  sender_canonical_id: string;
  recipient_canonical_id: string;
};

// Decode result. The caller (receiver-side inbox processor) uses
// this to repopulate metadata that used to come from envelope top-
// level fields. For sudo_chat_v1, every field below is canonical
// from the encrypted body; for dev-placeholder we get body only
// and the top-level envelope fields are the only source.
export type DecodedEnvelope = {
  body: string;
  reply_to_relay_message_id?: string;
  is_forwarded?: boolean;
  attachment_summary?: ChatEnvelopePayload["attachment_summary"];
  // True iff the decoder successfully recovered plaintext.
  decryption_ok: boolean;
};

// Sender path. Builds the envelope ciphertext. Throws if the
// recipient's messaging key isn't available — Phase 9 explicitly
// removes the dev-placeholder fallback for new sends, so the
// caller must fail closed (and we do mean closed: no
// fallback-to-base64 to keep the wire "alive").
async function createEnvelopeCiphertext(options: {
  payload: ChatEnvelopePayload;
  senderAccount: BrowserCryptoAccount;
  recipientMessagingPublicKey: string;
  recipientMessagingKeyType: "x25519" | "ecdh-p256";
}): Promise<{ ciphertext: string; scheme: string }> {
  const plaintext = JSON.stringify(options.payload);
  const encrypted = await encryptPrivateMessage({
    plaintext,
    senderPrivateMessagingKey: options.senderAccount.messaging_key,
    senderMessagingKeyType: options.senderAccount.messaging_key_type,
    recipientMessagingPublicKey: options.recipientMessagingPublicKey,
    recipientMessagingKeyType: options.recipientMessagingKeyType
  });
  // The relay envelope's ciphertext field carries the entire
  // BrowserEncryptedMessage JSON, base64-wrapped. The inner
  // .scheme tells the decoder which ECDH curve to use; the OUTER
  // scheme field is the higher-level semantic version
  // ("sudo_chat_v1") so future payload-shape changes don't have
  // to share a tag with the crypto primitive.
  const wrapped = base64Url(new TextEncoder().encode(JSON.stringify(encrypted)));
  return { ciphertext: wrapped, scheme: SUDO_CHAT_CIPHERTEXT_SCHEME };
}

// Receiver path. Returns body + any metadata that was inside the
// encrypted payload (sudo_chat_v1) OR, for legacy envelopes, what
// it can pull out of the envelope's top-level fields.
//
// Order of recognition:
//   1. sudo_chat_v1: decrypt as BrowserEncryptedMessage, parse as
//      ChatEnvelopePayload JSON.
//   2. legacy x25519-aes-gcm-v1 / ecdh-p256-aes-gcm-v1: decrypt
//      body string only; metadata still on envelope top-level.
//   3. dev-placeholder: base64-decode body; metadata on envelope
//      top-level.
//   4. Anything else: decryption_ok=false, body="" so the
//      renderer can show "message could not be decrypted".
async function decodeEnvelopeBody(
  envelope: RelayEnvelope,
  options: {
    recipientAccount?: BrowserCryptoAccount | null;
    senderMessagingPublicKey?: string;
    senderMessagingKeyType?: "x25519" | "ecdh-p256";
  } = {}
): Promise<DecodedEnvelope> {
  // sudo_chat_v1: encrypted JSON ChatEnvelopePayload.
  if (envelope.ciphertext_scheme === SUDO_CHAT_CIPHERTEXT_SCHEME
      && options.recipientAccount !== undefined
      && options.recipientAccount !== null
      && options.senderMessagingPublicKey !== undefined
      && options.senderMessagingKeyType !== undefined) {
    try {
      const packed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(envelope.ciphertext))) as BrowserEncryptedMessage;
      const plaintext = await decryptPrivateMessage({
        encrypted: packed,
        recipientPrivateMessagingKey: options.recipientAccount.messaging_key,
        senderMessagingPublicKey: options.senderMessagingPublicKey,
        senderMessagingKeyType: options.senderMessagingKeyType
      });
      const payload = JSON.parse(plaintext) as Partial<ChatEnvelopePayload>;
      const out: DecodedEnvelope = {
        body: typeof payload.body === "string" ? payload.body : "",
        decryption_ok: true
      };
      if (typeof payload.reply_to_relay_message_id === "string" && payload.reply_to_relay_message_id.length > 0) {
        out.reply_to_relay_message_id = payload.reply_to_relay_message_id;
      }
      if (payload.is_forwarded === true) out.is_forwarded = true;
      if (payload.attachment_summary !== undefined && payload.attachment_summary !== null) {
        out.attachment_summary = payload.attachment_summary;
      }
      return out;
    } catch {
      // Decrypt or parse failed — render the "could not decrypt"
      // placeholder downstream. We deliberately don't fall through
      // to placeholder decode below because a sudo_chat_v1 envelope
      // that we can't decrypt is a real failure, not a legacy row.
      return { body: "", decryption_ok: false };
    }
  }
  // Legacy real-ECDH chat (pre-Phase-9): body string only, metadata
  // on the envelope top-level. We keep this branch for messages
  // still queued at the relay from older client builds.
  if ((envelope.ciphertext_scheme === "x25519-aes-gcm-v1"
       || envelope.ciphertext_scheme === "ecdh-p256-aes-gcm-v1")
      && options.recipientAccount !== undefined
      && options.recipientAccount !== null
      && options.senderMessagingPublicKey !== undefined
      && options.senderMessagingKeyType !== undefined) {
    try {
      const packed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(envelope.ciphertext))) as BrowserEncryptedMessage;
      const body = await decryptPrivateMessage({
        encrypted: packed,
        recipientPrivateMessagingKey: options.recipientAccount.messaging_key,
        senderMessagingPublicKey: options.senderMessagingPublicKey,
        senderMessagingKeyType: options.senderMessagingKeyType
      });
      return { body, decryption_ok: true };
    } catch {
      return { body: "", decryption_ok: false };
    }
  }
  // dev-placeholder: legacy plaintext-on-wire. Retained as a
  // compatibility read so older messages already queued at the
  // relay still surface on the receiver side. New sends never
  // use this scheme (Phase 9 cut it).
  if (envelope.ciphertext_scheme === "dev-placeholder" && typeof envelope.ciphertext === "string") {
    const prefix = "dev-placeholder:";
    const payload = envelope.ciphertext.startsWith(prefix)
      ? envelope.ciphertext.slice(prefix.length)
      : envelope.ciphertext;
    try {
      return { body: decodeURIComponent(escape(atob(payload))), decryption_ok: true };
    } catch {
      return { body: "", decryption_ok: false };
    }
  }
  return { body: "", decryption_ok: false };
}

async function markFailed(ownerCanonicalId: string, message: LocalMessage, outbound: PendingOutbound, error: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  const failedRow: LocalMessage = {
    ...message,
    owner_canonical_id: ownerCanonicalId,
    updated_at: updatedAt,
    status: "failed"
  };
  await saveLocalMessage(ownerCanonicalId, failedRow);
  void notifyMessageUpsert(ownerCanonicalId, failedRow);
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

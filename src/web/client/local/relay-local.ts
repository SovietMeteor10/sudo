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
  deletePendingDecrypt,
  deletePendingOutboundByQueueId,
  getLocalMessage as loadLocalMessageById,
  listPendingDecrypt,
  listPendingOutbound,
  saveLocalMessage,
  savePendingDecrypt,
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
    updated_at: now,
    attempts: 0
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

  // Phase 10.1: pre-flight offline check. If the browser is offline
  // we DON'T try the POST — we just leave the row queued so the
  // drainer picks it up on the next 'online' event. The composer
  // returns ok so the caller's UI clears the textarea.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: true, message_id: messageId };
  }

  const submitResult = await submitPendingOutbound(ownerCanonicalId, outbound, {
    recipientIdentityDocument: options.recipientIdentityDocument ?? null
  });
  return {
    ok: submitResult.outcome === "ok",
    message_id: messageId,
    error: submitResult.outcome === "ok" ? undefined : submitResult.error
  };
}

// Phase 10.1: drain step. Tries one relay POST for a single pending
// row. Classifies the outcome as:
//   - ok       — relay accepted (or 200/duplicate). Row + message
//                advance to "stored_by_relay".
//   - transient — network blip / 5xx / offline. Row stays "queued_local",
//                attempts++, next_retry_at scheduled with exponential
//                backoff. UI shows "retrying" if attempts > 0.
//   - fatal    — relay rejected with a non-recoverable error
//                (invalid_envelope, expired, …). Row + message flip
//                to "failed"; UI exposes retry/cancel.
export async function submitPendingOutbound(
  ownerCanonicalId: string,
  outbound: PendingOutbound,
  options: { recipientIdentityDocument?: Pick<IdentityDocument, "delivery_relays"> | null } = {}
): Promise<
  | { outcome: "ok" }
  | { outcome: "transient"; error: string; attempts: number; next_retry_at: string }
  | { outcome: "fatal"; error: string }
> {
  const envelope = outbound.envelope;
  const messageId = outbound.message_id;
  // Re-hydrate the local message row so we can write tombstone-safe
  // status updates (a tombstone may have landed between queue + send).
  const messageRecord = await loadLocalMessageById(messageId);
  if (messageRecord === null) {
    // Message was deleted while queued — drop the row, don't retry.
    await deletePendingOutboundByQueueId(outbound.local_queue_id);
    return { outcome: "fatal", error: "message_gone" };
  }

  try {
    if (options.recipientIdentityDocument !== undefined && options.recipientIdentityDocument !== null) {
      const relaySelection = selectRelayForRecipient(options.recipientIdentityDocument);

      if (!relaySelection.ok) {
        await markFailed(ownerCanonicalId, messageRecord, outbound, "no delivery relay advertised");
        return { outcome: "fatal", error: relaySelection.error };
      }

      const portalOrigin = window.location.origin;
      const relayOrigin = new URL(relaySelection.relay.url).origin;
      const portalTransport = new URL(portalOrigin).hostname.endsWith(".onion")
        ? "onion"
        : new URL(portalOrigin).protocol === "https:"
          ? "https"
          : "local_dev";

      if (relaySelection.relay.transport === "onion" && portalTransport !== "onion") {
        await markFailed(ownerCanonicalId, messageRecord, outbound, relaySelection.warning ?? "onion transport unavailable in this browser");
        return { outcome: "fatal", error: "onion_transport_unavailable" };
      }

      if (relaySelection.relay.transport !== "onion" && relayOrigin !== portalOrigin) {
        await markFailed(ownerCanonicalId, messageRecord, outbound, relaySelection.warning ?? "relay transport requires same-origin submission");
        return { outcome: "fatal", error: "relay_cross_origin_unavailable" };
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
    const result = await response.json().catch(() => ({})) as { ok?: boolean; status?: string; error?: string; expires_at?: string };
    const updatedAt = new Date().toISOString();

    if (response.ok && result.ok === true) {
      const storedRow: LocalMessage = {
        ...messageRecord,
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
      return { outcome: "ok" };
    }

    // The relay's `duplicate_message` reply is idempotent — we
    // already delivered this row, so treat as success.
    if (response.ok && result.error === "duplicate_message") {
      const storedRow: LocalMessage = {
        ...messageRecord,
        owner_canonical_id: ownerCanonicalId,
        updated_at: updatedAt,
        status: "stored_by_relay"
      };
      await saveLocalMessage(ownerCanonicalId, storedRow);
      void notifyMessageUpsert(ownerCanonicalId, storedRow);
      await savePendingOutbound(ownerCanonicalId, {
        ...outbound,
        updated_at: updatedAt,
        status: "stored_by_relay"
      });
      return { outcome: "ok" };
    }

    const errorString = result.error ?? `relay rejected: ${response.status}`;
    if (isTransientRelayFailure(response.status, result.error)) {
      const attempts = (outbound.attempts ?? 0) + 1;
      const next_retry_at = new Date(Date.now() + backoffDelayMs(attempts)).toISOString();
      await savePendingOutbound(ownerCanonicalId, {
        ...outbound,
        updated_at: updatedAt,
        status: "queued_local",
        last_error: errorString,
        attempts,
        next_retry_at
      });
      // Bump the message row updated_at so renderers re-paint with
      // the new "retrying" state.
      const retryingRow: LocalMessage = { ...messageRecord, updated_at: updatedAt, status: "queued_local" };
      await saveLocalMessage(ownerCanonicalId, retryingRow);
      void notifyMessageUpsert(ownerCanonicalId, retryingRow);
      return { outcome: "transient", error: errorString, attempts, next_retry_at };
    }
    await markFailed(ownerCanonicalId, messageRecord, outbound, errorString);
    return { outcome: "fatal", error: errorString };
  } catch (error) {
    // Network exception — always transient.
    const errorString = error instanceof Error ? error.message : "relay submit failed";
    const updatedAt = new Date().toISOString();
    const attempts = (outbound.attempts ?? 0) + 1;
    const next_retry_at = new Date(Date.now() + backoffDelayMs(attempts)).toISOString();
    await savePendingOutbound(ownerCanonicalId, {
      ...outbound,
      updated_at: updatedAt,
      status: "queued_local",
      last_error: errorString,
      attempts,
      next_retry_at
    });
    const retryingRow: LocalMessage = { ...messageRecord, updated_at: updatedAt, status: "queued_local" };
    await saveLocalMessage(ownerCanonicalId, retryingRow);
    void notifyMessageUpsert(ownerCanonicalId, retryingRow);
    return { outcome: "transient", error: errorString, attempts, next_retry_at };
  }
}

// Phase 11.6: deferred-decrypt drainer. Iterates every pending row
// for this owner, runs decodeEnvelopeBody with the now-unlocked
// account, and writes the real LocalMessage in place. Failures get
// ONE sender-key refetch + retry; if that still fails, the row is
// flagged with a structured fail_reason and surfaced as a permanent
// placeholder.
//
// Called from main.ts on:
//   - unlock dialog success
//   - app boot AFTER currentCryptoAccount is set
//   - inbox poll, when the account is unlocked (drains anything that
//     was stashed during a previous locked window)
export async function drainPendingDecrypt(
  ownerCanonicalId: string,
  options: {
    recipientAccount: BrowserCryptoAccount;
    resolveSenderMessagingKey?: SenderKeyResolver;
  }
): Promise<{ tried: number; decrypted: number; deferred: number; failed: number }> {
  const rows = await listPendingDecrypt(ownerCanonicalId);
  const result = { tried: 0, decrypted: 0, deferred: 0, failed: 0 };
  // Cache the sender-key lookup per-drain.
  const cache = new Map<string, SenderMessagingKey | null>();
  async function senderKey(canonical: string, forceRefetch: boolean): Promise<SenderMessagingKey | null> {
    if (!forceRefetch && cache.has(canonical)) return cache.get(canonical) ?? null;
    if (options.resolveSenderMessagingKey === undefined) {
      cache.set(canonical, null);
      return null;
    }
    try {
      const k = await options.resolveSenderMessagingKey(canonical);
      cache.set(canonical, k);
      return k;
    } catch {
      cache.set(canonical, null);
      return null;
    }
  }
  for (const row of rows) {
    result.tried++;
    let envelope: RelayEnvelope;
    try {
      envelope = JSON.parse(row.envelope_json) as RelayEnvelope;
    } catch {
      // Corrupted row JSON — drop it, render permanent failure.
      await persistDecryptedRow(ownerCanonicalId, row, null, "malformed");
      await deletePendingDecrypt(row.local_id);
      result.failed++;
      continue;
    }
    // First decrypt attempt with cached sender key.
    let key = await senderKey(envelope.sender_canonical_id, false);
    let decoded = await decodeEnvelopeBody(envelope, {
      recipientAccount: options.recipientAccount,
      senderMessagingPublicKey: key?.public_key,
      senderMessagingKeyType: key?.type
    });
    // Second attempt: refetch the sender's profile from the relay
    // in case our cached messaging key is stale (sender rotated
    // / fresh deployment / relinked device).
    if (!decoded.decryption_ok) {
      const refreshed = await senderKey(envelope.sender_canonical_id, true);
      if (refreshed !== null && (key === null || refreshed.public_key !== key.public_key)) {
        key = refreshed;
        decoded = await decodeEnvelopeBody(envelope, {
          recipientAccount: options.recipientAccount,
          senderMessagingPublicKey: key.public_key,
          senderMessagingKeyType: key.type
        });
      }
    }
    if (decoded.decryption_ok) {
      await persistDecryptedRow(ownerCanonicalId, row, envelope, null, decoded);
      await deletePendingDecrypt(row.local_id);
      result.decrypted++;
      continue;
    }
    // Decrypt still failed after one refresh — classify the failure
    // and either defer (transient) or permanent-fail.
    const attempts = (row.retry_attempts ?? 0) + 1;
    if (attempts < 3) {
      await savePendingDecrypt({ ...row, retry_attempts: attempts });
      result.deferred++;
    } else {
      const failReason = key === null ? "sender_missing" : "auth_failed";
      await persistDecryptedRow(ownerCanonicalId, row, envelope, failReason);
      await deletePendingDecrypt(row.local_id);
      result.failed++;
    }
  }
  return result;
}

// Helper: write the final LocalMessage row after a pending_decrypt
// row is resolved (either successfully decrypted or permanently
// failed). Decoded body / metadata is filled in on success; failure
// rows get a structured fail_reason that the renderer maps to copy.
async function persistDecryptedRow(
  ownerCanonicalId: string,
  pending: { relay_message_id: string; sender_canonical_id: string; conversation_id: string; received_at: string; envelope_json: string },
  envelope: RelayEnvelope | null,
  failReason: "wrong_key" | "malformed" | "unsupported_scheme" | "sender_missing" | "auth_failed" | null,
  decoded?: DecodedEnvelope
): Promise<void> {
  const now = new Date().toISOString();
  let envOrNull = envelope;
  if (envOrNull === null) {
    try { envOrNull = JSON.parse(pending.envelope_json) as RelayEnvelope; }
    catch { envOrNull = null; }
  }
  const messageId = crypto.randomUUID();
  const renderBody = decoded?.decryption_ok === true
    ? decoded.body
    : "[message could not be decrypted]";
  const message: LocalMessage = {
    message_id: messageId,
    owner_canonical_id: ownerCanonicalId,
    conversation_id: pending.conversation_id,
    direction: "received",
    sender_canonical_id: pending.sender_canonical_id,
    recipient_canonical_id: ownerCanonicalId,
    sender_handle: envOrNull?.sender_handle,
    recipient_handle: envOrNull?.recipient_handle,
    body: renderBody,
    ciphertext: envOrNull?.ciphertext,
    created_at: envOrNull?.created_at ?? pending.received_at,
    updated_at: now,
    status: "delivered_to_recipient_device",
    relay_message_id: pending.relay_message_id
  };
  if (decoded?.decryption_ok === true) {
    if (typeof decoded.reply_to_relay_message_id === "string") message.reply_to_relay_message_id = decoded.reply_to_relay_message_id;
    if (decoded.is_forwarded === true) message.forwarded = true;
  }
  await saveLocalMessage(ownerCanonicalId, message);
  void notifyMessageUpsert(ownerCanonicalId, message);
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: decoded?.decryption_ok === true ? "message.received.local" : "message.receive.failed.local",
    created_at: now,
    subject_id: messageId,
    data: failReason !== null ? { relay_message_id: pending.relay_message_id, fail_reason: failReason } : { relay_message_id: pending.relay_message_id }
  });
}

// Drain step. Iterates the owner's pending_outbound rows and tries
// to submit any that are queued AND past their next_retry_at gate.
// Idempotent — safe to call from multiple triggers (online event,
// visibilitychange, manual retry click, boot drain).
export async function drainPendingOutbound(ownerCanonicalId: string): Promise<{ tried: number; ok: number; transient: number; fatal: number }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { tried: 0, ok: 0, transient: 0, fatal: 0 };
  }
  const all = await listPendingOutbound(ownerCanonicalId);
  const due = all.filter((row) => {
    if (row.status !== "queued_local") return false;
    if (typeof row.next_retry_at !== "string") return true;
    return Date.parse(row.next_retry_at) <= Date.now();
  });
  let tried = 0, ok = 0, transient = 0, fatal = 0;
  for (const row of due) {
    tried++;
    const result = await submitPendingOutbound(ownerCanonicalId, row);
    if (result.outcome === "ok") ok++;
    else if (result.outcome === "transient") transient++;
    else fatal++;
  }
  return { tried, ok, transient, fatal };
}

// Manual retry button handler. Resets the row to attempts=0 so the
// drainer treats it as a fresh send rather than a back-off victim.
export async function retryFailedOutbound(ownerCanonicalId: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
  const all = await listPendingOutbound(ownerCanonicalId);
  const row = all.find((r) => r.message_id === messageId);
  if (row === undefined) return { ok: false, error: "no_pending_row" };
  const updatedAt = new Date().toISOString();
  const reset: PendingOutbound = {
    ...row,
    status: "queued_local",
    updated_at: updatedAt,
    attempts: 0,
    next_retry_at: undefined,
    last_error: undefined
  };
  await savePendingOutbound(ownerCanonicalId, reset);
  // Also flip the message row back to queued_local so the UI clears
  // the "failed" state pending the drain attempt.
  const msg = await loadLocalMessageById(messageId);
  if (msg !== null) {
    const queuedRow: LocalMessage = { ...msg, updated_at: updatedAt, status: "queued_local" };
    await saveLocalMessage(ownerCanonicalId, queuedRow);
    void notifyMessageUpsert(ownerCanonicalId, queuedRow);
  }
  const result = await submitPendingOutbound(ownerCanonicalId, reset);
  return { ok: result.outcome === "ok", error: result.outcome === "ok" ? undefined : result.error };
}

// Cancel a stuck send. The pending row is deleted and the message
// row is tombstoned locally so the chat history reflects the cancel
// rather than leaving a phantom "failed" row.
export async function cancelFailedOutbound(ownerCanonicalId: string, messageId: string): Promise<{ ok: boolean }> {
  const all = await listPendingOutbound(ownerCanonicalId);
  const row = all.find((r) => r.message_id === messageId);
  if (row !== undefined) await deletePendingOutboundByQueueId(row.local_queue_id);
  const msg = await loadLocalMessageById(messageId);
  if (msg !== null) {
    const updatedAt = new Date().toISOString();
    const cancelled: LocalMessage = {
      ...msg,
      updated_at: updatedAt,
      status: "rejected",
      deleted_at: updatedAt,
      body: ""
    };
    await saveLocalMessage(ownerCanonicalId, cancelled);
    void notifyMessageUpsert(ownerCanonicalId, cancelled);
  }
  return { ok: true };
}

// Backoff schedule. Capped at ~60s so even a wedged network resumes
// within a minute once it recovers. The drainer is also triggered
// by 'online' / visibilitychange events so the backoff is mostly a
// fairness/rate-limit ceiling, not a user-perceived wait.
function backoffDelayMs(attempts: number): number {
  const ladder = [1_000, 3_000, 8_000, 20_000, 60_000];
  return ladder[Math.min(attempts - 1, ladder.length - 1)] ?? 60_000;
}

// Errors the relay returns that we should NOT retry. 4xx-ish
// validation failures are terminal; 5xx-ish + duplicates + parse
// failures + 429 are transient.
function isTransientRelayFailure(status: number, errorCode: string | undefined): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  // Specific error codes we know are non-recoverable. Anything not
  // listed here defaults to transient — better to retry on an
  // unknown error than to silently swallow a legitimate send.
  const fatalCodes = new Set([
    "invalid_envelope",
    "expired",
    "tier_blocked",
    "rate_limited", // surfaced as fatal so the user sees it; the
                    // drainer doesn't auto-retry abusive sends
    "onion_transport_unavailable",
    "relay_cross_origin_unavailable"
  ]);
  if (errorCode !== undefined && fatalCodes.has(errorCode)) return false;
  return true;
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
    // Phase 11.6: deferred-decrypt. If this is a chat envelope we
    // can't decrypt right now (locked: account in IDB but not
    // unlocked in memory), stash the ciphertext in pending_decrypt
    // and ack the server. drainPendingDecrypt() picks it up after
    // unlock and writes the real chat row. We DO NOT save a
    // permanent "could not be decrypted" placeholder anymore — that
    // was the Phase 11.5 regression bug.
    const isChatScheme = envelope.ciphertext_scheme === SUDO_CHAT_CIPHERTEXT_SCHEME
      || envelope.ciphertext_scheme === "x25519-aes-gcm-v1"
      || envelope.ciphertext_scheme === "ecdh-p256-aes-gcm-v1";
    if (isChatScheme && (options.recipientAccount === undefined || options.recipientAccount === null)) {
      try {
        await savePendingDecrypt({
          local_id: crypto.randomUUID(),
          owner_canonical_id: ownerCanonicalId,
          relay_message_id: envelope.message_id,
          envelope_json: JSON.stringify(envelope),
          sender_canonical_id: envelope.sender_canonical_id,
          conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
          received_at: now
        });
      } catch (error) {
        // If the IDB write fails, leave the envelope at the server
        // (don't ack) so the next poll tries again. The local row
        // is the source of truth — better to retry than to lose.
        await appendLocalEvent(ownerCanonicalId, {
          event_id: crypto.randomUUID(),
          type: "message.receive.failed.local",
          created_at: now,
          subject_id: messageId,
          data: { relay_message_id: envelope.message_id, reason: "pending_decrypt_save_failed", message: error instanceof Error ? error.message : "unknown" }
        });
        continue;
      }
      // Ack the server — we have the ciphertext locally now.
      try {
        await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
          method: "POST",
          headers: { accept: "application/json" }
        });
      } catch { /* ACK retry on next poll */ }
      // Broadcast the chat-list refresh so the conversation surfaces
      // a "unlock to read N messages" affordance even before decrypt.
      void notifyMessageUpsert(ownerCanonicalId, {
        message_id: messageId,
        owner_canonical_id: ownerCanonicalId,
        conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
        direction: "received",
        sender_canonical_id: envelope.sender_canonical_id,
        recipient_canonical_id: envelope.recipient_canonical_id,
        sender_handle: envelope.sender_handle,
        recipient_handle: envelope.recipient_handle,
        body: "",
        created_at: envelope.created_at,
        updated_at: now,
        status: "delivered_to_recipient_device",
        relay_message_id: envelope.message_id
      });
      continue;
    }
    // Resolve THIS envelope's sender key. The poll loop can carry
    // envelopes from many different senders, so we look up per-row
    // rather than passing a single sender key into the function.
    const senderKey = await lookupSenderKey(envelope.sender_canonical_id);
    const decoded = await decodeEnvelopeBody(envelope, {
      recipientAccount: options.recipientAccount ?? null,
      senderMessagingPublicKey: senderKey?.public_key,
      senderMessagingKeyType: senderKey?.type
    });
    // Phase 11.6: when decrypt fails on an unlocked account, only
    // defer-and-retry if the sender key was MISSING (i.e. we
    // couldn't fetch it just now). If the sender key WAS present
    // and decrypt still failed, the ciphertext is the problem —
    // render the permanent placeholder here so the user sees
    // "couldn't decrypt" instead of a silent hang. The
    // encrypted-chat-envelope smoke's malformed-envelope path
    // depends on this distinction.
    const senderKeyMissing = senderKey === null || senderKey === undefined;
    if (isChatScheme && !decoded.decryption_ok && options.recipientAccount !== undefined && options.recipientAccount !== null && senderKeyMissing) {
      try {
        await savePendingDecrypt({
          local_id: crypto.randomUUID(),
          owner_canonical_id: ownerCanonicalId,
          relay_message_id: envelope.message_id,
          envelope_json: JSON.stringify(envelope),
          sender_canonical_id: envelope.sender_canonical_id,
          conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
          received_at: now,
          retry_attempts: 0
        });
      } catch { /* fall through to placeholder below */ }
      try {
        await fetch(`/api/relay/envelopes/${encodeURIComponent(envelope.message_id)}/ack`, {
          method: "POST",
          headers: { accept: "application/json" }
        });
      } catch { /* ACK retry on next poll */ }
      continue;
    }
    // Phase 11.6: chat metadata (reply pointer, forwarded flag) lives
    // INSIDE the encrypted payload for sudo_chat_v1 envelopes. For
    // legacy schemes (real-ECDH chat / dev-placeholder) we still
    // fall back to the envelope's top-level fields. A failed decrypt
    // here means the account WAS unlocked but the body was unreadable
    // even after a sender-key retry — that's a TRUE permanent failure,
    // and we render the placeholder.
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

import type { RelayEnvelope } from "../../../protocol/types.js";
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
}): Promise<{ ok: boolean; message_id: string; error?: string }> {
  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const conversationId = conversationIdFor(options.senderCanonicalId, options.recipientCanonicalId);
  const ciphertext = `dev-placeholder:${btoa(unescape(encodeURIComponent(options.body)))}`;
  const envelope: RelayEnvelope = {
    type: "sudo_relay_envelope",
    protocol_version: SUDO_PROTOCOL_VERSION,
    message_id: crypto.randomUUID(),
    sender_canonical_id: options.senderCanonicalId,
    recipient_canonical_id: options.recipientCanonicalId,
    sender_handle: options.senderHandle,
    recipient_handle: options.recipientHandle,
    ciphertext,
    ciphertext_scheme: "dev-placeholder",
    created_at: now,
    expires_at: "",
    status: "queued_local",
    sender_signature: "dev-placeholder"
  };

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

export async function retrieveRelayInboxAfterLocalSave(recipientCanonicalId: string): Promise<number> {
  const response = await fetch(`/api/relay/inbox/${encodeURIComponent(recipientCanonicalId)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`relay inbox failed: ${response.status}`);

  const body = await response.json() as { envelopes?: RelayEnvelope[] };
  const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];

  for (const envelope of envelopes) {
    const now = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const message: LocalMessage = {
      message_id: messageId,
      conversation_id: conversationIdFor(envelope.sender_canonical_id, envelope.recipient_canonical_id),
      direction: "received",
      sender_canonical_id: envelope.sender_canonical_id,
      recipient_canonical_id: envelope.recipient_canonical_id,
      body: "",
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

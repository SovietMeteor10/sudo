// Message-history slice of trusted-device sync. Plugs into the shared
// poller registered in contactSync.ts. The protocol shape mirrors the
// other slices but the projection rule is monotonic-by-updated_at
// because messages move through several local statuses
// (queued_local → stored_by_relay → ...). Older replays must not
// clobber newer state.
//
// We deliberately do NOT sync drafts, settings, or read-receipts in
// this slice. Message deletion is modeled by `message.delete`, which
// writes a tombstone locally (deleted_at set, body/ciphertext blanked)
// and broadcasts a payload that carries only the message_id +
// deleted_at — no plaintext body ever leaves the device once the user
// deletes the message.

import {
  activeAccount,
  buildAndPostSyncEvent,
  registerSliceProjector
} from "./coordinator.js";
import {
  getLocalMessage,
  projectIncomingMessage,
  tombstoneLocalMessage
} from "../local/local-store.js";
import type { LocalMessage } from "../local/local-types.js";
import type { RelayEnvelopeStatus } from "../../../protocol/types.js";

// Best-effort broadcast of a freshly-saved local message. Callers
// that mutate the messages store (sent and received paths in
// relay-local.ts) invoke this AFTER their durable saveLocalMessage
// returns. Failure here must never roll back the local save.
// Returns true on a successful POST, false otherwise; fire-and-forget
// callers (relay-local.ts) ignore the return, but the initial-state
// backfill checks it so a transient outage marks the slice partial.
export async function notifyMessageUpsert(
  ownerCanonicalId: string,
  message: LocalMessage
): Promise<boolean> {
  // A tombstoned row never broadcasts as an upsert — only as a
  // delete, via notifyMessageDelete. This is what keeps body
  // plaintext off the wire after the user pressed delete.
  if (typeof message.deleted_at === "string") return false;
  const payload = serializeMessageForSync(message);
  if (payload === null) return false;
  if (payload.owner_canonical_id !== ownerCanonicalId) return false;
  return buildAndPostSyncEvent("message", "message.upsert", payload);
}

// User-driven delete path. Writes the local tombstone, then publishes
// `message.delete` so every linked device converges. The payload is
// deliberately minimal: message_id + deleted_at + conversation_id
// (for ordering). No body, no ciphertext, no sender/recipient handle.
export async function applyMessageDeleteWithBroadcast(
  ownerCanonicalId: string,
  messageId: string
): Promise<{ tombstoned: boolean; broadcast: boolean }> {
  const existing = await getLocalMessage(messageId);
  if (existing !== null && existing.owner_canonical_id !== ownerCanonicalId) {
    return { tombstoned: false, broadcast: false };
  }
  const deletedAt = new Date().toISOString();
  const result = await tombstoneLocalMessage(ownerCanonicalId, {
    message_id: messageId,
    conversation_id: existing?.conversation_id,
    sender_canonical_id: existing?.sender_canonical_id,
    recipient_canonical_id: existing?.recipient_canonical_id,
    created_at: existing?.created_at,
    deleted_at: deletedAt
  });
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) {
    return { tombstoned: result.written, broadcast: false };
  }
  const payload: MessageDeletePayload = {
    message_id: messageId,
    owner_canonical_id: ownerCanonicalId,
    deleted_at: deletedAt
  };
  if (typeof existing?.conversation_id === "string" && existing.conversation_id.length > 0) {
    payload.conversation_id = existing.conversation_id;
  }
  const broadcast = await buildAndPostSyncEvent("message", "message.delete", payload);
  return { tombstoned: result.written, broadcast };
}

type MessageSyncPayload = {
  message_id: string;
  owner_canonical_id: string;
  conversation_id: string;
  direction: "sent" | "received";
  sender_canonical_id: string;
  recipient_canonical_id: string;
  sender_handle?: string;
  recipient_handle?: string;
  body?: string;
  ciphertext?: string;
  created_at: string;
  updated_at: string;
  status: string;
  relay_message_id?: string;
};

type MessageDeletePayload = {
  message_id: string;
  owner_canonical_id: string;
  deleted_at: string;
  conversation_id?: string;
};

function serializeMessageForSync(message: LocalMessage): MessageSyncPayload | null {
  if (typeof message.message_id !== "string" || message.message_id.length === 0) return null;
  const payload: MessageSyncPayload = {
    message_id: message.message_id,
    owner_canonical_id: message.owner_canonical_id,
    conversation_id: message.conversation_id,
    direction: message.direction,
    sender_canonical_id: message.sender_canonical_id,
    recipient_canonical_id: message.recipient_canonical_id,
    created_at: message.created_at,
    updated_at: message.updated_at,
    status: message.status
  };
  if (typeof message.sender_handle === "string") payload.sender_handle = message.sender_handle;
  if (typeof message.recipient_handle === "string") payload.recipient_handle = message.recipient_handle;
  if (typeof message.body === "string") payload.body = message.body;
  if (typeof message.ciphertext === "string") payload.ciphertext = message.ciphertext;
  if (typeof message.relay_message_id === "string") payload.relay_message_id = message.relay_message_id;
  return payload;
}

// Inbound projector. Trusts the verified+decrypted payload and writes
// it into the local store via projectIncomingMessage (for upsert) or
// tombstoneLocalMessage (for delete), each of which enforces owner
// stamping and monotonic merging. Returning false halts the cycle so
// the cursor doesn't advance past a malformed event we couldn't apply.
registerSliceProjector("message", async (account, event, payload) => {
  if (event.kind === "message.upsert") {
    const candidate = payload as Partial<MessageSyncPayload>;
    if (
      typeof candidate.message_id !== "string"
      || typeof candidate.conversation_id !== "string"
      || (candidate.direction !== "sent" && candidate.direction !== "received")
      || typeof candidate.sender_canonical_id !== "string"
      || typeof candidate.recipient_canonical_id !== "string"
      || typeof candidate.created_at !== "string"
      || typeof candidate.updated_at !== "string"
      || typeof candidate.status !== "string"
    ) {
      return false;
    }
    // Both devices share the same account_canonical_id; the owner
    // stamp embedded in the encrypted payload must match the account
    // we're applying it to.
    if (typeof candidate.owner_canonical_id === "string"
        && candidate.owner_canonical_id !== account.canonical_id) {
      return false;
    }

    await projectIncomingMessage(account.canonical_id, {
      message_id: candidate.message_id,
      conversation_id: candidate.conversation_id,
      direction: candidate.direction,
      sender_canonical_id: candidate.sender_canonical_id,
      recipient_canonical_id: candidate.recipient_canonical_id,
      sender_handle: typeof candidate.sender_handle === "string" ? candidate.sender_handle : undefined,
      recipient_handle: typeof candidate.recipient_handle === "string" ? candidate.recipient_handle : undefined,
      body: typeof candidate.body === "string" ? candidate.body : "",
      ciphertext: typeof candidate.ciphertext === "string" ? candidate.ciphertext : undefined,
      created_at: candidate.created_at,
      updated_at: candidate.updated_at,
      status: candidate.status as RelayEnvelopeStatus,
      relay_message_id: typeof candidate.relay_message_id === "string" ? candidate.relay_message_id : undefined
    });
    return true;
  }
  if (event.kind === "message.delete") {
    const candidate = payload as Partial<MessageDeletePayload>;
    if (
      typeof candidate.message_id !== "string"
      || typeof candidate.deleted_at !== "string"
    ) {
      return false;
    }
    if (typeof candidate.owner_canonical_id === "string"
        && candidate.owner_canonical_id !== account.canonical_id) {
      return false;
    }
    await tombstoneLocalMessage(account.canonical_id, {
      message_id: candidate.message_id,
      conversation_id: typeof candidate.conversation_id === "string" ? candidate.conversation_id : undefined,
      deleted_at: candidate.deleted_at
    });
    return true;
  }
  return false;
});

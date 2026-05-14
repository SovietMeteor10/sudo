// Media-attachment slice + cross-user envelope.
//
// Two convergence paths for the same metadata:
//
//   SAME-OWNER (linked-device sync):
//     slice = "message_attachment", kind = "message_attachment.upsert"
//     encrypted_payload = serialised LocalMessageAttachment with
//       wrapped_key_for_self set (account_sync_sym_key envelope).
//
//   CROSS-USER (chat peer):
//     relay envelope with ciphertext_scheme = "sudo_attachment_v1"
//     body carries: metadata + wrapped_key_for_peer (messaging-key
//       envelope addressed to OUR messaging key).
//
// Either path lets the receiving device decrypt + render. The
// monotonic upsert in local-store merges "first non-null wrap"
// wins so a late same-owner arrival doesn't overwrite the peer
// wrap and vice-versa.

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import {
  upsertLocalMessageAttachmentMonotonic
} from "../local/local-store.js";
import type { LocalMessageAttachment } from "../local/local-types.js";
import { signRelayEnvelope } from "../crypto/signing.js";

export const ATTACHMENT_CIPHERTEXT_SCHEME = "sudo_attachment_v1";

// Wire shape of the same-owner sync event's plaintext payload.
type AttachmentSyncPayload = {
  owner_canonical_id: string;
  relay_message_id: string;
  blob_id: string;
  mime: string;
  filename: string;
  size_bytes: number;
  width?: number;
  height?: number;
  // EncryptedSyncEnvelope JSON (encryptSyncPayload output).
  wrapped_key_for_self: string;
  created_at: string;
  updated_at: string;
};

// Wire shape of the cross-user envelope body. The wrapped_key
// here is a BrowserEncryptedMessage stringified — addressed to
// the receiving user's messaging key.
type AttachmentEnvelopeBody = {
  schema_version: 1;
  // The carrier chat message's relay_message_id. The attachment
  // envelope itself has its own envelope.message_id (necessary —
  // the relay rejects duplicate message_ids), but the recipient
  // needs to associate the attachment with the visible chat row.
  carrier_relay_message_id: string;
  blob_id: string;
  mime: string;
  filename: string;
  size_bytes: number;
  width?: number;
  height?: number;
  // BrowserEncryptedMessage JSON (encryptPrivateMessage output).
  wrapped_key_for_peer: string;
  // Sender messaging key meta so the receiver can derive the
  // shared secret. The sender's canonical_id is on the envelope
  // already; we still need the keyType for the ECDH algorithm
  // selection (x25519 vs ecdh-p256).
  sender_messaging_key_type: "x25519" | "ecdh-p256";
};

// ---- cross-user envelope encode/decode ----------------------------------

export function encodeAttachmentEnvelopeBody(body: AttachmentEnvelopeBody): string {
  const json = JSON.stringify(body);
  return `${ATTACHMENT_CIPHERTEXT_SCHEME}:${btoa(unescape(encodeURIComponent(json)))}`;
}

export function decodeAttachmentEnvelopeBody(rawCiphertext: string): AttachmentEnvelopeBody | null {
  const prefix = `${ATTACHMENT_CIPHERTEXT_SCHEME}:`;
  const payload = rawCiphertext.startsWith(prefix) ? rawCiphertext.slice(prefix.length) : rawCiphertext;
  let decoded: unknown;
  try { decoded = JSON.parse(decodeURIComponent(escape(atob(payload)))); }
  catch { return null; }
  if (decoded === null || typeof decoded !== "object") return null;
  const obj = decoded as Partial<AttachmentEnvelopeBody>;
  if (
    obj.schema_version !== 1
    || typeof obj.carrier_relay_message_id !== "string"
    || typeof obj.blob_id !== "string"
    || typeof obj.mime !== "string"
    || typeof obj.filename !== "string"
    || typeof obj.size_bytes !== "number"
    || typeof obj.wrapped_key_for_peer !== "string"
    || (obj.sender_messaging_key_type !== "x25519" && obj.sender_messaging_key_type !== "ecdh-p256")
  ) return null;
  const out: AttachmentEnvelopeBody = {
    schema_version: 1,
    carrier_relay_message_id: obj.carrier_relay_message_id,
    blob_id: obj.blob_id,
    mime: obj.mime,
    filename: obj.filename,
    size_bytes: obj.size_bytes,
    wrapped_key_for_peer: obj.wrapped_key_for_peer,
    sender_messaging_key_type: obj.sender_messaging_key_type
  };
  if (typeof obj.width === "number") out.width = obj.width;
  if (typeof obj.height === "number") out.height = obj.height;
  return out;
}

// ---- send paths ---------------------------------------------------------

// Notify own linked devices via message_attachment.upsert. The
// caller has already written the local row + uploaded the blob;
// this fans out to other tabs / phones owned by the same account.
export async function notifyAttachmentUpsert(attachment: LocalMessageAttachment): Promise<{ written: boolean }> {
  if (typeof attachment.wrapped_key_for_self !== "string") {
    return { written: false };
  }
  const result = await upsertLocalMessageAttachmentMonotonic(attachment);
  if (!result.written) return { written: false };
  const account = activeAccount();
  if (account === null || account.canonical_id !== attachment.owner_canonical_id) {
    return { written: true };
  }
  const payload: AttachmentSyncPayload = {
    owner_canonical_id: attachment.owner_canonical_id,
    relay_message_id: attachment.relay_message_id,
    blob_id: attachment.blob_id,
    mime: attachment.mime,
    filename: attachment.filename,
    size_bytes: attachment.size_bytes,
    wrapped_key_for_self: attachment.wrapped_key_for_self,
    created_at: attachment.created_at,
    updated_at: attachment.updated_at
  };
  if (typeof attachment.width === "number") payload.width = attachment.width;
  if (typeof attachment.height === "number") payload.height = attachment.height;
  void buildAndPostSyncEvent("message_attachment", "message_attachment.upsert", payload);
  return { written: true };
}

// Send the cross-user attachment envelope via the existing relay.
// The wrapped_key_for_peer must already be addressed to the
// recipient's messaging key (see crypto/media.ts wrapMediaKeyForPeer).
export async function postAttachmentRelayEnvelope(input: {
  senderAccount: BrowserCryptoAccount;
  senderHandle?: string;
  recipientCanonicalId: string;
  recipientHandle?: string;
  attachment: LocalMessageAttachment;
  wrappedKeyForPeerJson: string;
}): Promise<{ ok: boolean }> {
  const now = new Date();
  const expires = new Date(now.valueOf() + 24 * 60 * 60 * 1000);
  const body: AttachmentEnvelopeBody = {
    schema_version: 1,
    carrier_relay_message_id: input.attachment.relay_message_id,
    blob_id: input.attachment.blob_id,
    mime: input.attachment.mime,
    filename: input.attachment.filename,
    size_bytes: input.attachment.size_bytes,
    wrapped_key_for_peer: input.wrappedKeyForPeerJson,
    sender_messaging_key_type: input.senderAccount.messaging_key_type === "x25519" ? "x25519" : "ecdh-p256"
  };
  if (typeof input.attachment.width === "number") body.width = input.attachment.width;
  if (typeof input.attachment.height === "number") body.height = input.attachment.height;
  const envelope = {
    type: "sudo_relay_envelope" as const,
    protocol_version: "0.1.0",
    // Fresh envelope id — the carrier message has its own id which
    // the relay would reject as duplicate. The body carries the
    // carrier_relay_message_id so the receiver can associate the
    // attachment with the visible chat row.
    message_id: crypto.randomUUID(),
    sender_canonical_id: input.senderAccount.canonical_id,
    recipient_canonical_id: input.recipientCanonicalId,
    sender_handle: input.senderHandle,
    recipient_handle: input.recipientHandle,
    ciphertext: encodeAttachmentEnvelopeBody(body),
    ciphertext_scheme: ATTACHMENT_CIPHERTEXT_SCHEME,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: "queued_local" as const,
    sender_signature: "dev-placeholder" as string
  };
  // Phase 14 CRIT-1: production relay rejects dev-placeholder, so we
  // must sign the canonical envelope body with the sender's identity
  // key before POSTing. Mirrors the chat-send path in relay-local.ts.
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
      input.senderAccount.identity_key,
      input.senderAccount.identity_key_type
    );
  } catch {
    return { ok: false };
  }
  try {
    const r = await fetch("/api/relay/envelopes", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}

// ---- receive paths ------------------------------------------------------

// Apply an inbound cross-user attachment envelope. The blob ref
// + wrapped peer key land in our local store. Unwrapping happens
// lazily at render time (so the user only pays the ECDH cost when
// they actually view the attachment).
export async function applyIncomingAttachmentFromRelay(
  ownerCanonicalId: string,
  envelope: {
    sender_canonical_id: string;
    // Note: this is the ATTACHMENT envelope's own message_id, not
    // the carrier's. The body carries carrier_relay_message_id —
    // that's what we key our local store on so the renderer can
    // find the attachment by looking up the chat row's
    // relay_message_id.
    relay_message_id: string;
    body: AttachmentEnvelopeBody;
    created_at: string;
  }
): Promise<{ written: boolean }> {
  const now = new Date().toISOString();
  const attachment: LocalMessageAttachment = {
    owner_canonical_id: ownerCanonicalId,
    relay_message_id: envelope.body.carrier_relay_message_id,
    blob_id: envelope.body.blob_id,
    mime: envelope.body.mime,
    filename: envelope.body.filename,
    size_bytes: envelope.body.size_bytes,
    wrapped_key_for_peer: envelope.body.wrapped_key_for_peer,
    sender_canonical_id: envelope.sender_canonical_id,
    sender_messaging_key_type: envelope.body.sender_messaging_key_type,
    created_at: envelope.created_at,
    updated_at: now
  };
  if (typeof envelope.body.width === "number") attachment.width = envelope.body.width;
  if (typeof envelope.body.height === "number") attachment.height = envelope.body.height;
  const result = await upsertLocalMessageAttachmentMonotonic(attachment);
  return { written: result.written };
}

// Same-owner projector. The encrypted_payload was decrypted by
// the coordinator already; we receive a plaintext JSON object.
registerSliceProjector("message_attachment", async (account, event, payload) => {
  if (event.kind !== "message_attachment.upsert") return false;
  const p = payload as Partial<AttachmentSyncPayload>;
  if (
    typeof p.relay_message_id !== "string"
    || typeof p.blob_id !== "string"
    || typeof p.mime !== "string"
    || typeof p.filename !== "string"
    || typeof p.size_bytes !== "number"
    || typeof p.wrapped_key_for_self !== "string"
    || typeof p.created_at !== "string"
    || typeof p.updated_at !== "string"
  ) return false;
  if (typeof p.owner_canonical_id === "string" && p.owner_canonical_id !== account.canonical_id) {
    return false;
  }
  const row: LocalMessageAttachment = {
    owner_canonical_id: account.canonical_id,
    relay_message_id: p.relay_message_id,
    blob_id: p.blob_id,
    mime: p.mime,
    filename: p.filename,
    size_bytes: p.size_bytes,
    wrapped_key_for_self: p.wrapped_key_for_self,
    created_at: p.created_at,
    updated_at: p.updated_at
  };
  if (typeof p.width === "number") row.width = p.width;
  if (typeof p.height === "number") row.height = p.height;
  await upsertLocalMessageAttachmentMonotonic(row);
  return true;
});

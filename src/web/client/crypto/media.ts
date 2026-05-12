// Media-attachment crypto helpers.
//
// Two-wrap model (per Phase 8 Option A decision):
//   - blob: per-attachment random AES-256-GCM key + IV, encrypts
//     the raw file bytes client-side. Server only ever stores
//     ciphertext.
//   - key for peer: the {key, iv} pair is wrapped using the existing
//     messaging-key envelope (ECDH+AES-GCM via encryptPrivateMessage),
//     addressed to the chat peer. Inserted into the sudo_attachment_v1
//     relay envelope.
//   - key for own linked devices: the same {key, iv} pair is wrapped
//     under the account_sync_sym_key (encryptSyncPayload), inserted
//     into a message_attachment.upsert sync event.

import { base64Url, base64UrlToBytes, randomBytes, toBufferSource } from "../local/crypto.js";
import {
  decryptPrivateMessage,
  encryptPrivateMessage,
  type BrowserEncryptedMessage
} from "./messaging.js";
import { decryptSyncPayload, encryptSyncPayload } from "./sync.js";
import type { MessagingKeyType } from "../../../protocol/types.js";

// Blob layer ----------------------------------------------------------------

export type BlobEncryptResult = {
  ciphertext: Uint8Array;
  // Both fields are base64url-encoded so they pass through any
  // envelope JSON without binary munging.
  key_b64: string;
  iv_b64: string;
};

export async function encryptBlobForUpload(plain: Uint8Array): Promise<BlobEncryptResult> {
  const keyBytes = randomBytes(32);
  const iv = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(keyBytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    cryptoKey,
    toBufferSource(plain)
  );
  return {
    ciphertext: new Uint8Array(ciphertext),
    key_b64: base64Url(keyBytes),
    iv_b64: base64Url(iv)
  };
}

export async function decryptDownloadedBlob(
  ciphertext: Uint8Array,
  key_b64: string,
  iv_b64: string
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(base64UrlToBytes(key_b64)),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(base64UrlToBytes(iv_b64)) },
    cryptoKey,
    toBufferSource(ciphertext)
  );
  return new Uint8Array(plain);
}

// Key-wrap layer ------------------------------------------------------------
//
// The "key material" we wrap is a tiny JSON object so the wire
// format is the same on both wrap paths.
type WrappedMediaKey = { key_b64: string; iv_b64: string };

function packKeyJson(key_b64: string, iv_b64: string): string {
  return JSON.stringify({ key_b64, iv_b64 } satisfies WrappedMediaKey);
}

function unpackKeyJson(json: string): WrappedMediaKey {
  const obj = JSON.parse(json) as Partial<WrappedMediaKey>;
  if (typeof obj.key_b64 !== "string" || typeof obj.iv_b64 !== "string") {
    throw new Error("invalid wrapped media key");
  }
  return { key_b64: obj.key_b64, iv_b64: obj.iv_b64 };
}

// Cross-user wrap: addresses the recipient's messaging public key.
// Returns a BrowserEncryptedMessage we can embed verbatim in the
// sudo_attachment_v1 envelope body. Throws if the recipient's key
// material is missing — callers must fail closed (per the v1 spec).
export async function wrapMediaKeyForPeer(input: {
  key_b64: string;
  iv_b64: string;
  senderPrivateMessagingKey: CryptoKey;
  senderMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
  recipientMessagingPublicKey: string;
  recipientMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
}): Promise<BrowserEncryptedMessage> {
  return encryptPrivateMessage({
    plaintext: packKeyJson(input.key_b64, input.iv_b64),
    senderPrivateMessagingKey: input.senderPrivateMessagingKey,
    senderMessagingKeyType: input.senderMessagingKeyType,
    recipientMessagingPublicKey: input.recipientMessagingPublicKey,
    recipientMessagingKeyType: input.recipientMessagingKeyType
  });
}

export async function unwrapMediaKeyFromPeer(input: {
  encrypted: BrowserEncryptedMessage;
  recipientPrivateMessagingKey: CryptoKey;
  senderMessagingPublicKey: string;
  senderMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
}): Promise<WrappedMediaKey> {
  const plaintext = await decryptPrivateMessage({
    encrypted: input.encrypted,
    recipientPrivateMessagingKey: input.recipientPrivateMessagingKey,
    senderMessagingPublicKey: input.senderMessagingPublicKey,
    senderMessagingKeyType: input.senderMessagingKeyType
  });
  return unpackKeyJson(plaintext);
}

// Same-owner wrap: addresses our own linked devices via the
// account_sync_sym_key. The envelope JSON is what
// encryptSyncPayload returns; we embed it as a plain string in the
// message_attachment.upsert event's encrypted_payload — same shape
// as every other slice.
export async function wrapMediaKeyForSelf(input: {
  key_b64: string;
  iv_b64: string;
  syncSymKey: CryptoKey;
}): Promise<string> {
  return encryptSyncPayload(packKeyJson(input.key_b64, input.iv_b64), input.syncSymKey);
}

export async function unwrapMediaKeyFromSelf(input: {
  envelopeJson: string;
  syncSymKey: CryptoKey;
}): Promise<WrappedMediaKey> {
  const plaintext = await decryptSyncPayload(input.envelopeJson, input.syncSymKey);
  return unpackKeyJson(plaintext);
}

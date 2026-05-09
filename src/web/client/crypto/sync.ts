// Encrypts/decrypts sync event payloads under the per-account
// account_sync key. Both sides of a sync round-trip derive the same
// AES-GCM key from the deterministic PKCS8 export of the
// account_sync private key (HKDF-SHA-256 with a fixed domain
// separator), so paired devices that share the encrypted account
// bundle can read each other's sync events without ever exposing
// plaintext to the server.

import { base64Url, base64UrlToBytes, randomBytes, toBufferSource } from "../local/crypto.js";

const SYNC_DOMAIN = "sudo-sync-aes-gcm-v1";

export type EncryptedSyncEnvelope = {
  iv: string;
  ciphertext: string;
};

export async function deriveSyncSymKey(accountSyncPrivateKeyPkcs8Base64Url: string): Promise<CryptoKey> {
  const ikm = base64UrlToBytes(accountSyncPrivateKeyPkcs8Base64Url);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(ikm),
    { name: "HKDF" } as any,
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBufferSource(new Uint8Array(0)),
      info: toBufferSource(new TextEncoder().encode(SYNC_DOMAIN))
    } as any,
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSyncPayload(plaintext: string, syncSymKey: CryptoKey): Promise<string> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    syncSymKey,
    new TextEncoder().encode(plaintext)
  );
  const envelope: EncryptedSyncEnvelope = {
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext)
  };
  return JSON.stringify(envelope);
}

export async function decryptSyncPayload(envelopeJson: string, syncSymKey: CryptoKey): Promise<string> {
  const envelope = JSON.parse(envelopeJson) as EncryptedSyncEnvelope;
  if (typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("invalid sync envelope");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(base64UrlToBytes(envelope.iv)) },
    syncSymKey,
    toBufferSource(base64UrlToBytes(envelope.ciphertext))
  );
  return new TextDecoder().decode(plaintext);
}

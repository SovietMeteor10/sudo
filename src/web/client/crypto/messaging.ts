import { base64Url, base64UrlToBytes, randomBytes, toBufferSource } from "../local/crypto.js";
import { importPrivateKey, importPublicKey } from "./keys.js";
import type { MessagingKeyType } from "../../../protocol/types.js";

export type BrowserEncryptedMessage = {
  scheme: "x25519-aes-gcm-v1" | "ecdh-p256-aes-gcm-v1";
  iv: string;
  ciphertext: string;
};

export async function encryptPrivateMessage(options: {
  plaintext: string;
  senderPrivateMessagingKey: CryptoKey;
  senderMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
  recipientMessagingPublicKey: string;
  recipientMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
}): Promise<BrowserEncryptedMessage> {
  const sharedKey = await deriveSharedAesKey(
    options.senderPrivateMessagingKey,
    options.recipientMessagingPublicKey,
    options.recipientMessagingKeyType
  );
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    sharedKey,
    new TextEncoder().encode(options.plaintext)
  );

  return {
    scheme: options.recipientMessagingKeyType === "x25519" ? "x25519-aes-gcm-v1" : "ecdh-p256-aes-gcm-v1",
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext)
  };
}

export async function decryptPrivateMessage(options: {
  encrypted: BrowserEncryptedMessage;
  recipientPrivateMessagingKey: CryptoKey;
  senderMessagingPublicKey: string;
  senderMessagingKeyType: Exclude<MessagingKeyType, "x25519_or_placeholder">;
}): Promise<string> {
  const sharedKey = await deriveSharedAesKey(
    options.recipientPrivateMessagingKey,
    options.senderMessagingPublicKey,
    options.senderMessagingKeyType
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(base64UrlToBytes(options.encrypted.iv)) },
    sharedKey,
    toBufferSource(base64UrlToBytes(options.encrypted.ciphertext))
  );

  return new TextDecoder().decode(plaintext);
}

async function deriveSharedAesKey(
  privateKey: CryptoKey,
  publicKeySpki: string,
  keyType: Exclude<MessagingKeyType, "x25519_or_placeholder">
): Promise<CryptoKey> {
  const publicKey = await importPublicKey(publicKeySpki, keyType);
  const algorithm = keyType === "x25519"
    ? { name: "X25519", public: publicKey }
    : { name: "ECDH", public: publicKey };
  const bitsLength = 256;
  const sharedBits = await crypto.subtle.deriveBits(algorithm as any, privateKey, bitsLength);

  return crypto.subtle.importKey(
    "raw",
    sharedBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

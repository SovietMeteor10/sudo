import { createPublicKey, sign, verify } from "node:crypto";
import type {
  IdentityDocument,
  SignableDeviceMembership,
  SignableFeedPost,
  SignableIdentityDocument,
  SignableSyncEvent,
  SignedDeviceMembership,
  SignedSyncEvent,
  SigningKeyType
} from "../protocol/types.js";
import { base64Url, base64UrlToBuffer } from "./hash.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function signIdentityDocument(
  document: SignableIdentityDocument,
  privateKey: string
): string {
  return base64Url(sign(null, Buffer.from(canonicalJson(document)), privateKey));
}

export function signFeedPost(post: SignableFeedPost, privateKey: string): string {
  return base64Url(sign(null, Buffer.from(canonicalJson(post)), privateKey));
}

export function signDeviceMembership(
  membership: SignableDeviceMembership,
  ownerIdentityPrivateKey: string
): string {
  return base64Url(sign(null, Buffer.from(canonicalJson(membership)), ownerIdentityPrivateKey));
}

// Verify a SignedDeviceMembership against the owner's identity public
// key. The public key may be a base64url-encoded SPKI string (the
// shape produced by IdentityDocument.keys.identity.public_key for
// browser-issued ed25519 keys) or a PEM string.
export function verifyDeviceMembership(
  membership: SignedDeviceMembership,
  ownerIdentityPublicKey: string,
  keyType: SigningKeyType = "ed25519"
): boolean {
  const { signature, ...signable } = membership;
  return verifyCanonicalSignature(signable, signature, ownerIdentityPublicKey, keyType);
}

export function signSyncEvent(
  event: SignableSyncEvent,
  originDevicePrivateKey: string
): string {
  return base64Url(sign(null, Buffer.from(canonicalJson(event)), originDevicePrivateKey));
}

export function verifySyncEvent(
  event: SignedSyncEvent,
  originDevicePublicKey: string,
  keyType: SigningKeyType = "ed25519"
): boolean {
  const { signature, ...signable } = event;
  return verifyCanonicalSignature(signable, signature, originDevicePublicKey, keyType);
}

export function verifyIdentityDocument(document: IdentityDocument): boolean {
  const { signature, canonical, public_key, profile, finger, inbox, visual_fingerprint, ...signable } = document;
  const publicKey = getIdentityPublicKey(document);
  if (publicKey === null) return false;

  return verifyCanonicalSignature(signable, signature, publicKey, document.keys.identity.type ?? "ed25519");
}

export function verifyCanonicalSignature(
  payload: unknown,
  signature: string,
  publicKey: string | ReturnType<typeof createPublicKey>,
  keyType: SigningKeyType = "ed25519"
): boolean {
  const algorithm = keyType === "ecdsa-p256" ? "sha256" : null;
  const keyObject = typeof publicKey === "string" ? resolvePublicKey(publicKey) : publicKey;

  try {
    return verify(
      algorithm,
      Buffer.from(canonicalJson(payload)),
      keyObject,
      decodeSignature(signature)
    );
  } catch {
    return false;
  }
}

function getIdentityPublicKey(document: IdentityDocument): string | ReturnType<typeof createPublicKey> | null {
  if (document.keys?.identity.public_key) {
    if (document.keys.identity.public_key.startsWith("-----BEGIN")) {
      return document.keys.identity.public_key;
    }

    return createPublicKey({
      key: base64UrlToBuffer(document.keys.identity.public_key),
      format: "der",
      type: "spki"
    });
  }

  return document.public_key ?? null;
}

function resolvePublicKey(publicKey: string): ReturnType<typeof createPublicKey> {
  if (publicKey.startsWith("-----BEGIN")) {
    return createPublicKey(publicKey);
  }

  return createPublicKey({
    key: base64UrlToBuffer(publicKey),
    format: "der",
    type: "spki"
  });
}

function decodeSignature(value: string): Buffer {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return base64UrlToBuffer(value);
  }

  return Buffer.from(value, "base64");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortKeys(nestedValue)])
    );
  }

  return value;
}

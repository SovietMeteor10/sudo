import { createPublicKey, sign, verify } from "node:crypto";
import type { IdentityDocument, SignableIdentityDocument } from "../protocol/types.js";
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

export function verifyIdentityDocument(document: IdentityDocument): boolean {
  const { signature, canonical, public_key, profile, finger, inbox, visual_fingerprint, ...signable } = document;
  const publicKey = getIdentityPublicKey(document);
  if (publicKey === null) return false;

  return verify(
    null,
    Buffer.from(canonicalJson(signable)),
    publicKey,
    decodeSignature(signature)
  );
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

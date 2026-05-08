import { base64Url, base64UrlToBytes, toBufferSource } from "../local/crypto.js";
import type { MessagingKeyType, SigningKeyType } from "../../../protocol/types.js";

export type BrowserSigningKeyPair = {
  type: SigningKeyType;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeySpki: string;
  privateKeyPkcs8: string;
};

export type BrowserMessagingKeyPair = {
  type: Exclude<MessagingKeyType, "x25519_or_placeholder">;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeySpki: string;
  privateKeyPkcs8: string;
};

export type BrowserImportedKeyPair = {
  type: SigningKeyType | Exclude<MessagingKeyType, "x25519_or_placeholder">;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeySpki: string;
  privateKeyPkcs8: string;
};

export async function generateSigningKeyPair(): Promise<BrowserSigningKeyPair> {
  const ed25519 = await tryGenerateEd25519();
  if (ed25519 !== null) return ed25519;
  return tryGenerateP256Signing();
}

export async function generateDeviceKeyPair(): Promise<BrowserSigningKeyPair> {
  return generateSigningKeyPair();
}

export async function generateMessagingKeyPair(): Promise<BrowserMessagingKeyPair> {
  const x25519 = await tryGenerateX25519();
  if (x25519 !== null) return x25519;
  return tryGenerateP256Messaging();
}

export async function exportKeyPair(pair: { publicKey: CryptoKey; privateKey: CryptoKey }): Promise<{ publicKeySpki: string; privateKeyPkcs8: string }> {
  const publicKeySpki = base64Url(await crypto.subtle.exportKey("spki", pair.publicKey));
  const privateKeyPkcs8 = base64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKeySpki, privateKeyPkcs8 };
}

export async function importSigningKeyPair(record: {
  type: SigningKeyType;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}): Promise<BrowserSigningKeyPair> {
  const publicKey = await importPublicKey(record.publicKeySpki, record.type);
  const privateKey = await importPrivateKey(record.privateKeyPkcs8, record.type, true);
  return {
    type: record.type,
    publicKey,
    privateKey,
    publicKeySpki: record.publicKeySpki,
    privateKeyPkcs8: record.privateKeyPkcs8
  };
}

export async function importMessagingKeyPair(record: {
  type: Exclude<MessagingKeyType, "x25519_or_placeholder">;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}): Promise<BrowserMessagingKeyPair> {
  const publicKey = await importPublicKey(record.publicKeySpki, record.type);
  const privateKey = await importPrivateKey(record.privateKeyPkcs8, record.type, false);
  return {
    type: record.type,
    publicKey,
    privateKey,
    publicKeySpki: record.publicKeySpki,
    privateKeyPkcs8: record.privateKeyPkcs8
  };
}

export async function importPublicKey(publicKeySpki: string, keyType: SigningKeyType | Exclude<MessagingKeyType, "x25519_or_placeholder">): Promise<CryptoKey> {
  const algorithm = keyType === "ed25519"
    ? { name: "Ed25519" }
    : keyType === "ecdsa-p256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : keyType === "x25519"
        ? { name: "X25519" }
        : { name: "ECDH", namedCurve: "P-256" };

  // Web Crypto requires empty usages for ECDH/X25519 public keys (you can
  // only derive with the *private* key plus a peer public). Passing
  // ["deriveBits"] here makes Chrome throw "Cannot create a key using the
  // specified key usages." Signing public keys take ["verify"].
  const usages: KeyUsage[] = keyType === "ed25519" || keyType === "ecdsa-p256" ? ["verify"] : [];

  return crypto.subtle.importKey(
    "spki",
    toBufferSource(base64UrlToBytes(publicKeySpki)),
    algorithm as any,
    true,
    usages
  );
}

export async function importPrivateKey(
  privateKeyPkcs8: string,
  keyType: SigningKeyType | Exclude<MessagingKeyType, "x25519_or_placeholder">,
  forSigning: boolean
): Promise<CryptoKey> {
  const algorithm = keyType === "ed25519"
    ? { name: "Ed25519" }
    : keyType === "ecdsa-p256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : keyType === "x25519"
        ? { name: "X25519" }
        : { name: "ECDH", namedCurve: "P-256" };

  return crypto.subtle.importKey(
    "pkcs8",
    toBufferSource(base64UrlToBytes(privateKeyPkcs8)),
    algorithm as any,
    true,
    keyType === "ed25519" || keyType === "ecdsa-p256"
      ? ["sign"]
      : forSigning
        ? ["deriveBits"]
        : ["deriveBits"]
  );
}

async function tryGenerateEd25519(): Promise<BrowserSigningKeyPair | null> {
  try {
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" } as any,
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;
    const exported = await exportKeyPair(pair);
    return {
      type: "ed25519",
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      publicKeySpki: exported.publicKeySpki,
      privateKeyPkcs8: exported.privateKeyPkcs8
    };
  } catch {
    return null;
  }
}

async function tryGenerateP256Signing(): Promise<BrowserSigningKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" } as any,
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const exported = await exportKeyPair(pair);
  return {
    type: "ecdsa-p256",
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeySpki: exported.publicKeySpki,
    privateKeyPkcs8: exported.privateKeyPkcs8
  };
}

async function tryGenerateX25519(): Promise<BrowserMessagingKeyPair | null> {
  try {
    const pair = await crypto.subtle.generateKey(
      { name: "X25519" } as any,
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const exported = await exportKeyPair(pair);
    return {
      type: "x25519",
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      publicKeySpki: exported.publicKeySpki,
      privateKeyPkcs8: exported.privateKeyPkcs8
    };
  } catch {
    return null;
  }
}

async function tryGenerateP256Messaging(): Promise<BrowserMessagingKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" } as any,
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  const exported = await exportKeyPair(pair);
  return {
    type: "ecdh-p256",
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeySpki: exported.publicKeySpki,
    privateKeyPkcs8: exported.privateKeyPkcs8
  };
}

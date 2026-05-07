import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

export type KeyPairPem = {
  publicKey: string;
  privateKey: string;
};

export type SignableIdentityDocument = {
  handle: string;
  canonical: string;
  public_key: string;
  profile: string;
  finger: string;
  inbox: string;
  updated_at: string;
};

export type IdentityDocument = SignableIdentityDocument & {
  signature: string;
};

export function createCanonicalId(): string {
  return randomBytes(4).toString("hex");
}

export function createEd25519KeyPair(): KeyPairPem {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function signIdentityDocument(
  document: SignableIdentityDocument,
  privateKey: string
): string {
  return sign(null, Buffer.from(canonicalJson(document)), privateKey).toString("base64");
}

export function verifyIdentityDocument(document: IdentityDocument): boolean {
  const { signature, ...signable } = document;
  return verify(
    null,
    Buffer.from(canonicalJson(signable)),
    document.public_key,
    Buffer.from(signature, "base64")
  );
}

export function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
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

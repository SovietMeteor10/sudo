import { generateKeyPairSync, randomBytes } from "node:crypto";
import { base64Url } from "./hash.js";

export type KeyPairPem = {
  publicKey: string;
  privateKey: string;
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

export function createEd25519KeyPairBase64Url(): KeyPairPem {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "der"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });

  return {
    publicKey: base64Url(pair.publicKey),
    privateKey: pair.privateKey
  };
}

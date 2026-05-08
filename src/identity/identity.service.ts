import { sha256Hex, signIdentityDocument } from "../crypto/index.js";
import { SUDO_PROTOCOL_VERSION } from "../protocol/constants.js";
import type { IdentityDocument, RelayCapability, SignableIdentityDocument, SigningKeyType } from "../protocol/types.js";
import {
  getIdentityByCanonicalId,
  getIdentityFingerprintByCanonicalId,
  getIdentityByHandle,
  normalizeHandle
} from "./identity.store.js";
import { saveIdentity } from "./registry.js";
import { verifyIdentityDocument } from "../crypto/signatures.js";

export type CreateIdentityDocumentOptions = {
  handle: string;
  homeNode: string;
  identityPublicKey: string;
  identityPrivateKey: string;
  messagingPublicKey: string;
  feedPublicKey: string;
  devicePublicKey?: string;
  deliveryRelays?: RelayCapability[];
  feedEndpoints?: string[];
  createdAt?: string;
  sequence?: number;
  identityKeyType?: SigningKeyType;
};

export function resolveIdentityByHandle(handle: string) {
  normalizeHandle(handle);
  return getIdentityByHandle(handle);
}

export function resolveIdentityByCanonicalId(canonicalId: string) {
  return getIdentityByCanonicalId(canonicalId);
}

export function resolveIdentityFingerprintByCanonicalId(canonicalId: string) {
  return getIdentityFingerprintByCanonicalId(canonicalId);
}

export function deriveCanonicalId(identityPublicKey: string, keyType: SigningKeyType = "ed25519"): string {
  return `sudo:${keyType}:${sha256Hex(identityPublicKey)}`;
}

export function createSignedIdentityDocument(options: CreateIdentityDocumentOptions): IdentityDocument {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const sequence = options.sequence ?? 1;
  const canonicalId = deriveCanonicalId(options.identityPublicKey);
  const unsignedDocument: SignableIdentityDocument = {
    type: "sudo_identity",
    protocol_version: SUDO_PROTOCOL_VERSION,
    canonical_id: canonicalId,
    handle: options.handle,
    home_node: options.homeNode,
    keys: {
      identity: {
        type: options.identityKeyType ?? "ed25519",
        public_key: options.identityPublicKey
      },
      messaging: {
        type: "x25519_or_placeholder",
        public_key: options.messagingPublicKey
      },
      feed: {
        type: options.identityKeyType ?? "ed25519",
        public_key: options.feedPublicKey
      },
      ...(options.devicePublicKey === undefined
        ? {}
        : {
            device: {
              type: options.identityKeyType ?? "ed25519",
              public_key: options.devicePublicKey
            }
          })
    },
    delivery_relays: options.deliveryRelays ?? [],
    feed_endpoints: options.feedEndpoints ?? [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence
  };

  return {
    ...unsignedDocument,
    signature: signIdentityDocument(unsignedDocument, options.identityPrivateKey)
  };
}

export function registerIdentityDocument(document: IdentityDocument): IdentityDocument {
  if (!verifyIdentityDocument(document)) {
    throw new Error("invalid identity signature");
  }

  const expectedCanonicalId = deriveCanonicalId(
    document.keys.identity.public_key,
    document.keys.identity.type ?? "ed25519"
  );

  if (document.canonical_id !== expectedCanonicalId) {
    throw new Error("canonical id does not match identity public key");
  }

  normalizeHandle(document.handle);
  saveIdentity(document.canonical_id, document);
  return document;
}

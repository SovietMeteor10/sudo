import type {
  IdentityDocument,
  RelayCapability,
  MessagingKeyType,
  SignableIdentityDocument,
  SigningKeyType
} from "../../../protocol/types.js";
import { formatCanonicalId } from "../../../protocol/identity.js";
import { base64Url } from "../local/crypto.js";
import { canonicalJson } from "./signing.js";

// Browser identity keys are currently transitional ECDSA P-256 (or Ed25519
// where Web Crypto exposes it). The canonical_id always names the actual key
// type so server verification can pick the right algorithm. Hashing is async
// in the browser (crypto.subtle.digest), so anything that derives a
// canonical_id must be awaited.
export async function deriveCanonicalIdFromPublicKey(publicKey: string, keyType: SigningKeyType): Promise<string> {
  return formatCanonicalId(keyType, await sha256Hex(publicKey));
}

export async function createIdentityDocumentDraft(options: {
  handle: string;
  homeNode: string;
  identityPublicKey: string;
  messagingPublicKey: string;
  feedPublicKey: string;
  devicePublicKey?: string;
  deliveryRelays?: RelayCapability[];
  createdAt?: string;
  sequence?: number;
  identityKeyType: SigningKeyType;
  messagingKeyType: MessagingKeyType;
  feedKeyType?: SigningKeyType;
  deviceKeyType?: SigningKeyType;
}): Promise<SignableIdentityDocument> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const canonicalId = await deriveCanonicalIdFromPublicKey(options.identityPublicKey, options.identityKeyType);

  return {
    type: "sudo_identity",
    protocol_version: "0.1.0",
    canonical_id: canonicalId,
    handle: options.handle,
    home_node: options.homeNode,
    keys: {
      identity: {
        type: options.identityKeyType,
        public_key: options.identityPublicKey
      },
      messaging: {
        type: options.messagingKeyType,
        public_key: options.messagingPublicKey
      },
      feed: {
        type: options.feedKeyType ?? options.identityKeyType,
        public_key: options.feedPublicKey
      },
      ...(options.devicePublicKey === undefined
        ? {}
        : {
            device: {
              type: options.deviceKeyType ?? options.identityKeyType,
              public_key: options.devicePublicKey
            }
          })
    },
    delivery_relays: options.deliveryRelays ?? [],
    feed_endpoints: [],
    created_at: createdAt,
    updated_at: createdAt,
    sequence: options.sequence ?? 1
  };
}

export async function fingerprintIdentityDocument(document: Pick<IdentityDocument, "keys">): Promise<string> {
  return generateFingerprint(document.keys.identity.public_key);
}

export async function canonicalJsonDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return base64Url(digest);
}

async function generateFingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey));
  const bytes = new Uint8Array(digest);
  return [...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

import type {
  DiscoveryReaction,
  FeedPost,
  RelayEnvelope,
  SignableDeviceMembership,
  SignableIdentityDocument,
  SignableFeedPost,
  SignableSyncEvent,
  SigningKeyType
} from "../../../protocol/types.js";
import { base64Url } from "../local/crypto.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export async function signIdentityDocument(
  document: SignableIdentityDocument,
  privateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(document, privateKey, keyType);
}

export async function signFeedPost(
  post: SignableFeedPost,
  privateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(post, privateKey, keyType);
}

export async function signDiscoveryReaction(
  reaction: Omit<DiscoveryReaction, "signature">,
  privateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(reaction, privateKey, keyType);
}

export async function signRelayEnvelope(
  envelope: Omit<RelayEnvelope, "sender_signature" | "status">,
  privateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(envelope, privateKey, keyType);
}

export async function signDeviceMembership(
  membership: SignableDeviceMembership,
  ownerIdentityPrivateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(membership, ownerIdentityPrivateKey, keyType);
}

export async function signSyncEvent(
  event: SignableSyncEvent,
  originDevicePrivateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(event, originDevicePrivateKey, keyType);
}

// Used by the client-signed session bootstrap. The browser signs
// canonical JSON of { type: "sudo_session_challenge", canonical_id,
// nonce } with the locally-held identity private key, then exchanges
// the resulting signature for a server session — no password leaves
// the device.
export type SessionChallengePayload = {
  type: "sudo_session_challenge";
  canonical_id: string;
  nonce: string;
};

export async function signSessionChallenge(
  payload: SessionChallengePayload,
  identityPrivateKey: CryptoKey,
  keyType: SigningKeyType
): Promise<string> {
  return signCanonicalPayload(payload, identityPrivateKey, keyType);
}

async function signCanonicalPayload(payload: unknown, privateKey: CryptoKey, keyType: SigningKeyType): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(payload));
  const algorithm = keyType === "ecdsa-p256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "Ed25519" };
  const signature = await crypto.subtle.sign(algorithm as any, privateKey, data);
  return base64Url(signature);
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

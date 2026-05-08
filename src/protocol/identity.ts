// Shared canonical-id format helpers. Both server and browser portal call into
// these so the canonical_id string format never drifts. Hashing implementations
// differ between Node and Web Crypto, but the format and parsing live here.

export const CANONICAL_ID_PREFIX = "sudo";

export const CANONICAL_ID_PATTERN = /^sudo:([a-z0-9-]+):([0-9a-f]{64})$/;

export type CanonicalIdParts = {
  keyType: string;
  hashHex: string;
};

export function formatCanonicalId(keyType: string, hashHex: string): string {
  return `${CANONICAL_ID_PREFIX}:${keyType}:${hashHex}`;
}

export function parseCanonicalId(canonicalId: string): CanonicalIdParts | null {
  const match = CANONICAL_ID_PATTERN.exec(canonicalId);
  if (match === null) return null;
  return { keyType: match[1]!, hashHex: match[2]! };
}

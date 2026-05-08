import { generateIdentityGrid } from "../crypto/index.js";
import { normalizeHandle } from "../identity/identity.store.js";
import type { IdentityFingerprint, SearchResult } from "../protocol/types.js";
import { listSearchableIdentities } from "./discovery.store.js";
import { scoreHandle } from "./ranking.js";

export function searchIdentityHandles(query: string): SearchResult[] {
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();

  if (normalizedQuery.length === 0) {
    return [];
  }

  try {
    normalizeHandle(normalizedQuery);
  } catch {
    if (!/^[a-z0-9_]{1,32}$/.test(normalizedQuery)) {
      return [];
    }
  }

  return listSearchableIdentities()
    .map((row) => {
      const handleBody = row.handle.replace(/^@/, "").toLowerCase();
      const score = scoreHandle(handleBody, normalizedQuery);
      return { row, score };
    })
    .filter((item) => item.score !== null)
    .sort((left, right) => left.score! - right.score! || left.row.handle.localeCompare(right.row.handle))
    .slice(0, 10)
    .map(({ row }) => {
      const publicKey = row.identity_public_key ?? row.public_key;
      const fingerprintGrid = parseFingerprint(row.fingerprint_json) ?? generateIdentityGrid(publicKey);
      return {
        handle: row.handle,
        canonical: row.canonical_id,
        bio: "identity document",
        fingerprint: fingerprintGrid.fingerprint,
        fingerprint_grid: fingerprintGrid
      };
    });
}

function parseFingerprint(value: string | null): IdentityFingerprint | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as IdentityFingerprint;
  } catch {
    return null;
  }
}

import { db } from "../storage/db.js";

export type SearchableIdentityRow = {
  handle: string;
  canonical_id: string;
  canonical: string;
  public_key: string;
  identity_public_key: string | null;
  fingerprint_json: string | null;
};

export function listSearchableIdentities(): SearchableIdentityRow[] {
  return db.prepare(`
    SELECT handle, canonical_id, canonical, public_key, identity_public_key, fingerprint_json
    FROM identities
  `).all() as SearchableIdentityRow[];
}

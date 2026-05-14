// Phase 14B: per-account short bio rendered on /u/:handle public
// profile pages. Storage is intentionally separate from `identities`
// — the identity document is signed and immutable-ish; the bio is
// edit-as-you-go and doesn't belong in the signed payload.
//
// Server caps and sanitization live here so route + UI agree.

import { db } from "../storage/db.js";

export const MAX_BIO_LENGTH = 280;

// Strip ASCII control chars (0x00..0x1f, 0x7f) except for \n and \t.
// Truncate to MAX_BIO_LENGTH chars after stripping. Returns the
// normalized string; never throws.
export function normalizeBio(input: unknown): string {
  if (typeof input !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  if (cleaned.length <= MAX_BIO_LENGTH) return cleaned;
  return cleaned.slice(0, MAX_BIO_LENGTH);
}

export function getIdentityBio(canonicalId: string): string | null {
  const row = db.prepare("SELECT bio FROM identity_bio WHERE canonical_id = ?").get(canonicalId) as { bio: string } | undefined;
  return row?.bio ?? null;
}

export function setIdentityBio(canonicalId: string, bio: string): void {
  const now = new Date().toISOString();
  if (bio.length === 0) {
    db.prepare("DELETE FROM identity_bio WHERE canonical_id = ?").run(canonicalId);
    return;
  }
  db.prepare(`
    INSERT INTO identity_bio (canonical_id, bio, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at
  `).run(canonicalId, bio, now);
}

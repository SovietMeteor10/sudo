import { db } from "./db.js";
import type { IdentityDocument } from "./crypto.js";

export type RegistryIdentity = {
  handle: string;
  canonicalId: string;
  document: IdentityDocument;
};

type IdentityRow = {
  handle: string;
  canonical_id: string;
  canonical: string;
  public_key: string;
  profile_url: string;
  finger_url: string;
  inbox_url: string;
  updated_at: string;
  signature: string;
};

export function normalizeHandle(input: string): string {
  const trimmed = input.trim().replace(/^@/, "");

  if (!/^[A-Za-z0-9_]{3,32}$/.test(trimmed)) {
    throw new Error("Handle must be 3-32 chars: letters, numbers, underscore.");
  }

  return trimmed;
}

export function createHandle(input: string): string {
  return `@${normalizeHandle(input)}`;
}

export function saveIdentity(canonicalId: string, document: IdentityDocument): void {
  db.prepare(`
    INSERT INTO identities (
      handle,
      canonical_id,
      canonical,
      public_key,
      profile_url,
      finger_url,
      inbox_url,
      updated_at,
      signature
    ) VALUES (
      @handle,
      @canonicalId,
      @canonical,
      @publicKey,
      @profileUrl,
      @fingerUrl,
      @inboxUrl,
      @updatedAt,
      @signature
    )
  `).run({
    handle: document.handle,
    canonicalId,
    canonical: document.canonical,
    publicKey: document.public_key,
    profileUrl: document.profile,
    fingerUrl: document.finger,
    inboxUrl: document.inbox,
    updatedAt: document.updated_at,
    signature: document.signature
  });
}

export function getIdentityByHandle(input: string): RegistryIdentity | null {
  const handle = createHandle(input);
  const row = db
    .prepare("SELECT * FROM identities WHERE handle = ?")
    .get(handle) as IdentityRow | undefined;

  return row ? rowToIdentity(row) : null;
}

export function getIdentityByCanonicalId(canonicalId: string): RegistryIdentity | null {
  const row = db
    .prepare("SELECT * FROM identities WHERE canonical_id = ?")
    .get(canonicalId) as IdentityRow | undefined;

  return row ? rowToIdentity(row) : null;
}

function rowToIdentity(row: IdentityRow): RegistryIdentity {
  return {
    handle: row.handle,
    canonicalId: row.canonical_id,
    document: {
      handle: row.handle,
      canonical: row.canonical,
      public_key: row.public_key,
      profile: row.profile_url,
      finger: row.finger_url,
      inbox: row.inbox_url,
      updated_at: row.updated_at,
      signature: row.signature
    }
  };
}

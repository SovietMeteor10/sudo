import { db } from "../storage/db.js";
import { generateIdentityGrid } from "../crypto/index.js";
import { SUDO_PROTOCOL_VERSION } from "../protocol/constants.js";
import type { IdentityDocument, IdentityFingerprint } from "../protocol/types.js";

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
  home_node: string | null;
  identity_public_key: string | null;
  messaging_public_key: string | null;
  feed_public_key: string | null;
  document_json: string | null;
  fingerprint_json: string | null;
  created_at: string | null;
  updated_at: string;
  sequence: number | null;
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
  const existingByCanonical = getIdentityByCanonicalId(canonicalId);
  if (existingByCanonical !== null && existingByCanonical.document.sequence > document.sequence) {
    throw new Error("stale identity document");
  }

  const existingByHandle = getIdentityByHandle(document.handle);
  if (existingByHandle !== null && existingByHandle.canonicalId !== canonicalId) {
    throw new Error("handle already exists");
  }

  const identityPublicKey = getIdentityPublicKey(document);
  const messagingPublicKey = document.keys?.messaging.public_key ?? "";
  const feedPublicKey = document.keys?.feed.public_key ?? identityPublicKey;
  const homeNode = document.home_node ?? "";
  const profileUrl = document.profile ?? `/u/${canonicalId}`;
  const fingerUrl = document.finger ?? `/finger/${document.handle.replace(/^@/, "")}`;
  const inboxUrl = document.inbox ?? `/inbox/${canonicalId}`;
  const canonical = document.canonical ?? canonicalId;
  const fingerprint = generateIdentityGrid(identityPublicKey);

  db.prepare(`
    INSERT INTO identities (
      handle,
      canonical_id,
      canonical,
      public_key,
      profile_url,
      finger_url,
      inbox_url,
      home_node,
      identity_public_key,
      messaging_public_key,
      feed_public_key,
      document_json,
      fingerprint_json,
      created_at,
      updated_at,
      sequence,
      signature
    ) VALUES (
      @handle,
      @canonicalId,
      @canonical,
      @publicKey,
      @profileUrl,
      @fingerUrl,
      @inboxUrl,
      @homeNode,
      @identityPublicKey,
      @messagingPublicKey,
      @feedPublicKey,
      @documentJson,
      @fingerprintJson,
      @createdAt,
      @updatedAt,
      @sequence,
      @signature
    )
    ON CONFLICT(canonical_id) DO UPDATE SET
      handle = excluded.handle,
      canonical = excluded.canonical,
      public_key = excluded.public_key,
      profile_url = excluded.profile_url,
      finger_url = excluded.finger_url,
      inbox_url = excluded.inbox_url,
      home_node = excluded.home_node,
      identity_public_key = excluded.identity_public_key,
      messaging_public_key = excluded.messaging_public_key,
      feed_public_key = excluded.feed_public_key,
      document_json = excluded.document_json,
      fingerprint_json = excluded.fingerprint_json,
      updated_at = excluded.updated_at,
      sequence = excluded.sequence,
      signature = excluded.signature
  `).run({
    handle: document.handle,
    canonicalId,
    canonical,
    publicKey: identityPublicKey,
    profileUrl,
    fingerUrl,
    inboxUrl,
    homeNode,
    identityPublicKey,
    messagingPublicKey,
    feedPublicKey,
    documentJson: JSON.stringify(document),
    fingerprintJson: JSON.stringify(fingerprint),
    createdAt: document.created_at,
    updatedAt: document.updated_at,
    sequence: document.sequence,
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

export function getIdentityFingerprintByCanonicalId(canonicalId: string): IdentityFingerprint | null {
  const row = db
    .prepare("SELECT * FROM identities WHERE canonical_id = ?")
    .get(canonicalId) as IdentityRow | undefined;

  if (!row) return null;
  return rowToFingerprint(row);
}

function rowToIdentity(row: IdentityRow): RegistryIdentity {
  const storedDocument = parseJson<IdentityDocument>(row.document_json);
  if (storedDocument !== null) {
    return {
      handle: row.handle,
      canonicalId: row.canonical_id,
      document: storedDocument
    };
  }

  const identityPublicKey = row.identity_public_key ?? row.public_key;
  const createdAt = row.created_at ?? row.updated_at;

  return {
    handle: row.handle,
    canonicalId: row.canonical_id,
    document: {
      type: "sudo_identity",
      protocol_version: SUDO_PROTOCOL_VERSION,
      canonical_id: row.canonical_id,
      handle: row.handle,
      home_node: row.home_node ?? "",
      keys: {
        identity: {
          type: "ed25519",
          public_key: identityPublicKey
        },
        messaging: {
          type: "x25519_or_placeholder",
          public_key: row.messaging_public_key ?? "placeholder"
        },
        feed: {
          type: "ed25519",
          public_key: row.feed_public_key ?? identityPublicKey
        }
      },
      delivery_relays: [],
      feed_endpoints: [],
      created_at: createdAt,
      updated_at: row.updated_at,
      sequence: row.sequence ?? 1,
      signature: row.signature,
      canonical: row.canonical,
      public_key: row.public_key,
      profile: row.profile_url,
      finger: row.finger_url,
      inbox: row.inbox_url,
    }
  };
}

function rowToFingerprint(row: IdentityRow): IdentityFingerprint {
  const storedFingerprint = parseJson<IdentityFingerprint>(row.fingerprint_json);
  if (storedFingerprint !== null) return storedFingerprint;
  return generateIdentityGrid(row.identity_public_key ?? row.public_key);
}

function getIdentityPublicKey(document: IdentityDocument): string {
  return document.keys?.identity.public_key ?? document.public_key ?? "";
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

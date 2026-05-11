import { createHash, randomBytes } from "node:crypto";
import { db } from "../storage/db.js";
import { getIdentityByCanonicalId } from "../identity/registry.js";
import type { IdentityDocument } from "../protocol/types.js";

// Session machinery for the client-signed challenge flow. After
// migration step 6 there are no other server-held credentials —
// password hashes, recovery answer hashes, and backup-code hashes
// are all gone, along with the dev_account_access table that stored
// them. createDevSession is called from
// handleIdentitySessionFromChallenge after a signed nonce verifies;
// getIdentityForDevSession resolves a bearer token back to the
// identity document for /api/identity/session.

export type DevSession = {
  token: string;
  expiresAt: string;
};

type SessionRow = {
  canonical_id: string;
  expires_at: string;
};

export function getIdentityForDevSession(token: string): IdentityDocument | null {
  const tokenHash = hashSecret(token);
  const row = db
    .prepare("SELECT canonical_id, expires_at FROM dev_sessions WHERE token_hash = ?")
    .get(tokenHash) as SessionRow | undefined;

  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM dev_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  return getIdentityByCanonicalId(row.canonical_id)?.document ?? null;
}

export function createDevSession(canonicalId: string): DevSession {
  const token = base64Url(randomBytes(32));
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.valueOf() + 7 * 24 * 60 * 60 * 1000);

  // DEV ONLY: this local session token is intentionally simple and exists only
  // for local iteration. Production access should be bound to device-held keys.
  db.prepare(`
    INSERT INTO dev_sessions (
      token_hash,
      canonical_id,
      expires_at,
      created_at
    ) VALUES (?, ?, ?, ?)
  `).run(hashSecret(token), canonicalId, expiresAt.toISOString(), createdAt.toISOString());

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

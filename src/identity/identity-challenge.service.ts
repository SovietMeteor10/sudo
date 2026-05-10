// Single-use, short-TTL nonces for the client-signed session
// bootstrap. The flow:
//
//   1. Browser GETs /api/identity/challenge/:canonical_id
//   2. Server creates a fresh nonce, stores it with an expires_at,
//      returns { nonce, expires_at } to the browser.
//   3. Browser signs canonical_json({ type, canonical_id, nonce })
//      with its locally-held identity private key (already in IDB
//      from createBrowserCryptoAccount).
//   4. Browser POSTs /api/identity/session-from-challenge with
//      { canonical_id, nonce, signature }. Server verifies the
//      signature against the registered identity public key, deletes
//      the nonce (single-use), mints a session via createDevSession.
//
// Replay protection comes for free from the DELETE-on-consume rule:
// the second attempt finds no row. We also delete on EVERY failed
// consume so a stolen-but-not-yet-used nonce is burned by the first
// failed verification attempt.

import { randomBytes } from "node:crypto";
import { db } from "../storage/db.js";

export type IdentityChallenge = {
  nonce: string;
  expires_at: string;
};

const DEFAULT_TTL_SECONDS = 60;

function readTtlSeconds(): number {
  const raw = process.env.SUDO_CHALLENGE_TTL_SECONDS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3600) return DEFAULT_TTL_SECONDS;
  return parsed;
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createChallenge(canonicalId: string): IdentityChallenge {
  // Defensive sweep: drop any rows that this same canonical id has
  // accumulated from rapid retries. A fresh challenge supersedes any
  // older ones; without this a careless caller could grow the table.
  pruneExpired();
  db.prepare("DELETE FROM identity_challenges WHERE canonical_id = ?").run(canonicalId);

  const nonce = base64Url(randomBytes(32));
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.valueOf() + readTtlSeconds() * 1000);

  db.prepare(`
    INSERT INTO identity_challenges (nonce, canonical_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(nonce, canonicalId, expiresAt.toISOString(), createdAt.toISOString());

  return { nonce, expires_at: expiresAt.toISOString() };
}

export type ConsumeOutcome =
  | { ok: true }
  | { ok: false; code: "unknown_nonce" | "mismatched_canonical_id" | "expired_nonce" };

// Atomically pop a nonce and validate it belongs to the claimed
// canonical id and is not yet expired. The row is deleted on EVERY
// outcome — success, mismatch, or expiry — so a leaked nonce cannot
// be probed twice.
export function consumeChallenge(nonce: string, canonicalId: string): ConsumeOutcome {
  type Row = { canonical_id: string; expires_at: string };
  const row = db.prepare("SELECT canonical_id, expires_at FROM identity_challenges WHERE nonce = ?")
    .get(nonce) as Row | undefined;

  if (row === undefined) {
    return { ok: false, code: "unknown_nonce" };
  }

  // Burn the nonce regardless of validity. A wrong canonical id or a
  // stale row is still a single-use credential and must not survive
  // this call.
  db.prepare("DELETE FROM identity_challenges WHERE nonce = ?").run(nonce);

  if (row.canonical_id !== canonicalId) {
    return { ok: false, code: "mismatched_canonical_id" };
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, code: "expired_nonce" };
  }
  return { ok: true };
}

function pruneExpired(): void {
  db.prepare("DELETE FROM identity_challenges WHERE expires_at <= ?")
    .run(new Date().toISOString());
}

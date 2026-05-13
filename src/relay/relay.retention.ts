// Phase 11.1: relay retention sweeper.
//
// Periodic cleanup of short-lived tables:
//   - device_pairing_tokens — pairing codes are 60s TTL; rows past
//     their expires_at have been functionally useless since the
//     moment they expired but still take up disk.
//   - identity_challenges — one-shot challenge nonces with a small
//     TTL; consumed rows are DELETEd inline by the handler, but a
//     never-consumed challenge sits forever otherwise.
//   - dev_sessions — legacy table, kept only for the deprecated
//     /dev/session alias; we still want to expire rows.
//   - relay_envelopes — already expired by expireRelayEnvelopes(),
//     but its current implementation only marks them "expired" +
//     blanks the ciphertext. We add a hard-delete pass for rows
//     that have been in the expired state past a second retention
//     window so the table doesn't grow unboundedly.
//
// Push-subscription pruning is its own concern (push.service.ts
// already drops 410-gone subscriptions when fan-out fails) so we
// don't touch it here.

import { db } from "../storage/db.js";

const EXPIRED_ENVELOPE_HARD_DELETE_HOURS = 72; // double the longest TTL

export type RelayRetentionResult = {
  pairing_tokens_pruned: number;
  identity_challenges_pruned: number;
  dev_sessions_pruned: number;
  expired_envelopes_hard_deleted: number;
};

export function runRelayRetentionSweep(now: Date = new Date()): RelayRetentionResult {
  const nowIso = now.toISOString();
  const expiredEnvelopeCutoff = new Date(now.valueOf() - EXPIRED_ENVELOPE_HARD_DELETE_HOURS * 60 * 60 * 1000).toISOString();

  const pairing = db.prepare(`DELETE FROM device_pairing_tokens WHERE expires_at <= ?`).run(nowIso);
  const challenges = db.prepare(`DELETE FROM identity_challenges WHERE expires_at <= ?`).run(nowIso);
  const sessions = db.prepare(`DELETE FROM dev_sessions WHERE expires_at <= ?`).run(nowIso);
  const envelopes = db.prepare(`DELETE FROM relay_envelopes WHERE status = 'expired' AND expires_at <= ?`).run(expiredEnvelopeCutoff);

  return {
    pairing_tokens_pruned: pairing.changes,
    identity_challenges_pruned: challenges.changes,
    dev_sessions_pruned: sessions.changes,
    expired_envelopes_hard_deleted: envelopes.changes
  };
}

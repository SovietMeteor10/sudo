// In-process sliding-window rate limit for the client-signed
// challenge endpoints. Two independent buckets per request:
//
//   - per remote IP: caps how aggressively any one peer can hit
//     the challenge or session-from-challenge endpoints. Mostly
//     defends against a noisy/abusive caller eating challenge
//     row inserts.
//   - per canonical id: caps how aggressively any one identity can
//     accumulate outstanding challenges or signature-verify
//     attempts. Mostly defends against an attacker who knows a
//     handle and is trying to brute-force a forged signature.
//
// Both buckets share the same window length and are evaluated on
// every request. A request is rejected (429) only if the relevant
// bucket is full. The pre-existing consume-on-failure behavior in
// consumeChallenge is unchanged: we count the attempt before
// touching the database, so an attacker can't bypass the cap by
// burning challenges.
//
// Single-process in-memory state is intentional. The deploy is one
// node behind nginx; sharing a Map across processes would require
// Redis we don't run. The Map self-prunes by dropping entries with
// no recent activity.

const WINDOW_MS = 60_000;
const PER_IP_LIMIT = 60;
const PER_CANONICAL_LIMIT = 30;
// Keys that have not seen activity within this window are eligible
// for eviction on the next read so the Map can't grow unboundedly
// in long-running processes.
const PRUNE_AFTER_MS = WINDOW_MS * 5;

type Bucket = {
  hits: number[];
};

const ipBuckets = new Map<string, Bucket>();
const canonicalBuckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { ok: true }
  | { ok: false; scope: "ip" | "canonical_id"; retry_after_seconds: number };

export function checkChallengeRate(remoteIp: string, canonicalId: string | null, now: number = Date.now()): RateLimitResult {
  const ipKey = remoteIp.length > 0 ? remoteIp : "unknown";
  const ipResult = countAndCheck(ipBuckets, ipKey, now, PER_IP_LIMIT);
  if (!ipResult.ok) return { ok: false, scope: "ip", retry_after_seconds: ipResult.retry_after_seconds };
  if (canonicalId !== null && canonicalId.length > 0) {
    const canonicalResult = countAndCheck(canonicalBuckets, canonicalId, now, PER_CANONICAL_LIMIT);
    if (!canonicalResult.ok) {
      return { ok: false, scope: "canonical_id", retry_after_seconds: canonicalResult.retry_after_seconds };
    }
  }
  return { ok: true };
}

// Test-only entry point. Resets both buckets so a smoke can iterate
// without bleeding state across cases. Not exported for production
// callers; an attacker who could call it could already wipe limits
// trivially in any number of other ways.
export function __resetChallengeRateLimitForTests(): void {
  ipBuckets.clear();
  canonicalBuckets.clear();
}

function countAndCheck(buckets: Map<string, Bucket>, key: string, now: number, limit: number): { ok: true } | { ok: false; retry_after_seconds: number } {
  pruneIfStale(buckets, now);
  const bucket = buckets.get(key) ?? { hits: [] };
  // Drop hits that fell out of the window.
  const cutoff = now - WINDOW_MS;
  const fresh: number[] = [];
  for (const ts of bucket.hits) {
    if (ts > cutoff) fresh.push(ts);
  }
  if (fresh.length >= limit) {
    // Suggest retrying once the oldest hit ages out.
    const oldest = fresh[0]!;
    const retryAfterMs = (oldest + WINDOW_MS) - now;
    bucket.hits = fresh;
    buckets.set(key, bucket);
    return { ok: false, retry_after_seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  fresh.push(now);
  bucket.hits = fresh;
  buckets.set(key, bucket);
  return { ok: true };
}

let lastPruneAt = 0;
function pruneIfStale(buckets: Map<string, Bucket>, now: number): void {
  if (now - lastPruneAt < PRUNE_AFTER_MS) return;
  lastPruneAt = now;
  const cutoff = now - PRUNE_AFTER_MS;
  for (const [key, bucket] of buckets) {
    const lastHit = bucket.hits.length === 0 ? 0 : bucket.hits[bucket.hits.length - 1]!;
    if (lastHit <= cutoff) buckets.delete(key);
  }
}

// In-process sliding-window limiter for the push subscription
// routes. Caps how often a single IP / single owner can churn
// subscriptions, to bound damage from a misbehaving client.
//
// Mirrors the shape of owner-read-rate-limit.ts so a smoke can
// assert on the same 429 envelope.
//
// Limits:
//   POST/DELETE /api/push/subscriptions
//     per-IP   : 60 / min  (browsers re-subscribe ~once per sign-in)
//     per-owner: 30 / min  (subscription churn on a real account is rare)

const WINDOW_MS = 60_000;
const PER_IP_LIMIT = 60;
const PER_OWNER_LIMIT = 30;
const PRUNE_AFTER_MS = WINDOW_MS * 5;

type Bucket = { hits: number[] };

const ipBuckets = new Map<string, Bucket>();
const ownerBuckets = new Map<string, Bucket>();

export type PushRateResult =
  | { ok: true }
  | { ok: false; scope: "ip" | "owner_canonical_id"; retry_after_seconds: number };

export function checkPushSubscriptionRate(
  remoteIp: string,
  ownerCanonicalId: string | null,
  now: number = Date.now()
): PushRateResult {
  const ipKey = remoteIp.length > 0 ? remoteIp : "unknown";
  const ipResult = countAndCheck(ipBuckets, ipKey, now, PER_IP_LIMIT);
  if (!ipResult.ok) return { ok: false, scope: "ip", retry_after_seconds: ipResult.retry_after_seconds };
  if (ownerCanonicalId !== null && ownerCanonicalId.length > 0) {
    const ownerResult = countAndCheck(ownerBuckets, ownerCanonicalId, now, PER_OWNER_LIMIT);
    if (!ownerResult.ok) {
      return { ok: false, scope: "owner_canonical_id", retry_after_seconds: ownerResult.retry_after_seconds };
    }
  }
  return { ok: true };
}

export function __resetPushRateLimitForTests(): void {
  ipBuckets.clear();
  ownerBuckets.clear();
}

function countAndCheck(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  limit: number
): { ok: true } | { ok: false; retry_after_seconds: number } {
  pruneIfStale(buckets, now);
  const bucket = buckets.get(key) ?? { hits: [] };
  const cutoff = now - WINDOW_MS;
  const fresh: number[] = [];
  for (const ts of bucket.hits) if (ts > cutoff) fresh.push(ts);
  if (fresh.length >= limit) {
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

// In-process rate limit for the pairing handoff endpoints. Mirrors
// the shape of src/identity/challenge-rate-limit.ts. Two buckets
// per request:
//
//   - per remote IP: caps how aggressively any one peer can hit
//     the handoff endpoints. Mostly defends against someone
//     trying to brute-force a 12-char pairing code in the 5-minute
//     TTL window.
//   - per pairing code: even a single IP shouldn't be able to
//     fish for the same code with hundreds of variations within
//     the TTL window.
//
// The handoff bundle's confidentiality ultimately rests on
// PBKDF2(pairing_code) wrapping the already-passphrase-encrypted
// crypto_account bundle, so even if an attacker hits the relay
// they still face two layers of PBKDF2. This limiter is the cheap
// first line.

const WINDOW_MS = 60_000;
const PER_IP_LIMIT = 30;
const PER_CODE_LIMIT = 10;
const PRUNE_AFTER_MS = WINDOW_MS * 5;

type Bucket = { hits: number[] };

const ipBuckets = new Map<string, Bucket>();
const codeBuckets = new Map<string, Bucket>();

export type PairHandoffRateResult =
  | { ok: true }
  | { ok: false; scope: "ip" | "pairing_code"; retry_after_seconds: number };

export function checkPairHandoffRate(remoteIp: string, pairingCode: string | null, now: number = Date.now()): PairHandoffRateResult {
  const ipKey = remoteIp.length > 0 ? remoteIp : "unknown";
  const ipResult = countAndCheck(ipBuckets, ipKey, now, PER_IP_LIMIT);
  if (!ipResult.ok) return { ok: false, scope: "ip", retry_after_seconds: ipResult.retry_after_seconds };
  if (pairingCode !== null && pairingCode.length > 0) {
    const codeResult = countAndCheck(codeBuckets, pairingCode, now, PER_CODE_LIMIT);
    if (!codeResult.ok) {
      return { ok: false, scope: "pairing_code", retry_after_seconds: codeResult.retry_after_seconds };
    }
  }
  return { ok: true };
}

export function __resetPairHandoffRateLimitForTests(): void {
  ipBuckets.clear();
  codeBuckets.clear();
}

function countAndCheck(buckets: Map<string, Bucket>, key: string, now: number, limit: number): { ok: true } | { ok: false; retry_after_seconds: number } {
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

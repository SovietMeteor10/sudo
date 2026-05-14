// Ephemeral typing indicators for 1:1 chats.
//
// DELIBERATELY NOT PERSISTED. No SQLite write, no device_sync_log,
// no relay envelope queue, no push fan-out. The only state is a
// per-process in-memory map with a short TTL — losing it on a node
// restart is a feature, not a bug.
//
// Wire contract:
//   POST /api/typing
//     body: { sender_canonical_id, recipient_canonical_id, typing }
//     - typing=true sets / refreshes a "<sender> is typing to
//       <recipient>" entry with a 6s TTL.
//     - typing=false clears the entry immediately.
//     - returns { ok: true }
//
//   GET  /api/typing/:recipient_canonical_id
//     - returns { typing: [{ sender_canonical_id, expires_at }] }
//     - expired entries are pruned on read.
//
// Privacy:
//   - payload carries only sender + recipient + typing bool. No
//     message text, no preview, no conversation_id.
//   - server logs do not record typing state — it's read-modify-
//     write against an in-process Map.
//   - no push fan-out is triggered.
//
// Rate limit:
//   - per-IP only. Typical client sends 1 event per 3s per chat.
//     A user with many concurrent chats might emit ~10/min legit.
//     We cap at 120/min per IP — a slow continuous stream is fine,
//     a flood gets 429.

import express from "express";
import { emitRateLimited } from "../devices/rate-limit-response.js";
import {
  isCanonicalId,
  makeBadRequest
} from "../protocol/validators.js";

export const typingRouter = express.Router();

// recipient → sender → { expires_at }
const typingState = new Map<string, Map<string, { expires_at: number }>>();
const TYPING_TTL_MS = 6_000;

// Per-IP sliding-window rate limit. Reuses the inline pattern from
// the push and owner-read limiters; kept local so the typing module
// stays self-contained.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const ipHits = new Map<string, number[]>();
function rateCheck(ip: string, now: number): { ok: true } | { ok: false; scope: "ip"; retry_after_seconds: number } {
  const key = ip.length > 0 ? ip : "unknown";
  const hits = ipHits.get(key) ?? [];
  const cutoff = now - RATE_WINDOW_MS;
  const fresh: number[] = [];
  for (const t of hits) if (t > cutoff) fresh.push(t);
  if (fresh.length >= RATE_LIMIT) {
    const oldest = fresh[0]!;
    return { ok: false, scope: "ip", retry_after_seconds: Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000)) };
  }
  fresh.push(now);
  ipHits.set(key, fresh);
  return { ok: true };
}

// Phase 14 MED-2: only honor X-Real-IP when the peer is loopback.
import { resolveTrustedIp as resolveIp } from "../node/trusted-ip.js";

function prune(now: number): void {
  for (const [recipient, senders] of typingState) {
    for (const [sender, entry] of senders) {
      if (entry.expires_at <= now) senders.delete(sender);
    }
    if (senders.size === 0) typingState.delete(recipient);
  }
}

typingRouter.post("/", (request, response) => {
  const body = request.body as Partial<{
    sender_canonical_id: string;
    recipient_canonical_id: string;
    typing: boolean;
  }>;
  if (!isCanonicalId(body?.sender_canonical_id)) {
    response.status(400).json(makeBadRequest("sender_canonical_id", "must be a canonical id"));
    return;
  }
  if (!isCanonicalId(body?.recipient_canonical_id)) {
    response.status(400).json(makeBadRequest("recipient_canonical_id", "must be a canonical id"));
    return;
  }
  if (typeof body?.typing !== "boolean") {
    response.status(400).json(makeBadRequest("typing", "must be a boolean"));
    return;
  }
  // Reject self-as-recipient — typing-to-self has no meaning and
  // would let a user pump their own indicators on their own linked
  // devices, which the spec explicitly forbids.
  if (body.sender_canonical_id === body.recipient_canonical_id) {
    response.status(400).json(makeBadRequest("recipient_canonical_id", "cannot equal sender"));
    return;
  }

  const rate = rateCheck(resolveIp(request), Date.now());
  if (!rate.ok) { emitRateLimited(response, rate); return; }

  const now = Date.now();
  let bucket = typingState.get(body.recipient_canonical_id);
  if (body.typing === false) {
    if (bucket !== undefined) {
      bucket.delete(body.sender_canonical_id);
      if (bucket.size === 0) typingState.delete(body.recipient_canonical_id);
    }
    response.json({ ok: true });
    return;
  }
  if (bucket === undefined) {
    bucket = new Map();
    typingState.set(body.recipient_canonical_id, bucket);
  }
  bucket.set(body.sender_canonical_id, { expires_at: now + TYPING_TTL_MS });
  response.json({ ok: true });
});

typingRouter.get("/:recipientCanonicalId", (request, response) => {
  const recipient = request.params.recipientCanonicalId;
  if (!isCanonicalId(recipient)) {
    response.status(400).json(makeBadRequest("recipient_canonical_id", "must be a canonical id"));
    return;
  }
  const rate = rateCheck(resolveIp(request), Date.now());
  if (!rate.ok) { emitRateLimited(response, rate); return; }

  const now = Date.now();
  prune(now);
  const bucket = typingState.get(recipient);
  const typing = bucket === undefined
    ? []
    : [...bucket.entries()].map(([sender, entry]) => ({
        sender_canonical_id: sender,
        expires_at: new Date(entry.expires_at).toISOString()
      }));
  response.json({ typing });
});

// Test-only: drop all typing state. Smoke harness uses this between
// scenarios so cross-test bleed is impossible.
export function __resetTypingStateForTests(): void {
  typingState.clear();
  ipHits.clear();
}

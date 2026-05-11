// Shared 429 emit helper. Every limiter in the codebase returns
// `{ scope, retry_after_seconds }` on rejection; this helper turns
// that into a consistent HTTP response so callers (and the smokes
// asserting on the wire format) see the same shape everywhere:
//
//   HTTP/1.1 429 Too Many Requests
//   Retry-After: <seconds>
//   {
//     "ok": false,
//     "error": "rate_limited",
//     "scope": "ip" | "owner_canonical_id" | "canonical_id" | "pairing_code",
//     "retry_after_seconds": <number>
//   }
//
// Extra fields (e.g. a human-readable `message`) may be passed in
// `extra`; they're merged onto the body but never override the four
// required fields above.

import type { Response } from "express";

type Scope = string;
type Extras = Record<string, unknown>;

export function emitRateLimited(
  response: Response,
  result: { scope: Scope; retry_after_seconds: number },
  extras: Extras = {}
): void {
  response.setHeader("Retry-After", String(result.retry_after_seconds));
  response.status(429).json({
    ...extras,
    ok: false,
    error: "rate_limited",
    scope: result.scope,
    retry_after_seconds: result.retry_after_seconds
  });
}

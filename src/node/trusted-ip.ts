// MED-2: per-IP rate limit bypass guard.
//
// Express trust-proxy is set to "loopback" in app.ts, so request.ip
// correctly returns the upstream peer address ONLY if the immediate
// peer is loopback. Routes in this codebase historically preferred
// X-Real-IP from nginx unconditionally — which lets any caller that
// can reach the app directly (e.g. someone who finds the local-only
// listener port without going through nginx) spoof the header and
// bypass every per-IP bucket.
//
// resolveTrustedIp() returns the X-Real-IP header value if and only
// if the request arrived from loopback. Otherwise it falls back to
// the Express-resolved request.ip. This is the correct posture
// regardless of whether nginx is in front.

import type { Request } from "express";

const LOOPBACK_IPS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1"
]);

export function resolveTrustedIp(request: Request): string {
  const reqIp = request.ip ?? "";
  if (LOOPBACK_IPS.has(reqIp)) {
    const realIp = request.get("x-real-ip");
    if (typeof realIp === "string" && realIp.length > 0) return realIp;
  }
  return reqIp;
}

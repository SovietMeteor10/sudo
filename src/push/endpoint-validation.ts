// SSRF defense for push subscription endpoint URLs.
//
// CRIT-5: the push subscription POST previously accepted any URL that
// started with http(s)://. An attacker registering an endpoint that
// resolves to 169.254.169.254 (AWS metadata), 127.0.0.1, or anything in
// RFC 1918 turned the server into an SSRF proxy on every chat envelope.
//
// This module classifies a resolved IP against the IANA reserved /
// private ranges and rejects anything that isn't unambiguously public.
// We resolve the hostname once at subscription time. DNS rebinding can
// still flip a previously-public host to private after subscription;
// closing that door requires per-request resolution + IP pinning, which
// is a larger change we intentionally defer.

import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";

export type EndpointValidationResult =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: "invalid_url" | "scheme_not_https" | "private_address" | "dns_failure" };

// IPv4 reserved/private/special-use ranges (RFC 1122, 1918, 6890, etc.)
// Each entry is [startInt32, endInt32, label]. We pack and unpack the
// dotted-quad form on the fly so we don't carry a bignum dep.
const IPV4_RESERVED: Array<[number, number]> = [
  [ipv4("0.0.0.0"), ipv4("0.255.255.255")],
  [ipv4("10.0.0.0"), ipv4("10.255.255.255")],
  [ipv4("100.64.0.0"), ipv4("100.127.255.255")],         // CGNAT
  [ipv4("127.0.0.0"), ipv4("127.255.255.255")],          // loopback
  [ipv4("169.254.0.0"), ipv4("169.254.255.255")],        // link-local (incl AWS metadata)
  [ipv4("172.16.0.0"), ipv4("172.31.255.255")],
  [ipv4("192.0.0.0"), ipv4("192.0.0.255")],
  [ipv4("192.0.2.0"), ipv4("192.0.2.255")],              // TEST-NET-1
  [ipv4("192.88.99.0"), ipv4("192.88.99.255")],          // 6to4 relay
  [ipv4("192.168.0.0"), ipv4("192.168.255.255")],
  [ipv4("198.18.0.0"), ipv4("198.19.255.255")],          // benchmarking
  [ipv4("198.51.100.0"), ipv4("198.51.100.255")],        // TEST-NET-2
  [ipv4("203.0.113.0"), ipv4("203.0.113.255")],          // TEST-NET-3
  [ipv4("224.0.0.0"), ipv4("239.255.255.255")],          // multicast
  [ipv4("240.0.0.0"), ipv4("255.255.255.255")]           // reserved + broadcast
];

function ipv4(dotted: string): number {
  const parts = dotted.split(".");
  let result = 0;
  for (const part of parts) {
    result = (result * 256 + Number(part)) >>> 0;
  }
  return result;
}

function isReservedIPv4(addr: string): boolean {
  const value = ipv4(addr);
  for (const [start, end] of IPV4_RESERVED) {
    if (value >= start && value <= end) return true;
  }
  return false;
}

function isReservedIPv6(addr: string): boolean {
  const normalized = addr.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // Loopback / unspecified
  if (normalized === "::1" || normalized === "::") return true;
  // IPv4-mapped (::ffff:a.b.c.d): defer to v4 classifier on the embedded address
  const mapped = /^::ffff:(?:\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) {
    const v4 = normalized.split(":").pop() ?? "";
    if (isIP(v4) === 4) return isReservedIPv4(v4);
  }
  // Unique local (fc00::/7) — first byte 0xfc or 0xfd
  if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/.test(normalized)) return true;
  // Link-local (fe80::/10) — first 10 bits = 1111111010
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // Site-local deprecated but still classify (fec0::/10)
  if (/^fe[cdef][0-9a-f]:/.test(normalized)) return true;
  // Multicast (ff00::/8)
  if (normalized.startsWith("ff")) return true;
  return false;
}

export function isReservedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isReservedIPv4(addr);
  if (kind === 6) return isReservedIPv6(addr);
  return false;
}

export async function validatePushEndpoint(rawUrl: string): Promise<EndpointValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  // Push providers (FCM, Apple, Mozilla, Microsoft) all serve over
  // https. Allowing http here is a footgun and there's no legitimate
  // reason a production push endpoint would be plaintext.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "scheme_not_https" };
  }

  const hostname = parsed.hostname;
  // Strip IPv6 brackets if URL is http://[::1]:8080/...
  const cleanHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // If the host is already a literal IP, validate it directly. No DNS.
  if (isIP(cleanHost) !== 0) {
    if (isReservedAddress(cleanHost)) {
      return { ok: false, reason: "private_address" };
    }
    return { ok: true, addresses: [cleanHost] };
  }

  // Hostname — resolve to all A/AAAA records and validate each.
  // A push provider that uses split-horizon DNS isn't a thing we want
  // to support; rejecting if ANY resolved IP is private is the right
  // SSRF posture.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsPromises.lookup(cleanHost, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "dns_failure" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "dns_failure" };
  }
  for (const { address } of addresses) {
    if (isReservedAddress(address)) {
      return { ok: false, reason: "private_address" };
    }
  }
  return { ok: true, addresses: addresses.map((a) => a.address) };
}

// Canonical input validators.
//
// The server and client must agree on the wire shape of identifiers
// at the network boundary. Before this module the regexes existed in
// only one place (canonical_id) or implicitly via "any non-empty
// string" (device_id, pairing_code, relay message_id), which made it
// easy for a malformed input to traverse half the routing pipeline
// before being rejected — and for two routes to disagree about what
// "valid" meant.
//
// Rules:
//   - Validators take an unknown and return a string-narrowed boolean
//     so call sites can use them as type guards.
//   - Each validator's failure mode is a 400 with a stable error code
//     produced by makeBadRequest(...) so a smoke can lock the shape.
//   - The same module is bundled into the client by the build, so
//     pre-flight checks at form submission use the exact same rules
//     that the server uses post-fact.

import { CANONICAL_ID_PATTERN } from "./identity.js";

// ---- ID patterns -----------------------------------------------------------

// canonical_id: sudo:<key-type>:<sha256 hex>
export function isCanonicalId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > 256) return false;
  return CANONICAL_ID_PATTERN.test(value);
}

// device_id: 32-character lowercase hex. Clients generate via
// crypto.randomUUID().replace(/-/g, "") so the value is always 32
// hex chars. We accept a UUID with hyphens too because some early
// devices emitted that shape; both normalise to the same identifier.
const DEVICE_ID_HEX = /^[0-9a-f]{32}$/i;
const DEVICE_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isDeviceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > 64) return false;
  return DEVICE_ID_HEX.test(value) || DEVICE_ID_UUID.test(value);
}

// pairing_code: human-readable XXXXXX-XXXXXX where X is 0-9 / A-Z (no
// confusable chars). devices.store.ts produces upper-case 12-char
// alphanumeric with one centre hyphen.
const PAIRING_CODE = /^[A-Z0-9]{6}-[A-Z0-9]{6}$/;
export function isPairingCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return PAIRING_CODE.test(value);
}

// relay message_id: any UUID-like opaque string up to 64 chars,
// permissive on punctuation so we tolerate both v4 UUIDs and the
// dev-placeholder format.
const RELAY_MESSAGE_ID = /^[A-Za-z0-9_:-]{8,64}$/;
export function isRelayMessageId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return RELAY_MESSAGE_ID.test(value);
}

// handle: client-input "@alice" or "alice"; we strip the leading @
// elsewhere. Constrained to 1-32 chars of [a-z0-9_-].
const HANDLE = /^@?[a-z0-9_-]{1,32}$/i;
export function isHandle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return HANDLE.test(value);
}

// ---- error shape -----------------------------------------------------------

export type BadRequestBody = {
  ok: false;
  error: "invalid_field";
  field: string;
  message: string;
};

export function makeBadRequest(field: string, message: string): BadRequestBody {
  return { ok: false, error: "invalid_field", field, message };
}

// Convenience guards that produce a BadRequestBody when the value is
// invalid. Routes can do:
//   const v = requireCanonicalId(body.owner_canonical_id, "owner_canonical_id");
//   if (!v.ok) return response.status(400).json(v.body);
// Saves a few lines per route AND keeps the error code uniform.
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; body: BadRequestBody };

export function requireCanonicalId(value: unknown, field: string): Validated<string> {
  return isCanonicalId(value)
    ? { ok: true, value }
    : { ok: false, body: makeBadRequest(field, "must be a sudo:<key>:<hex64> canonical id") };
}

export function requireDeviceId(value: unknown, field: string): Validated<string> {
  return isDeviceId(value)
    ? { ok: true, value }
    : { ok: false, body: makeBadRequest(field, "must be a 32-hex device id") };
}

export function requirePairingCode(value: unknown, field: string): Validated<string> {
  return isPairingCode(value)
    ? { ok: true, value }
    : { ok: false, body: makeBadRequest(field, "must be XXXXXX-XXXXXX") };
}

export function requireRelayMessageId(value: unknown, field: string): Validated<string> {
  return isRelayMessageId(value)
    ? { ok: true, value }
    : { ok: false, body: makeBadRequest(field, "must be a relay message id") };
}

// ---- helpers used by routes for primitive checks --------------------------

export function isNonEmptyString(value: unknown, maxLen = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

export function isBoundedString(value: unknown, maxLen = 65536): value is string {
  return typeof value === "string" && value.length <= maxLen;
}

export function isFiniteInt(value: unknown, opts: { min?: number; max?: number } = {}): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  if (opts.min !== undefined && value < opts.min) return false;
  if (opts.max !== undefined && value > opts.max) return false;
  return true;
}

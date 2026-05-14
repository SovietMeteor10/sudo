// Client side of the per-request signed-payload auth scheme.
//
// Companion to src/identity/request-auth.ts on the server. See that
// file for the full wire format. In short: every write request gets
// an X-Sudo-Auth header containing { canonical_id, [device_id,] ts,
// nonce, signature }, where the signature is over the canonical JSON
// of the request method, path, body digest, signer identifiers,
// timestamp, and nonce.
//
// Two signer flavors:
//   - identitySigner — proves caller controls the canonical_id's
//     identity key. Used for connection/relationship writes, push
//     subscription writes, notification reads, feed deletes, etc.
//   - deviceSigner — proves caller controls a specific device's
//     device key under a known owner. Used for the relay inbox
//     read, the relay ack, the trusted-device sync log routes.

import type { SigningKeyType } from "../../../protocol/types.js";
import { base64Url, randomBytes } from "../local/crypto.js";
import { canonicalJson } from "./signing.js";
import { getUnlockedBrowserCryptoAccount } from "./key-storage.js";

const NONCE_BYTES = 16;

export type IdentitySigner = {
  kind: "identity";
  canonicalId: string;
  privateKey: CryptoKey;
  keyType: SigningKeyType;
};

export type DeviceSigner = {
  kind: "device";
  canonicalId: string;
  deviceId: string;
  privateKey: CryptoKey;
  keyType: SigningKeyType;
};

export type RequestSigner = IdentitySigner | DeviceSigner;

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(digest);
}

async function signRaw(payload: unknown, privateKey: CryptoKey, keyType: SigningKeyType): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(payload));
  const algorithm: AlgorithmIdentifier | EcdsaParams = keyType === "ecdsa-p256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "Ed25519" } as AlgorithmIdentifier;
  const signature = await crypto.subtle.sign(algorithm as any, privateKey, data);
  return base64Url(signature);
}

function nonce(): string {
  return base64Url(randomBytes(NONCE_BYTES));
}

// Reads the current in-memory unlocked account and constructs an
// identity-signer view of it. Returns null if the account is locked
// (page reload before unlock, or signed-out state). Callers that need
// to throw on missing sig should test for null themselves; the wrapper
// signedFetchAsIdentity() does this with a stable error message.
export function getCurrentIdentitySigner(): IdentitySigner | null {
  const account = getUnlockedBrowserCryptoAccount();
  if (account === null) return null;
  return {
    kind: "identity",
    canonicalId: account.canonical_id,
    privateKey: account.identity_key,
    keyType: account.identity_key_type
  };
}

// Same shape for device-signed requests (relay inbox read, relay ack,
// sync log). The caller supplies device_id because it lives outside
// the crypto account bundle (see ensureCurrentDeviceId in main.ts).
export function getCurrentDeviceSigner(deviceId: string): DeviceSigner | null {
  const account = getUnlockedBrowserCryptoAccount();
  if (account === null) return null;
  return {
    kind: "device",
    canonicalId: account.canonical_id,
    deviceId,
    // device_key_type is not stored on BrowserCryptoAccount today; the
    // device keypair shares the identity-key algorithm (see
    // createBrowserCryptoAccount). If we ever split them, expose a
    // device_key_type field on the account and read it here.
    privateKey: account.device_key,
    keyType: account.identity_key_type
  };
}

export class MissingSignerError extends Error {
  constructor(public readonly kind: "identity" | "device") {
    super(`no unlocked account; cannot sign ${kind} request`);
    this.name = "MissingSignerError";
  }
}

// Helper: signed fetch using the current unlocked identity. Throws
// MissingSignerError if the account is locked. Use this from api.ts
// write functions rather than threading a signer through every call.
export async function signedFetchAsIdentity(options: {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response> {
  const signer = getCurrentIdentitySigner();
  if (signer === null) throw new MissingSignerError("identity");
  return signedFetch({ ...options, signer });
}

export async function signedFetchAsDevice(options: {
  method: string;
  path: string;
  deviceId: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response> {
  const signer = getCurrentDeviceSigner(options.deviceId);
  if (signer === null) throw new MissingSignerError("device");
  return signedFetch({
    method: options.method,
    path: options.path,
    body: options.body,
    headers: options.headers,
    signal: options.signal,
    signer
  });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Strip query string and trailing slash so client and server agree on
// the signed `path` value.
function normalizePath(rawPath: string): string {
  const queryIndex = rawPath.indexOf("?");
  const noQuery = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

// Build the X-Sudo-Auth header value for a given request. Exported
// for tests and for any caller that needs to attach the header to a
// custom fetch (e.g. multipart upload, streamed response).
export async function buildSudoAuthHeader(options: {
  method: string;
  path: string;
  body: unknown;
  signer: RequestSigner;
}): Promise<string> {
  const normalizedPath = normalizePath(options.path);
  const ts = nowSeconds();
  const nonceValue = nonce();
  const bodyDigest = await sha256Base64Url(canonicalJson(options.body ?? null));

  const signedPayload: Record<string, unknown> = {
    type: "sudo_request_auth",
    method: options.method.toUpperCase(),
    path: normalizedPath,
    body_digest: bodyDigest,
    canonical_id: options.signer.canonicalId,
    ts,
    nonce: nonceValue
  };
  if (options.signer.kind === "device") {
    signedPayload.device_id = options.signer.deviceId;
  }

  const signature = await signRaw(signedPayload, options.signer.privateKey, options.signer.keyType);

  const headerJson: Record<string, unknown> = {
    canonical_id: options.signer.canonicalId,
    ts,
    nonce: nonceValue,
    signature
  };
  if (options.signer.kind === "device") {
    headerJson.device_id = options.signer.deviceId;
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(headerJson));
  return base64Url(headerBytes);
}

// Wrapper around fetch that automatically computes the X-Sudo-Auth
// header. The body is sent as JSON (or omitted for GET/HEAD). For
// custom content types (multipart, octet-stream) use buildSudoAuthHeader
// directly.
export async function signedFetch(options: {
  method: string;
  path: string;
  body?: unknown;
  signer: RequestSigner;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response> {
  const method = options.method.toUpperCase();
  // The body the signature commits to. We sign null when no body was
  // provided, matching the server's bodyDigest normalization for
  // empty-body requests. The wire body is omitted entirely so
  // express.json (strict mode) doesn't reject a literal "null"
  // payload.
  const hasExplicitBody = method !== "GET" && method !== "HEAD"
    && options.body !== undefined && options.body !== null;
  const signedBody = hasExplicitBody ? options.body : null;
  const wireBody = hasExplicitBody ? canonicalJson(signedBody) : undefined;

  const headerValue = await buildSudoAuthHeader({
    method,
    path: options.path,
    body: signedBody,
    signer: options.signer
  });

  const headers: Record<string, string> = {
    "x-sudo-auth": headerValue,
    ...options.headers
  };
  if (hasExplicitBody) headers["content-type"] = "application/json";

  return fetch(options.path, {
    method,
    headers,
    body: wireBody,
    signal: options.signal
  });
}

// Smoke helper: build a Phase-14 X-Sudo-Auth header value for a
// request. Mirrors src/identity/request-auth.ts on the server and
// src/web/client/crypto/request-auth.ts on the client.
//
// Usage:
//   const { signIdentityRequest, signDeviceRequest } = require("./lib/request-auth-helpers.cjs");
//   const header = signIdentityRequest({
//     method: "POST",
//     path: "/api/connections",
//     body: { owner_canonical_id: id.canonical_id, ... },
//     canonicalId: id.canonical_id,
//     privateKey: id.identity_key.privateKey      // node:crypto KeyObject
//   });
//   fetch(BASE + "/api/connections", {
//     method: "POST",
//     headers: { "content-type": "application/json", "x-sudo-auth": header },
//     body: JSON.stringify(body)
//   });

const { createHash, sign: nodeSign, randomBytes } = require("node:crypto");

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function bodyDigest(body) {
  const json = canonicalJson(body ?? null);
  return createHash("sha256").update(json).digest("base64url");
}

function normalizePath(rawPath) {
  const q = rawPath.indexOf("?");
  const noQuery = q === -1 ? rawPath : rawPath.slice(0, q);
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

function buildSignedHeader(opts) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? base64Url(randomBytes(16));
  const path = normalizePath(opts.path);
  const signedPayload = {
    type: "sudo_request_auth",
    method: opts.method.toUpperCase(),
    path,
    body_digest: bodyDigest(opts.body),
    canonical_id: opts.canonicalId,
    ts,
    nonce
  };
  if (opts.deviceId !== undefined) signedPayload.device_id = opts.deviceId;
  const signature = base64Url(
    nodeSign(null, Buffer.from(canonicalJson(signedPayload)), opts.privateKey)
  );
  const headerJson = { canonical_id: opts.canonicalId, ts, nonce, signature };
  if (opts.deviceId !== undefined) headerJson.device_id = opts.deviceId;
  return base64Url(Buffer.from(JSON.stringify(headerJson)));
}

function signIdentityRequest(opts) {
  return buildSignedHeader({
    method: opts.method,
    path: opts.path,
    body: opts.body,
    canonicalId: opts.canonicalId,
    privateKey: opts.privateKey,
    ts: opts.ts,
    nonce: opts.nonce
  });
}

function signDeviceRequest(opts) {
  return buildSignedHeader({
    method: opts.method,
    path: opts.path,
    body: opts.body,
    canonicalId: opts.canonicalId,
    deviceId: opts.deviceId,
    privateKey: opts.privateKey,
    ts: opts.ts,
    nonce: opts.nonce
  });
}

// Convenience fetch wrappers for smokes. Match the {status, body}
// return shape that the existing smokes' postJson/getJson use, so
// migration is a 1:1 swap of the call site.

async function smokeFetch(baseUrl, method, path, opts) {
  const init = { method, headers: { accept: "application/json", ...(opts?.headers ?? {}) } };
  if (opts?.bodyJson !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.bodyJson);
  }
  const r = await fetch(baseUrl.replace(/\/$/, "") + path, init);
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

// Device-signed GET. `signer` is {canonicalId, deviceId, privateKey}.
async function getJsonSignedDevice(baseUrl, path, signer) {
  const header = signDeviceRequest({
    method: "GET",
    path,
    body: null,
    canonicalId: signer.canonicalId,
    deviceId: signer.deviceId,
    privateKey: signer.privateKey
  });
  return smokeFetch(baseUrl, "GET", path, { headers: { "x-sudo-auth": header } });
}

// Device-signed POST.
async function postJsonSignedDevice(baseUrl, path, bodyJson, signer) {
  const header = signDeviceRequest({
    method: "POST",
    path,
    body: bodyJson,
    canonicalId: signer.canonicalId,
    deviceId: signer.deviceId,
    privateKey: signer.privateKey
  });
  return smokeFetch(baseUrl, "POST", path, { headers: { "x-sudo-auth": header }, bodyJson });
}

// Identity-signed GET.
async function getJsonSignedIdentity(baseUrl, path, signer) {
  const header = signIdentityRequest({
    method: "GET",
    path,
    body: null,
    canonicalId: signer.canonicalId,
    privateKey: signer.privateKey
  });
  return smokeFetch(baseUrl, "GET", path, { headers: { "x-sudo-auth": header } });
}

// Identity-signed POST.
async function postJsonSignedIdentity(baseUrl, path, bodyJson, signer) {
  const header = signIdentityRequest({
    method: "POST",
    path,
    body: bodyJson,
    canonicalId: signer.canonicalId,
    privateKey: signer.privateKey
  });
  return smokeFetch(baseUrl, "POST", path, { headers: { "x-sudo-auth": header }, bodyJson });
}

// Identity-signed DELETE.
async function deleteJsonSignedIdentity(baseUrl, path, bodyJson, signer) {
  const header = signIdentityRequest({
    method: "DELETE",
    path,
    body: bodyJson ?? null,
    canonicalId: signer.canonicalId,
    privateKey: signer.privateKey
  });
  return smokeFetch(baseUrl, "DELETE", path, { headers: { "x-sudo-auth": header }, bodyJson });
}

module.exports = {
  signIdentityRequest,
  signDeviceRequest,
  buildSignedHeader,
  bodyDigest,
  canonicalJson,
  base64Url,
  getJsonSignedDevice,
  postJsonSignedDevice,
  getJsonSignedIdentity,
  postJsonSignedIdentity,
  deleteJsonSignedIdentity
};

import type {
  ConnectionRelationship,
  DiscoveryMode,
  DiscoveryPostIndex,
  DiscoveryReaction,
  DeviceSyncEvent,
  FeedPost,
  FeedSubscription,
  IdentityDocument,
  NodeCapabilityDocument,
  TrustedDevice,
  SearchResult
} from "./types.js";

export async function lookupHandle(query: string, signal: AbortSignal): Promise<IdentityDocument> {
  const handle = normalizeLookupInput(query);
  const response = await fetchWithTimeout(`/.well-known/handles/${encodeURIComponent(handle)}`, {
    headers: { accept: "application/json" },
    signal,
  });

  if (response.status === 404) {
    throw new Error("handle not found");
  }

  if (response.status === 400) {
    throw new Error("invalid handle");
  }

  if (!response.ok) {
    throw new Error(`lookup failed: ${response.status}`);
  }

  return response.json() as Promise<IdentityDocument>;
}

export async function getNodeDocument(): Promise<NodeCapabilityDocument> {
  const response = await fetchWithTimeout("/.well-known/sudo/node.json", {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`node metadata failed: ${response.status}`);
  }

  return response.json() as Promise<NodeCapabilityDocument>;
}

export async function listTrustedDevices(ownerCanonicalId: string): Promise<TrustedDevice[]> {
  const response = await fetchWithTimeout(`/api/devices/${encodeURIComponent(ownerCanonicalId)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`device list failed: ${response.status}`);
  }

  const body = await response.json() as { devices?: TrustedDevice[] };
  return Array.isArray(body.devices) ? body.devices : [];
}

export async function registerTrustedDevice(input: TrustedDevice): Promise<TrustedDevice> {
  const response = await fetchWithTimeout("/api/devices/register", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  const body = await response.json() as { ok?: boolean; device?: TrustedDevice; error?: string };
  if (response.ok && body.device !== undefined) {
    return body.device;
  }

  throw new Error(body.error ?? `device registration failed: ${response.status}`);
}

export async function startDevicePairing(ownerCanonicalId: string): Promise<{ pairing_code: string; pairing_token: string; expires_at: string }> {
  const response = await fetchWithTimeout("/api/devices/pair/start", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ owner_canonical_id: ownerCanonicalId })
  });

  const body = await response.json() as { ok?: boolean; pairing_code?: string; pairing_token?: string; expires_at?: string; error?: string };
  if (response.ok && body.pairing_code && body.pairing_token && body.expires_at) {
    return { pairing_code: body.pairing_code, pairing_token: body.pairing_token, expires_at: body.expires_at };
  }

  throw new Error(body.error ?? `device pairing start failed: ${response.status}`);
}

export async function completeDevicePairing(input: {
  pairing_code: string;
  device_id: string;
  name: string;
  device_public_key: string;
  encrypted_bootstrap_payload: string;
}): Promise<{ ok: true; device: TrustedDevice; pairing_code: string }> {
  const response = await fetchWithTimeout("/api/devices/pair/complete", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  const body = await response.json() as { ok?: boolean; device?: TrustedDevice; pairing_code?: string; error?: string };
  if (response.ok && body.device !== undefined && body.pairing_code !== undefined) {
    return { ok: true, device: body.device, pairing_code: body.pairing_code };
  }

  throw new Error(body.error ?? `device pairing complete failed: ${response.status}`);
}

export async function revokeTrustedDevice(ownerCanonicalId: string, deviceId: string): Promise<TrustedDevice> {
  const response = await fetchWithTimeout(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ owner_canonical_id: ownerCanonicalId })
  });

  const body = await response.json() as { ok?: boolean; device?: TrustedDevice; error?: string };
  if (response.ok && body.device !== undefined) {
    return body.device;
  }

  throw new Error(body.error ?? `device revoke failed: ${response.status}`);
}

export async function registerIdentityDocument(identityDocument: IdentityDocument): Promise<IdentityDocument> {
  const response = await fetchWithTimeout("/api/identity/register", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ identity_document: identityDocument })
  });

  const body = await response.json() as { identity?: IdentityDocument; message?: string };
  if (response.ok && body.identity !== undefined) return body.identity;
  throw new Error(body.message ?? `identity registration failed: ${response.status}`);
}

export type SignupDevResponse = {
  identity: IdentityDocument;
  backupCode: string;
  sessionToken: string;
};

export type SigninDevResponse = {
  identity: IdentityDocument;
  sessionToken: string;
  expiresAt: string;
};

export async function signupDevHandle(
  handle: string,
  password: string,
  recoveryQuestion: string,
  recoveryAnswer: string
): Promise<SignupDevResponse> {
  const response = await fetchWithTimeout("/dev/signup", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ handle, password, recoveryQuestion, recoveryAnswer }),
  });

  if (response.ok) {
    return response.json() as Promise<SignupDevResponse>;
  }

  const errorBody = await readErrorBody(response);
  throw new Error(errorBody.message);
}

export async function recoverDevHandle(
  handle: string,
  backupCode: string,
  recoveryQuestion: string,
  recoveryAnswer: string
): Promise<SigninDevResponse> {
  const response = await fetchWithTimeout("/dev/recover", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ handle, backupCode, recoveryQuestion, recoveryAnswer }),
  });

  if (response.ok) {
    return response.json() as Promise<SigninDevResponse>;
  }

  const errorBody = await readErrorBody(response);
  throw new Error(errorBody.message);
}

export async function signinDevHandle(handle: string, password: string): Promise<SigninDevResponse> {
  const response = await fetchWithTimeout("/dev/signin", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      handle,
      password,
    }),
  });

  if (response.ok) {
    return response.json() as Promise<SigninDevResponse>;
  }

  const errorBody = await readErrorBody(response);
  throw new Error(errorBody.message);
}

export async function restoreDevSession(token: string): Promise<IdentityDocument> {
  const response = await fetchWithTimeout("/dev/session", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });

  if (response.ok) {
    return response.json() as Promise<IdentityDocument>;
  }

  const errorBody = await readErrorBody(response);
  throw new Error(errorBody.message);
}

export class NetworkTimeoutError extends Error {
  constructor() {
    super("network timeout");
    this.name = "NetworkTimeoutError";
  }
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new NetworkTimeoutError();
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function searchHandles(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const handle = normalizeLookupInput(query);
  const response = await fetchWithTimeout(`/dev/search-handles?q=${encodeURIComponent(handle)}`, {
    headers: { accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`search failed: ${response.status}`);
  }

  const body = await response.json() as { results?: SearchResult[] };
  return Array.isArray(body.results) ? body.results : [];
}

export async function getConnectionRelationship(
  ownerCanonicalId: string,
  subjectCanonicalId: string
): Promise<ConnectionRelationship> {
  const response = await fetchWithTimeout(`/api/connections/${encodeURIComponent(ownerCanonicalId)}/${encodeURIComponent(subjectCanonicalId)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`connection lookup failed: ${response.status}`);
  }

  const body = await response.json() as { relationship?: ConnectionRelationship };
  if (body.relationship === undefined) {
    throw new Error("connection lookup failed");
  }

  return body.relationship;
}

export async function upsertConnectionRelationship(input: {
  owner_canonical_id: string;
  subject_canonical_id: string;
  subject_handle?: string;
  tier: "unknown" | "known" | "close" | "blocked";
  subscribed?: boolean;
  notes?: string;
}): Promise<ConnectionRelationship> {
  const response = await fetchWithTimeout("/api/connections", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  const body = await response.json() as { relationship?: ConnectionRelationship; message?: string };
  if (response.ok && body.relationship !== undefined) return body.relationship;
  throw new Error(body.message ?? `connection update failed: ${response.status}`);
}

export async function deleteConnectionRelationship(
  ownerCanonicalId: string,
  subjectCanonicalId: string
): Promise<boolean> {
  const response = await fetchWithTimeout(`/api/connections/${encodeURIComponent(ownerCanonicalId)}/${encodeURIComponent(subjectCanonicalId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`connection delete failed: ${response.status}`);
  }

  const body = await response.json() as { removed?: boolean };
  return body.removed === true;
}

export async function listConnections(ownerCanonicalId: string): Promise<ConnectionRelationship[]> {
  const response = await fetchWithTimeout(`/api/connections/${encodeURIComponent(ownerCanonicalId)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`connection list failed: ${response.status}`);
  }

  const body = await response.json() as { relationships?: ConnectionRelationship[] };
  return Array.isArray(body.relationships) ? body.relationships : [];
}

export async function upsertFeedSubscription(input: {
  owner_canonical_id: string;
  author_canonical_id: string;
  author_handle?: string;
  include_public?: boolean;
  include_connections?: boolean;
  include_close?: boolean;
  muted?: boolean;
}): Promise<FeedSubscription> {
  const response = await fetchWithTimeout("/api/subscriptions", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  const body = await response.json() as { subscription?: FeedSubscription; message?: string };
  if (response.ok && body.subscription !== undefined) return body.subscription;
  throw new Error(body.message ?? `subscription update failed: ${response.status}`);
}

export async function listFeedSubscriptions(ownerCanonicalId: string): Promise<FeedSubscription[]> {
  const response = await fetchWithTimeout(`/api/subscriptions/${encodeURIComponent(ownerCanonicalId)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`subscription list failed: ${response.status}`);
  }

  const body = await response.json() as { subscriptions?: FeedSubscription[] };
  return Array.isArray(body.subscriptions) ? body.subscriptions : [];
}

export async function deleteFeedSubscription(ownerCanonicalId: string, authorCanonicalId: string): Promise<boolean> {
  const response = await fetchWithTimeout(`/api/subscriptions/${encodeURIComponent(ownerCanonicalId)}/${encodeURIComponent(authorCanonicalId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`subscription delete failed: ${response.status}`);
  }

  const body = await response.json() as { removed?: boolean };
  return body.removed === true;
}

export type CreateFeedPostRequest = {
  post_id?: string;
  author_canonical_id: string;
  author_handle?: string;
  visibility: FeedPost["visibility"];
  body?: string;
  encrypted_body?: string;
  public_metadata?: {
    title?: string;
    summary?: string;
    tags?: string[];
  };
  allowed_recipients?: string[];
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  sequence?: number;
  signature?: string;
};

export async function createFeedPost(input: CreateFeedPostRequest): Promise<FeedPost> {
  const response = await fetchWithTimeout("/api/feeds/posts", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const body = await response.json() as { post?: FeedPost; message?: string };
  if (response.ok && body.post !== undefined) return body.post;
  throw new Error(body.message ?? `feed post failed: ${response.status}`);
}

export async function listUserFeedPosts(canonicalId: string, viewerCanonicalId?: string): Promise<FeedPost[]> {
  const url = new URL(`/api/feeds/users/${encodeURIComponent(canonicalId)}`, window.location.origin);
  if (viewerCanonicalId !== undefined) url.searchParams.set("viewer", viewerCanonicalId);
  const response = await fetchWithTimeout(url.toString(), {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`feed load failed: ${response.status}`);
  }

  const body = await response.json() as { posts?: FeedPost[] };
  return Array.isArray(body.posts) ? body.posts : [];
}

export async function createDiscoveryReaction(input: {
  reaction_id?: string;
  post_id: string;
  actor_canonical_id: string;
  actor_handle?: string;
  reaction: DiscoveryReaction["reaction"];
  created_at?: string;
  signature?: string;
}): Promise<{ reaction: DiscoveryReaction; index: DiscoveryPostIndex }> {
  const response = await fetchWithTimeout("/api/discovery/reactions", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  const body = await response.json() as { reaction?: DiscoveryReaction; index?: DiscoveryPostIndex; message?: string };
  if (response.ok && body.reaction !== undefined && body.index !== undefined) return { reaction: body.reaction, index: body.index };
  throw new Error(body.message ?? `discovery reaction failed: ${response.status}`);
}

export async function getDiscoveryPost(postId: string): Promise<DiscoveryPostIndex> {
  const response = await fetchWithTimeout(`/api/discovery/posts/${encodeURIComponent(postId)}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`discovery lookup failed: ${response.status}`);
  }

  const body = await response.json() as { index?: DiscoveryPostIndex };
  if (body.index === undefined) {
    throw new Error("discovery lookup failed");
  }

  return body.index;
}

export async function listDiscoveryPosts(mode: DiscoveryMode, limit = 20, offset = 0): Promise<DiscoveryPostIndex[]> {
  const response = await fetchWithTimeout(`/api/discovery/${mode}?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`discovery load failed: ${response.status}`);
  }

  const body = await response.json() as { posts?: DiscoveryPostIndex[] };
  return Array.isArray(body.posts) ? body.posts : [];
}

export async function reindexDiscoveryPosts(): Promise<number> {
  const response = await fetchWithTimeout("/api/discovery/reindex", {
    method: "POST",
    headers: { accept: "application/json" }
  });

  const body = await response.json() as { count?: number; message?: string };
  if (response.ok && typeof body.count === "number") return body.count;
  throw new Error(body.message ?? `discovery reindex failed: ${response.status}`);
}

export function normalizeLookupInput(query: string): string {
  return query.trim().replace(/^@/, "");
}

export async function fingerprintPublicKey(publicKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(publicKey);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle === undefined
    ? sha256(bytes)
    : new Uint8Array(await subtle.digest("SHA-256", bytes));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readErrorBody(response: Response): Promise<{ message: string }> {
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === "string") return { message: body.message };
  } catch {
    // Fall through to status text.
  }

  return { message: response.statusText || `request failed: ${response.status}` };
}

function sha256(bytes: Uint8Array): Uint8Array {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, false);
    }

    for (let index = 16; index < 64; index++) {
      const s0 = rotateRight(words[index - 15]!, 7) ^ rotateRight(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3);
      const s1 = rotateRight(words[index - 2]!, 17) ^ rotateRight(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;

    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < hash.length; index++) {
    digestView.setUint32(index * 4, hash[index]!, false);
  }

  return digest;
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

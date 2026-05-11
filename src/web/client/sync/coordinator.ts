// Shared trusted-device sync coordinator. Owns the polling loop,
// per-device origin sequence counter, recipient cursor, sym-key
// reuse, and the slice projector registry. Slice modules (contact,
// subscription, message) plug in by calling registerSliceProjector;
// they don't own any of the per-device bookkeeping themselves.
//
// Hard rules — apply to every slice:
//   - The server only sees ciphertext + signed envelopes.
//   - Inbound events are verified against the canonical
//     SignedDeviceMembership for their origin device.
//   - Local cursor advances and ACKs only after a durable IndexedDB
//     save. The local cursor is the durable record; the server cursor
//     is convenience.
//   - Every outbound post is best-effort: callers must never block on
//     buildAndPostSyncEvent failing.

import { ackSyncCursor, listSyncEvents, postSyncEvent } from "../api.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import { signSyncEvent as browserSignSyncEvent } from "../crypto/signing.js";
import { decryptSyncPayload } from "../crypto/sync.js";
import { encryptSyncPayload } from "../crypto/sync.js";
import { getSetting, putSetting } from "../local/local-store.js";
import type {
  SignableSyncEvent,
  SignedDeviceMembership,
  SignedSyncEvent
} from "../types.js";

const PROTOCOL_VERSION = "0.1.0";
const MEMBERSHIP_CACHE_TTL_MS = 5_000;

type Coordinator = {
  account: BrowserCryptoAccount;
  deviceId: string;
};

let active: Coordinator | null = null;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let polling = false;

export function setActiveCoordinator(account: BrowserCryptoAccount, deviceId: string): void {
  active = { account, deviceId };
}

export function clearActiveCoordinator(): void {
  active = null;
  stopPolling();
}

// Slice projector registry. Each slice (contact, subscription,
// message, ...) registers a projector that knows how to apply an
// inbound event to local state. The shared poll loop dispatches by
// event.slice and trusts the projector to be idempotent on retry.
// Returning false stops the poll cycle so the cursor doesn't advance
// past an event the receiver couldn't apply (network/IDB transient
// failure).
export type SliceProjector = (
  account: BrowserCryptoAccount,
  event: SignedSyncEvent,
  payload: Record<string, unknown>
) => Promise<boolean>;

const sliceProjectors = new Map<SignableSyncEvent["slice"], SliceProjector>();

export function registerSliceProjector(
  slice: SignableSyncEvent["slice"],
  projector: SliceProjector
): void {
  sliceProjectors.set(slice, projector);
}

// -- per-device origin sequence + recipient cursor (IndexedDB) --

function originSeqKey(ownerCanonicalId: string, deviceId: string): string {
  return `sync.origin_sequence:${ownerCanonicalId}:${deviceId}`;
}

function recipientCursorKey(ownerCanonicalId: string, deviceId: string): string {
  return `sync.recipient_cursor:${ownerCanonicalId}:${deviceId}`;
}

// Per-(owner, device) serialization for sequence reservation. The
// read-then-write against the settings store is not atomic on its own:
// if two callers race (e.g. notifyMessageUpsert fires a `void
// buildAndPostSyncEvent` while a subsequent slice posts in parallel),
// both can read the same N and write N+1, producing duplicate
// sequences. The server rejects the duplicate as sequence_regression.
// A promise-chain mutex keyed by (owner, device) is enough; reservations
// are not high-throughput and we only need ordering within one origin.
const sequenceChains = new Map<string, Promise<unknown>>();
async function reserveOriginSequence(ownerCanonicalId: string, deviceId: string): Promise<number> {
  const key = originSeqKey(ownerCanonicalId, deviceId);
  const chainKey = `${ownerCanonicalId}|${deviceId}`;
  const prev = sequenceChains.get(chainKey) ?? Promise.resolve();
  const next = prev.then(async () => {
    const current = (await getSetting(key)) as number | null;
    const value = (typeof current === "number" ? current : 0) + 1;
    await putSetting(key, value);
    return value;
  });
  // Swallow rejection on the stored chain so a single failure doesn't
  // poison every subsequent reservation; callers still see the real
  // error via their own await.
  sequenceChains.set(chainKey, next.catch(() => undefined));
  return next;
}

async function readCursor(ownerCanonicalId: string, deviceId: string): Promise<number> {
  const value = (await getSetting(recipientCursorKey(ownerCanonicalId, deviceId))) as number | null;
  return typeof value === "number" ? value : 0;
}

async function writeCursor(ownerCanonicalId: string, deviceId: string, value: number): Promise<void> {
  await putSetting(recipientCursorKey(ownerCanonicalId, deviceId), value);
}

// -- outbound: build + sign + post --

async function buildSignedEvent(
  coordinator: Coordinator,
  slice: SignableSyncEvent["slice"],
  kind: SignableSyncEvent["kind"],
  plaintext: object
): Promise<SignedSyncEvent> {
  const { account, deviceId } = coordinator;
  const encryptedPayload = await encryptSyncPayload(JSON.stringify(plaintext), account.account_sync_sym_key);
  const signable: SignableSyncEvent = {
    type: "sudo_sync_event",
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    owner_canonical_id: account.canonical_id,
    origin_device_id: deviceId,
    slice,
    kind,
    sequence: await reserveOriginSequence(account.canonical_id, deviceId),
    created_at: new Date().toISOString(),
    encrypted_payload: encryptedPayload
  };
  const signature = await browserSignSyncEvent(signable, account.device_key, account.identity_key_type);
  return { ...signable, signature };
}

// Slice modules use this to build, sign, encrypt, and POST their
// slice's sync event. Best-effort: errors are logged and swallowed
// so user-driven local writes never block on relay failures.
// Returns true if the POST landed, false if it failed; fire-and-forget
// callers ignore the return, but backfill checks it to decide whether
// to mark a slice as partial and retry later.
export async function buildAndPostSyncEvent(
  slice: SignableSyncEvent["slice"],
  kind: SignableSyncEvent["kind"],
  plaintext: object
): Promise<boolean> {
  if (active === null) return false;
  try {
    const event = await buildSignedEvent(active, slice, kind, plaintext);
    await postSyncEvent(active.account.canonical_id, event);
    return true;
  } catch (error) {
    console.warn(`[sync] ${slice}/${kind} post failed`, error instanceof Error ? error.message : error);
    return false;
  }
}

// -- inbound: poll, verify, project, ACK --

let cachedMemberships: { ownerCanonicalId: string; expiresAt: number; data: SignedDeviceMembership[] } | null = null;

async function loadMemberships(ownerCanonicalId: string): Promise<SignedDeviceMembership[]> {
  if (cachedMemberships !== null
      && cachedMemberships.ownerCanonicalId === ownerCanonicalId
      && cachedMemberships.expiresAt > Date.now()) {
    return cachedMemberships.data;
  }
  // Pull the canonical memberships index from the server. The
  // listing is hosted alongside the trusted_devices cache; we use
  // the canonical column so revocations propagate cleanly.
  const response = await fetch(`/api/devices/${encodeURIComponent(ownerCanonicalId)}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) return [];
  const body = await response.json() as { memberships?: SignedDeviceMembership[] };
  const memberships = Array.isArray(body.memberships) ? body.memberships : [];
  cachedMemberships = { ownerCanonicalId, expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS, data: memberships };
  return memberships;
}

async function findActiveOriginMembership(
  ownerCanonicalId: string,
  originDeviceId: string
): Promise<SignedDeviceMembership | null> {
  const memberships = await loadMemberships(ownerCanonicalId);
  return memberships.find((m) => m.device_id === originDeviceId && m.trust_state === "active") ?? null;
}

export async function pollOnce(): Promise<void> {
  if (active === null || polling) return;
  polling = true;
  try {
    await runPollCycle(active);
  } finally {
    polling = false;
  }
}

async function runPollCycle(coordinator: Coordinator): Promise<void> {
  const { account, deviceId } = coordinator;
  const cursor = await readCursor(account.canonical_id, deviceId);

  let response;
  try {
    response = await listSyncEvents(account.canonical_id, deviceId, cursor, 50);
  } catch {
    // 403 (recipient_not_authorized) lands here once the local
    // device is revoked. Stop polling silently.
    return;
  }
  if (response.events.length === 0) return;

  let appliedThrough = cursor;
  for (const entry of response.events) {
    const event = entry.signed_event;
    if (event.origin_device_id === deviceId) {
      // Skip our own writes — already projected locally at write time.
      appliedThrough = entry.server_seq;
      await writeCursor(account.canonical_id, deviceId, appliedThrough);
      continue;
    }
    const originMembership = await findActiveOriginMembership(account.canonical_id, event.origin_device_id);
    if (originMembership === null) {
      // Stop the cycle so a fresh membership lookup happens next
      // time. Cursor stays at the last applied event.
      break;
    }
    const verified = await verifyOnReceive(event, originMembership);
    if (!verified) break;

    let projected = false;
    try {
      const plaintext = await decryptSyncPayload(event.encrypted_payload, account.account_sync_sym_key);
      const payload = JSON.parse(plaintext) as Record<string, unknown>;
      const projector = sliceProjectors.get(event.slice);
      if (projector === undefined) {
        // Unknown slice — likely from a newer client. The signature
        // verified, so trust the envelope and advance the cursor; we
        // just don't know how to apply the body. New slices register
        // a projector at module load to opt into projection.
        projected = true;
      } else {
        projected = await projector(account, event, payload);
      }
    } catch (error) {
      console.warn("[sync] failed to project event", error instanceof Error ? error.message : error);
      break;
    }

    if (!projected) break;
    appliedThrough = entry.server_seq;
    await writeCursor(account.canonical_id, deviceId, appliedThrough);
  }

  if (appliedThrough > cursor) {
    try {
      await ackSyncCursor(account.canonical_id, deviceId, appliedThrough);
    } catch {
      // ACK is best-effort — local cursor is the durable record.
    }
  }
}

async function verifyOnReceive(event: SignedSyncEvent, membership: SignedDeviceMembership): Promise<boolean> {
  const { signature, ...signable } = event;
  const data = new TextEncoder().encode(canonicalJson(signable));
  const algo = membership.device_key_type === "ecdsa-p256"
    ? { name: "ECDSA", hash: "SHA-256" }
    : { name: "Ed25519" };
  try {
    const publicKey = await importDevicePublicKey(membership.device_public_key, membership.device_key_type ?? "ed25519");
    const sigBytes = base64UrlToBytes(signature);
    return crypto.subtle.verify(
      algo as any,
      publicKey,
      sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer,
      data
    );
  } catch {
    return false;
  }
}

async function importDevicePublicKey(spkiBase64Url: string, keyType: "ed25519" | "ecdsa-p256"): Promise<CryptoKey> {
  const algorithm = keyType === "ecdsa-p256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "Ed25519" };
  const bytes = base64UrlToBytes(spkiBase64Url);
  return crypto.subtle.importKey(
    "spki",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    algorithm as any,
    true,
    ["verify"]
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// -- timer --

export function startPolling(intervalMs = 5000): void {
  if (pollHandle !== null) return;
  pollHandle = setInterval(() => {
    void pollOnce();
  }, intervalMs);
}

export function stopPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// Internal access for slice modules that need to know if the
// coordinator is currently active for a particular owner. The shared
// outbound path (buildAndPostSyncEvent) already handles inactive state,
// so most callers don't need this.
export function activeAccount(): BrowserCryptoAccount | null {
  return active === null ? null : active.account;
}

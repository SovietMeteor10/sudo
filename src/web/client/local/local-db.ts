export const LOCAL_DB_NAME = "sudo_local_state";
// v6: read_state store. Per-conversation last-read timestamp + message
// id, scoped by owner. Drives the unread badge on the chat list and
// syncs across linked devices so opening a chat on desktop clears the
// unread count on mobile.
// v5: backfill_state store. Tracks per-target-device replay progress
// for initial-state backfill after a new device links, so a partial
// run can resume on the next signin and the user isn't stranded with
// a half-synced second device.
// v4: account isolation — every private store now stamps and indexes
// owner_canonical_id; contacts moves to a composite key so two accounts on
// the same browser can each have their own row for the same external id.
// v10: message_attachments store. Phase 8 — one row per (owner,
// relay_message_id) carrying the wrapped media key + metadata
// (blob_id, mime, filename, size, optional width/height). The
// blob itself is opaque ciphertext on the server; this row is
// what lets the receiving device decrypt + render.
export const LOCAL_DB_VERSION = 10;

export const localStoreNames = [
  "events",
  "messages",
  "contacts",
  "subscriptions",
  "drafts",
  "identities",
  "crypto_accounts",
  "trusted_devices",
  "settings",
  "pending_outbound",
  "device_sync_events",
  "backfill_state",
  "read_state",
  "conversation_settings",
  "conversation_system_events",
  "message_reactions",
  "message_attachments"
] as const;

export type LocalStoreName = typeof localStoreNames[number];

// Typed wrapper for any "the local IndexedDB itself is unavailable" failure.
// Auth UI distinguishes this from "wrong passphrase" / "account not found"
// so users get accurate guidance instead of a misleading auth error.
export class LocalDatabaseError extends Error {
  constructor(message: string, public readonly reason: "blocked" | "timeout" | "open_failed" | "delete_blocked" = "open_failed") {
    super(message);
    this.name = "LocalDatabaseError";
  }
}

export function isLocalDatabaseError(error: unknown): error is LocalDatabaseError {
  return error instanceof LocalDatabaseError
    || (error instanceof Error && (error.name === "LocalDatabaseError" || /local database|indexed.?db/i.test(error.message)));
}

let openPromise: Promise<IDBDatabase> | null = null;
let cachedDb: IDBDatabase | null = null;

// ---- cross-tab DB coordination via BroadcastChannel ----
// Older tabs holding stale-version connections block new tabs from
// migrating. Rather than asking the user to close them, we ask peer tabs
// to release their database connections. Each tab listens on the same
// channel and closes its cached IDB on request.
const BROADCAST_CHANNEL_NAME = "sudo_local_db";

// Local-state changes are broadcast so sibling tabs of the same account
// can refresh their UI without re-polling the server. The owner stamp
// keeps account isolation intact: sibling tabs ignore changes from
// owners they aren't currently signed into.
export type LocalStateChangeKind = "messages" | "contacts" | "feed" | "auth" | "read_state" | "conversation_settings" | "conversation_system_events";

type DbBroadcastMessage =
  | { type: "release-db"; reason?: string }
  | { type: "db-released" }
  | { type: "db-open-retry" }
  | { type: "local-state-changed"; kind: LocalStateChangeKind; ownerCanonicalId: string };

type LocalStateSubscriber = (event: { kind: LocalStateChangeKind; ownerCanonicalId: string }) => void;
const localStateSubscribers = new Set<LocalStateSubscriber>();

export function subscribeLocalStateBroadcasts(handler: LocalStateSubscriber): () => void {
  localStateSubscribers.add(handler);
  // Eagerly attach the broadcast listener if we haven't already so the
  // subscriber actually receives messages.
  getBroadcastChannel();
  return () => { localStateSubscribers.delete(handler); };
}

export function broadcastLocalStateChange(kind: LocalStateChangeKind, ownerCanonicalId: string): void {
  if (typeof ownerCanonicalId !== "string" || ownerCanonicalId.length === 0) return;
  broadcast({ type: "local-state-changed", kind, ownerCanonicalId });
  // Also notify SAME-tab subscribers. BroadcastChannel by spec
  // doesn't deliver back to the originating tab; without this fan-
  // out a same-tab write whose UI refresh isn't already explicitly
  // wired at the call site (e.g. the inbox poll's reaction branch)
  // would leave the visible chat popup stale until the next render
  // triggered by some unrelated event. Subscribers must be
  // idempotent — the existing handler chain (refreshLocalChats /
  // renderChatPopupBody) already is.
  for (const handler of [...localStateSubscribers]) {
    try { handler({ kind, ownerCanonicalId }); } catch { /* ignore */ }
  }
}

let broadcastChannel: BroadcastChannel | null = null;
function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (broadcastChannel !== null) return broadcastChannel;
  try {
    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.onmessage = (event) => {
      const message = event.data as DbBroadcastMessage | undefined;
      if (message === undefined || typeof message.type !== "string") return;
      if (message.type === "release-db") {
        // Another tab is trying to migrate or open this database. Close
        // our cached connection so it can proceed; we'll reopen lazily on
        // the next read/write.
        if (cachedDb !== null) {
          try { cachedDb.close(); } catch { /* ignore */ }
        }
        cachedDb = null;
        openPromise = null;
        try { channel.postMessage({ type: "db-released" } satisfies DbBroadcastMessage); } catch { /* ignore */ }
      } else if (message.type === "local-state-changed") {
        // Forward to in-process subscribers (UI). The handler is
        // responsible for ignoring events that don't match the current
        // signed-in owner.
        for (const handler of [...localStateSubscribers]) {
          try { handler({ kind: message.kind, ownerCanonicalId: message.ownerCanonicalId }); } catch { /* ignore */ }
        }
      }
    };
    broadcastChannel = channel;
  } catch {
    broadcastChannel = null;
  }
  return broadcastChannel;
}

function broadcast(message: DbBroadcastMessage): void {
  const channel = getBroadcastChannel();
  if (channel === null) return;
  try { channel.postMessage(message); } catch { /* ignore */ }
}

// Eagerly attach the channel listener so even an idle tab can hear and
// release the DB when a sibling tab needs to migrate.
getBroadcastChannel();

// Reset our own cached open. Used by retry paths that want a fresh
// indexedDB.open without coercing other tabs to close — same-account
// multi-tab usage is normal and supported.
export function resetCachedLocalDb(): void {
  if (cachedDb !== null) {
    try { cachedDb.close(); } catch { /* ignore */ }
  }
  cachedDb = null;
  openPromise = null;
}

// Ask peer tabs (in addition to our own connection) to release the local
// database. ONLY appropriate when a genuine schema-version upgrade is in
// progress: a fresh upgrade attempt blocked because peers hold stale
// connections. The onblocked handler calls this; ordinary retries should
// not, because closing siblings would interrupt other tabs of the same
// account.
export function releaseLocalDbConnection(reason: string = "unknown"): void {
  resetCachedLocalDb();
  broadcast({ type: "release-db", reason });
}

// First-open or migration on a profile with existing data can be slow,
// especially on Safari/iOS or under devtools. The previous 6s budget cut
// off legitimate v3→v4 migrations; 20s is the new ceiling.
const OPEN_TIMEOUT_MS = 20000;

export function openLocalDb(): Promise<IDBDatabase> {
  if (openPromise !== null) return openPromise;
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: IDBDatabase) => {
      if (settled) return;
      settled = true;
      cachedDb = value;
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      // A failed open MUST clear the cached promise so the next caller can
      // try again instead of replaying the same poisoned rejection.
      openPromise = null;
      cachedDb = null;
      reject(error);
    };

    const timer = setTimeout(
      () => settleReject(new LocalDatabaseError("local database open timed out", "timeout")),
      OPEN_TIMEOUT_MS
    );

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : "indexedDB.open threw";
      settleReject(new LocalDatabaseError(`local database unavailable (${message})`, "open_failed"));
      return;
    }

    request.onblocked = () => {
      // Another tab still holds an older-version connection. Ask peer tabs
      // (over BroadcastChannel) to release their connections so the upgrade
      // can proceed. The OPEN_TIMEOUT_MS will fire if no peer responds.
      console.warn("[local-db] open blocked by another tab; broadcasting release-db");
      broadcast({ type: "release-db", reason: "open_blocked" });
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      const upgrade = request.transaction;

      try {
        applySchema(db, oldVersion, upgrade);
      } catch (error) {
        const message = error instanceof Error ? error.message : "schema upgrade failed";
        // Aborting the version-change transaction makes onerror fire.
        try { upgrade?.abort(); } catch { /* ignore */ }
        clearTimeout(timer);
        settleReject(new LocalDatabaseError(`local database upgrade failed (${message})`, "open_failed"));
      }
    };

    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // If a future tab loads a newer schema, IndexedDB notifies all open
      // connections via onversionchange. We MUST close ours so the upgrade
      // can proceed instead of blocking the new tab forever.
      db.onversionchange = () => {
        console.warn("[local-db] received versionchange from another tab; closing this connection");
        try { db.close(); } catch { /* ignore */ }
        if (cachedDb === db) cachedDb = null;
        openPromise = null;
        broadcast({ type: "db-released" });
      };
      db.onclose = () => {
        if (cachedDb === db) cachedDb = null;
        openPromise = null;
      };
      settleResolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      const native = request.error;
      const message = native?.message ?? "failed to open local IndexedDB";
      settleReject(new LocalDatabaseError(`local database unavailable (${message})`, "open_failed"));
    };
  });

  return openPromise;
}

export async function clearLocalDb(): Promise<void> {
  const db = await openLocalDb();
  await Promise.all(localStoreNames.map((name) => clearStore(db, name)));
}

export async function deleteLocalDb(): Promise<void> {
  if (cachedDb !== null) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
  openPromise = null;

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    const timer = setTimeout(
      () => reject(new LocalDatabaseError("local database delete timed out — close other sudo tabs and try again", "delete_blocked")),
      8000
    );
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => {
      clearTimeout(timer);
      const native = request.error;
      reject(new LocalDatabaseError(`local database delete failed (${native?.message ?? "unknown"})`, "open_failed"));
    };
    request.onblocked = () => {
      // Don't reject immediately; some browsers fire onblocked before the
      // other tab's versionchange-driven close completes. The timer above
      // will reject if it never resolves.
      console.warn("[local-db] delete blocked by another tab; waiting");
    };
  });
}

export function txDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

// Cheap probe used by signup pre-flight. Tries to open the DB and write to
// a throwaway settings key. Surfaces LocalDatabaseError for any failure.
//
// Races against a short timeout so a poisoned IndexedDB surfaces a clear
// DB error inside the auth flow's 15s ceiling — instead of being absorbed
// by the generic flow timeout and reported as "this is taking too long".
export async function probeLocalDbWritable(timeoutMs = 5000): Promise<void> {
  await Promise.race([
    runProbe(),
    new Promise<void>((_, reject) => setTimeout(
      () => reject(new LocalDatabaseError("local database probe timed out", "timeout")),
      timeoutMs
    ))
  ]);
}

// Retry the local DB open until it succeeds or the caller aborts. Local
// data is treated as durable: we never give up and we never delete state.
// The auth flow uses this so a transient block (older tab still attached)
// resolves quietly without dropping the user into an error state.
export type RetryOpenOptions = {
  signal?: AbortSignal;
  // Called once per attempt with the current attempt number (1-indexed) and
  // the most recent failure (if any). UIs use it to swap into a calm
  // "still opening local data..." state.
  onAttempt?: (attempt: number, lastError: LocalDatabaseError | null) => void;
};

export async function retryOpenLocalDb(options: RetryOpenOptions = {}): Promise<IDBDatabase> {
  const delays = [0, 1000, 3000, 5000, 5000, 5000]; // backoff; index >= length stays at 5000ms
  let attempt = 0;
  let lastError: LocalDatabaseError | null = null;
  while (true) {
    if (options.signal?.aborted) {
      throw new LocalDatabaseError("retry cancelled", "open_failed");
    }
    options.onAttempt?.(attempt + 1, lastError);
    try {
      return await openLocalDb();
    } catch (error) {
      if (!isLocalDatabaseError(error)) throw error;
      lastError = error;
      attempt += 1;
      // Don't broadcast release-db on every retry — siblings holding the
      // same account's DB are not the problem during normal use. Only the
      // onblocked path (real version-upgrade conflict) asks peers to
      // close. Just drop our cached open and try again.
      resetCachedLocalDb();
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 5000;
      if (delay > 0) await waitOrAbort(delay, options.signal);
    }
  }
}

// Wait `ms` milliseconds, but resolve early when the signal aborts.
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => { resolve(); cleanup(); }, ms);
    const onAbort = () => { resolve(); cleanup(); };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runProbe(): Promise<void> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction("settings", "readwrite");
    } catch (error) {
      const message = error instanceof Error ? error.message : "tx open failed";
      reject(new LocalDatabaseError(`local database not writable (${message})`, "open_failed"));
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new LocalDatabaseError(`local database write failed (${transaction.error?.message ?? "unknown"})`, "open_failed"));
    transaction.onabort = () => reject(new LocalDatabaseError(`local database write aborted (${transaction.error?.message ?? "unknown"})`, "open_failed"));
    try {
      transaction.objectStore("settings").put({
        key: "device.preflight",
        value: { last_check_at: new Date().toISOString() },
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "put failed";
      reject(new LocalDatabaseError(`local database write rejected (${message})`, "open_failed"));
    }
  });
}

function clearStore(db: IDBDatabase, storeName: LocalStoreName): Promise<void> {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).clear();
  return txDone(transaction);
}

function applySchema(db: IDBDatabase, oldVersion: number, upgrade: IDBTransaction | null): void {
  // ---- v1+ stores ----
  if (!db.objectStoreNames.contains("events")) {
    const store = db.createObjectStore("events", { keyPath: "event_id" });
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_owner_created_at", ["owner_canonical_id", "created_at"]);
  }

  if (!db.objectStoreNames.contains("messages")) {
    const store = db.createObjectStore("messages", { keyPath: "message_id" });
    store.createIndex("by_conversation", "conversation_id");
    store.createIndex("by_created_at", "created_at");
    store.createIndex("by_status", "status");
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_owner_conversation", ["owner_canonical_id", "conversation_id"]);
    store.createIndex("by_owner_created_at", ["owner_canonical_id", "created_at"]);
    // by_owner_relay lets the chat-receipt + cross-user-reply paths
    // resolve a (owner, relay_message_id) pair back to the local row
    // without scanning the whole conversation.
    store.createIndex("by_owner_relay", ["owner_canonical_id", "relay_message_id"]);
  }

  // Contacts: composite primary key [owner_canonical_id, canonical_id]
  // so two accounts can each independently track the same external id.
  if (!db.objectStoreNames.contains("contacts")) {
    const store = db.createObjectStore("contacts", { keyPath: ["owner_canonical_id", "canonical_id"] });
    store.createIndex("by_owner", "owner_canonical_id");
  }

  if (!db.objectStoreNames.contains("subscriptions")) {
    const store = db.createObjectStore("subscriptions", { keyPath: "subscription_id" });
    store.createIndex("by_owner", "owner_canonical_id");
  }

  if (!db.objectStoreNames.contains("drafts")) {
    const store = db.createObjectStore("drafts", { keyPath: "draft_id" });
    store.createIndex("by_owner", "owner_canonical_id");
  }

  if (!db.objectStoreNames.contains("identities")) {
    db.createObjectStore("identities", { keyPath: "canonical_id" });
  }

  if (!db.objectStoreNames.contains("crypto_accounts")) {
    const store = db.createObjectStore("crypto_accounts", { keyPath: "canonical_id" });
    store.createIndex("by_handle", "handle");
    store.createIndex("by_updated_at", "updated_at");
  }

  if (!db.objectStoreNames.contains("trusted_devices")) {
    const store = db.createObjectStore("trusted_devices", { keyPath: "device_id" });
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_trust_state", "trust_state");
    store.createIndex("by_last_seen_at", "last_seen_at");
  }

  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "key" });
  }

  if (!db.objectStoreNames.contains("pending_outbound")) {
    const store = db.createObjectStore("pending_outbound", { keyPath: "local_queue_id" });
    store.createIndex("by_recipient", "recipient_canonical_id");
    store.createIndex("by_status", "status");
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_owner_recipient", ["owner_canonical_id", "recipient_canonical_id"]);
    store.createIndex("by_owner_status", ["owner_canonical_id", "status"]);
  }

  if (!db.objectStoreNames.contains("device_sync_events")) {
    const store = db.createObjectStore("device_sync_events", { keyPath: "event_id" });
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_device", "device_id");
    store.createIndex("by_created_at", "created_at");
  }

  // v5: backfill_state. One row per (owner, target_device_id). Records
  // whether the initial-state replay to a newly linked device has run
  // to completion; partial / failed rows are retried on the next
  // signin or settings-open.
  if (!db.objectStoreNames.contains("backfill_state")) {
    const store = db.createObjectStore("backfill_state", {
      keyPath: ["owner_canonical_id", "target_device_id"]
    });
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_status", "status");
  }

  // v6: read_state. One row per (owner, conversation_id). Carries
  // last_read_at + optional last_read_message_id; monotonic merge
  // means a later read on any device wins.
  if (!db.objectStoreNames.contains("read_state")) {
    const store = db.createObjectStore("read_state", {
      keyPath: ["owner_canonical_id", "conversation_id"]
    });
    store.createIndex("by_owner", "owner_canonical_id");
  }

  // v8: add by_owner_relay index on messages so the chat-receipt
  // pipeline and cross-user reply renderer can resolve a peer's
  // relay_message_id back to our local row in O(1).
  if (oldVersion < 8 && upgrade !== null) {
    ensureIndex(upgrade, "messages", "by_owner_relay", ["owner_canonical_id", "relay_message_id"]);
  }

  // v7: conversation_settings + conversation_system_events.
  // conversation_settings: one row per (owner, conversation_id),
  // shared with the peer via the conversation_settings sync slice.
  // Currently just holds the disappearing-messages TTL but laid out
  // so future per-conversation prefs can land in the same row.
  // conversation_system_events: in-band system notices ("@alice
  // changed message expiry to 24 hours") rendered inline with the
  // message timeline.
  if (!db.objectStoreNames.contains("conversation_settings")) {
    const store = db.createObjectStore("conversation_settings", {
      keyPath: ["owner_canonical_id", "conversation_id"]
    });
    store.createIndex("by_owner", "owner_canonical_id");
  }
  if (!db.objectStoreNames.contains("conversation_system_events")) {
    const store = db.createObjectStore("conversation_system_events", {
      keyPath: "event_id"
    });
    store.createIndex("by_owner_conversation", ["owner_canonical_id", "conversation_id"]);
    store.createIndex("by_owner", "owner_canonical_id");
  }

  // v9: message_reactions. One row per (owner, relay_message_id,
  // reactor_canonical_id). Keyed on a composite array so two
  // accounts on the same browser don't collide AND so we never
  // accidentally let one reactor stash two simultaneous emojis on
  // the same message.
  if (!db.objectStoreNames.contains("message_reactions")) {
    const store = db.createObjectStore("message_reactions", {
      keyPath: ["owner_canonical_id", "relay_message_id", "reactor_canonical_id"]
    });
    store.createIndex("by_owner", "owner_canonical_id");
    store.createIndex("by_owner_relay", ["owner_canonical_id", "relay_message_id"]);
  }

  // v10: message_attachments. One row per (owner, relay_message_id).
  // The wrapped media key is what the spec calls a "two-wrap"
  // mechanism — same plaintext key encrypted twice (once for the
  // peer, once for our own linked devices). updated_at lets us
  // converge when both wraps land in different orders.
  if (!db.objectStoreNames.contains("message_attachments")) {
    const store = db.createObjectStore("message_attachments", {
      keyPath: ["owner_canonical_id", "relay_message_id"]
    });
    store.createIndex("by_owner", "owner_canonical_id");
  }

  // ---- v3 → v4: account isolation ----
  if (oldVersion < 4 && upgrade !== null) {
    ensureIndex(upgrade, "events", "by_owner", "owner_canonical_id");
    ensureIndex(upgrade, "events", "by_owner_created_at", ["owner_canonical_id", "created_at"]);
    ensureIndex(upgrade, "messages", "by_owner", "owner_canonical_id");
    ensureIndex(upgrade, "messages", "by_owner_conversation", ["owner_canonical_id", "conversation_id"]);
    ensureIndex(upgrade, "messages", "by_owner_created_at", ["owner_canonical_id", "created_at"]);
    ensureIndex(upgrade, "subscriptions", "by_owner", "owner_canonical_id");
    ensureIndex(upgrade, "drafts", "by_owner", "owner_canonical_id");
    ensureIndex(upgrade, "pending_outbound", "by_owner", "owner_canonical_id");
    ensureIndex(upgrade, "pending_outbound", "by_owner_recipient", ["owner_canonical_id", "recipient_canonical_id"]);
    ensureIndex(upgrade, "pending_outbound", "by_owner_status", ["owner_canonical_id", "status"]);

    // Contacts keyPath is composite as of v4; legacy single-key rows can't
    // be safely migrated (we don't know which account owned them), so the
    // store is rebuilt empty.
    if (db.objectStoreNames.contains("contacts")) {
      db.deleteObjectStore("contacts");
    }
    const contactsStore = db.createObjectStore("contacts", {
      keyPath: ["owner_canonical_id", "canonical_id"]
    });
    contactsStore.createIndex("by_owner", "owner_canonical_id");
  }
}

function ensureIndex(
  transaction: IDBTransaction,
  storeName: LocalStoreName,
  indexName: string,
  keyPath: string | string[]
): void {
  if (!transaction.db.objectStoreNames.contains(storeName)) return;
  const store = transaction.objectStore(storeName);
  if (!store.indexNames.contains(indexName)) {
    store.createIndex(indexName, keyPath);
  }
}

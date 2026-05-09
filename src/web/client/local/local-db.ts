export const LOCAL_DB_NAME = "sudo_local_state";
// v4: account isolation — every private store now stamps and indexes
// owner_canonical_id; contacts moves to a composite key so two accounts on
// the same browser can each have their own row for the same external id.
export const LOCAL_DB_VERSION = 4;

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
  "device_sync_events"
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
      // Another tab still holds an older-version connection. Don't kill our
      // pending open immediately — give the other tab a chance to receive
      // its versionchange and close. The OPEN_TIMEOUT_MS will eventually
      // fire if it never does.
      console.warn("[local-db] open blocked by another tab; waiting for it to close");
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

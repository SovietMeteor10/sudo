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

let openPromise: Promise<IDBDatabase> | null = null;

// Some browsers (Safari, iOS) and multi-tab scenarios can hang
// `indexedDB.open` indefinitely when another tab holds an older-version
// connection. We add an explicit `onblocked` reject + a hard timeout so
// auth flows surface a clear error instead of waiting forever.
const OPEN_TIMEOUT_MS = 6000;

export function openLocalDb(): Promise<IDBDatabase> {
  if (openPromise !== null) return openPromise;
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: IDBDatabase) => { if (!settled) { settled = true; resolve(value); } };
    const settleReject = (error: Error) => { if (!settled) { settled = true; openPromise = null; reject(error); } };

    const timer = setTimeout(() => settleReject(new Error("local database open timed out")), OPEN_TIMEOUT_MS);
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onblocked = () => {
      clearTimeout(timer);
      settleReject(new Error("local database is in use by another tab"));
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      const upgrade = request.transaction;

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
        // Public-identity cache, intentionally NOT owner-scoped: this only
        // holds public, signed identity documents we've already seen on the
        // wire. No private user state lives here.
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

      // ---- v4: account isolation ----
      // Bring older databases up to the v4 shape. Old unscoped records lose
      // their lookup path because the new indexes/keys require owner stamps;
      // they remain physically present but invisible to the UI per the
      // privacy spec ("treat them as legacy and do not render them"). They
      // are cleaned out below for contacts where the keyPath itself changes.
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

        // Contacts keyPath is composite as of v4; old single-key records
        // can't be migrated safely (we don't know which account owned them),
        // so the store is rebuilt empty and old contacts are dropped.
        if (db.objectStoreNames.contains("contacts")) {
          db.deleteObjectStore("contacts");
        }
        const contactsStore = db.createObjectStore("contacts", {
          keyPath: ["owner_canonical_id", "canonical_id"]
        });
        contactsStore.createIndex("by_owner", "owner_canonical_id");
      }
    };

    request.onsuccess = () => {
      clearTimeout(timer);
      settleResolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      settleReject(request.error ?? new Error("failed to open local IndexedDB"));
    };
  });

  return openPromise;
}

export async function clearLocalDb(): Promise<void> {
  const db = await openLocalDb();
  await Promise.all(localStoreNames.map((name) => clearStore(db, name)));
}

export async function deleteLocalDb(): Promise<void> {
  if (openPromise !== null) {
    const db = await openPromise;
    db.close();
    openPromise = null;
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("failed to delete local IndexedDB"));
    request.onblocked = () => reject(new Error("local IndexedDB delete blocked by another tab"));
  });
}

export function txDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function clearStore(db: IDBDatabase, storeName: LocalStoreName): Promise<void> {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).clear();
  return txDone(transaction);
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

export const LOCAL_DB_NAME = "sudo_local_state";
export const LOCAL_DB_VERSION = 3;

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

export function openLocalDb(): Promise<IDBDatabase> {
  openPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("events")) {
        db.createObjectStore("events", { keyPath: "event_id" });
      }

      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "message_id" });
        store.createIndex("by_conversation", "conversation_id");
        store.createIndex("by_created_at", "created_at");
        store.createIndex("by_status", "status");
      }

      if (!db.objectStoreNames.contains("contacts")) {
        db.createObjectStore("contacts", { keyPath: "canonical_id" });
      }

      if (!db.objectStoreNames.contains("subscriptions")) {
        db.createObjectStore("subscriptions", { keyPath: "subscription_id" });
      }

      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts", { keyPath: "draft_id" });
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
      }

      if (!db.objectStoreNames.contains("device_sync_events")) {
        const store = db.createObjectStore("device_sync_events", { keyPath: "event_id" });
        store.createIndex("by_owner", "owner_canonical_id");
        store.createIndex("by_device", "device_id");
        store.createIndex("by_created_at", "created_at");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open local IndexedDB"));
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

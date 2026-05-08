import { clearLocalDb, localStoreNames, openLocalDb, txDone, type LocalStoreName } from "./local-db.js";
import type {
  LocalCryptoAccountRecord,
  LocalContact,
  LocalEvent,
  LocalIdentityRecord,
  LocalMessage,
  LocalSetting,
  LocalStateSnapshot,
  LocalStorageStatus,
  PendingOutbound
} from "./local-types.js";

export async function initializeLocalState(): Promise<void> {
  const db = await openLocalDb();
  const existing = await getSetting("device.metadata");
  if (existing !== null) return;

  const now = new Date().toISOString();
  await putSetting("device.metadata", {
    device_id: crypto.randomUUID(),
    created_at: now
  });
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: "device.created",
    created_at: now,
    subject_id: "device.metadata"
  });
  void db;
}

export async function appendLocalEvent(event: LocalEvent): Promise<void> {
  await putRecord("events", event);
}

export async function saveLocalMessage(message: LocalMessage): Promise<void> {
  await putRecord("messages", message);
}

export async function savePendingOutbound(outbound: PendingOutbound): Promise<void> {
  await putRecord("pending_outbound", outbound);
}

export async function saveIdentitySeen(identity: LocalIdentityRecord): Promise<void> {
  await putRecord("identities", identity);
}

export async function saveCryptoAccount(record: LocalCryptoAccountRecord): Promise<void> {
  await putRecord("crypto_accounts", record);
}

export async function getCryptoAccount(canonicalId: string): Promise<LocalCryptoAccountRecord | null> {
  return getRecord<LocalCryptoAccountRecord>("crypto_accounts", canonicalId);
}

export async function listCryptoAccounts(): Promise<LocalCryptoAccountRecord[]> {
  return getAllRecords<LocalCryptoAccountRecord>("crypto_accounts");
}

export async function upsertContact(contact: LocalContact): Promise<void> {
  await putRecord("contacts", contact);
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: contact.tier === "blocked" ? "contact.blocked" : "contact.added",
    created_at: new Date().toISOString(),
    subject_id: contact.canonical_id,
    data: { handle: contact.handle, tier: contact.tier }
  });
}

export async function blockContact(canonicalId: string): Promise<void> {
  const existing = await getRecord<LocalContact>("contacts", canonicalId);
  const now = new Date().toISOString();
  await putRecord("contacts", {
    canonical_id: canonicalId,
    handle: existing?.handle ?? canonicalId,
    tier: "blocked",
    added_at: existing?.added_at ?? now,
    updated_at: now,
    fingerprint: existing?.fingerprint
  });
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: "contact.blocked",
    created_at: now,
    subject_id: canonicalId
  });
}

export async function unblockContact(canonicalId: string): Promise<void> {
  const existing = await getRecord<LocalContact>("contacts", canonicalId);
  if (existing === null) return;
  const now = new Date().toISOString();
  await putRecord("contacts", { ...existing, tier: "unknown", updated_at: now });
  await appendLocalEvent({
    event_id: crypto.randomUUID(),
    type: "contact.unblocked",
    created_at: now,
    subject_id: canonicalId
  });
}

export async function getSetting(key: string): Promise<unknown | null> {
  const record = await getRecord<LocalSetting>("settings", key);
  return record?.value ?? null;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await putRecord("settings", {
    key,
    value,
    updated_at: new Date().toISOString()
  } satisfies LocalSetting);
}

export async function deleteSetting(key: string): Promise<void> {
  const db = await openLocalDb();
  const transaction = db.transaction("settings", "readwrite");
  transaction.objectStore("settings").delete(key);
  await txDone(transaction);
}

export async function getLocalChatsFromContacts(): Promise<Array<{ id: string; canonical: string; handle: string; state: "quiet" | "draft" | "sealed"; lastLine: string; fingerprint?: string }>> {
  const contacts = await getAllRecords<LocalContact>("contacts");
  return contacts
    .filter((contact) => contact.tier !== "blocked")
    .map((contact) => ({
      id: `local-${contact.canonical_id}`,
      canonical: contact.canonical_id,
      handle: contact.handle,
      state: "draft",
      lastLine: "chat draft",
      fingerprint: contact.fingerprint
    }));
}

export async function exportLocalSnapshot(): Promise<LocalStateSnapshot> {
  return {
    events: await getAllRecords("events"),
    messages: await getAllRecords("messages"),
    contacts: await getAllRecords("contacts"),
    subscriptions: await getAllRecords("subscriptions"),
    drafts: await getAllRecords("drafts"),
    crypto_accounts: await getAllRecords("crypto_accounts"),
    identities: await getAllRecords("identities"),
    settings: await getAllRecords("settings"),
    pending_outbound: await getAllRecords("pending_outbound")
  };
}

export async function importLocalSnapshot(snapshot: LocalStateSnapshot): Promise<void> {
  await Promise.all([
    putMany("events", snapshot.events),
    putMany("messages", snapshot.messages),
    putMany("contacts", snapshot.contacts),
    putMany("subscriptions", snapshot.subscriptions),
    putMany("drafts", snapshot.drafts),
    putMany("crypto_accounts", snapshot.crypto_accounts),
    putMany("identities", snapshot.identities),
    putMany("settings", snapshot.settings),
    putMany("pending_outbound", snapshot.pending_outbound)
  ]);
}

export async function getLocalStorageStatus(): Promise<LocalStorageStatus> {
  return {
    events: await countStore("events"),
    messages: await countStore("messages"),
    contacts: await countStore("contacts"),
    subscriptions: await countStore("subscriptions"),
    drafts: await countStore("drafts"),
    crypto_accounts: await countStore("crypto_accounts"),
    identities: await countStore("identities"),
    settings: await countStore("settings"),
    pending_outbound: await countStore("pending_outbound")
  };
}

export { clearLocalDb };

async function putRecord(storeName: LocalStoreName, record: unknown): Promise<void> {
  const db = await openLocalDb();
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
  await txDone(transaction);
}

async function putMany(storeName: LocalStoreName, records: unknown[]): Promise<void> {
  const db = await openLocalDb();
  const transaction = db.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  for (const record of records) {
    store.put(record);
  }
  await txDone(transaction);
}

async function getRecord<T>(storeName: LocalStoreName, key: IDBValidKey): Promise<T | null> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error(`failed to read ${storeName}`));
  });
}

async function getAllRecords<T>(storeName: LocalStoreName): Promise<T[]> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error(`failed to read ${storeName}`));
  });
}

async function countStore(storeName: LocalStoreName): Promise<number> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`failed to count ${storeName}`));
  });
}

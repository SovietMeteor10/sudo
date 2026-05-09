import { broadcastLocalStateChange, clearLocalDb, localStoreNames, openLocalDb, txDone, type LocalStoreName } from "./local-db.js";
import type {
  LocalCryptoAccountRecord,
  LocalContact,
  LocalDraft,
  LocalEvent,
  LocalIdentityRecord,
  LocalMessage,
  LocalSetting,
  LocalStateSnapshot,
  LocalStorageStatus,
  LocalSubscription,
  LocalTrustedDevice,
  PendingOutbound
} from "./local-types.js";

// IMPORTANT — privacy invariant
// Private local state (messages, contacts, drafts, subscriptions, pending
// outbound, events about the user, account-scoped trusted devices) MUST be
// scoped by `owner_canonical_id`. UI code is only allowed to read/write
// these stores via the owner-aware helpers below. The unscoped helpers at
// the bottom of this file are renamed `*Unsafe`/`All` and are reserved for
// migrations, backups across all local accounts, and tests.

export async function initializeLocalState(): Promise<void> {
  const db = await openLocalDb();
  const existing = await getSetting("device.metadata");
  if (existing !== null) return;

  const now = new Date().toISOString();
  await putSetting("device.metadata", {
    device_id: crypto.randomUUID(),
    device_name: "This device",
    created_at: now
  });
  void db;
}

export async function appendLocalEvent(ownerCanonicalId: string, event: Omit<LocalEvent, "owner_canonical_id">): Promise<void> {
  await putRecord("events", { ...event, owner_canonical_id: ownerCanonicalId });
}

export async function saveLocalMessage(ownerCanonicalId: string, message: Omit<LocalMessage, "owner_canonical_id">): Promise<void> {
  await putRecord("messages", { ...message, owner_canonical_id: ownerCanonicalId });
  broadcastLocalStateChange("messages", ownerCanonicalId);
}

// Idempotent message-sync projection. Receiver-side path used by the
// trusted-device sync poller to apply a peer's saved message into the
// local store. Returns false (without writing) when an existing local
// row is at least as fresh as the incoming one — keeping replays
// stable and preventing newer state from being clobbered by an older
// queued event. The owner_canonical_id stamp is enforced so a sync
// event from another account can never overwrite a row.
export async function projectIncomingMessage(
  ownerCanonicalId: string,
  message: Omit<LocalMessage, "owner_canonical_id">
): Promise<{ written: boolean }> {
  const existing = await getRecord<LocalMessage>("messages", message.message_id);
  if (existing !== null && existing.owner_canonical_id !== ownerCanonicalId) {
    // Should never happen in practice (message_ids are UUIDv4) but if
    // it ever did, refuse to cross account boundaries.
    return { written: false };
  }
  if (existing !== null && Date.parse(existing.updated_at) >= Date.parse(message.updated_at)) {
    return { written: false };
  }
  await putRecord("messages", { ...message, owner_canonical_id: ownerCanonicalId });
  broadcastLocalStateChange("messages", ownerCanonicalId);
  return { written: true };
}

export async function getLocalMessage(messageId: string): Promise<LocalMessage | null> {
  return getRecord<LocalMessage>("messages", messageId);
}

export async function listLocalMessagesByConversation(
  ownerCanonicalId: string,
  conversationId: string
): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("messages", "readonly");
    const index = transaction.objectStore("messages").index("by_owner_conversation");
    const request = index.getAll(IDBKeyRange.only([ownerCanonicalId, conversationId]));
    request.onsuccess = () => resolve((request.result as LocalMessage[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error("failed to read messages"));
  });
}

export async function listLocalMessages(ownerCanonicalId: string): Promise<LocalMessage[]> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("messages", "readonly");
    const index = transaction.objectStore("messages").index("by_owner");
    const request = index.getAll(ownerCanonicalId);
    request.onsuccess = () => resolve((request.result as LocalMessage[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error("failed to read messages"));
  });
}

export type ConversationSummary = {
  canonical: string;
  handle: string;
  lastLine: string;
  lastAt: string;
  fingerprint?: string;
};

// Build a chat list keyed by conversation partner using only the signed-in
// account's own messages and contacts.
export async function listConversations(ownerCanonicalId: string): Promise<ConversationSummary[]> {
  const messages = await listLocalMessages(ownerCanonicalId);
  const contacts = await listContacts(ownerCanonicalId);

  type Acc = { canonical: string; handle: string; lastLine: string; lastAt: string; fingerprint?: string };
  const byPartner = new Map<string, Acc>();

  for (const message of messages) {
    const partner = message.sender_canonical_id === ownerCanonicalId
      ? message.recipient_canonical_id
      : message.sender_canonical_id;
    if (partner === ownerCanonicalId || partner.length === 0) continue;
    const existing = byPartner.get(partner);
    const candidate: Acc = {
      canonical: partner,
      handle: existing?.handle ?? "(unknown)",
      lastLine: previewLine(message.body),
      lastAt: message.updated_at || message.created_at
    };
    if (existing === undefined || existing.lastAt < candidate.lastAt) {
      byPartner.set(partner, { ...existing, ...candidate, handle: existing?.handle ?? candidate.handle });
    }
  }

  for (const contact of contacts) {
    if (contact.tier === "blocked") continue;
    const partner = contact.canonical_id;
    if (partner === ownerCanonicalId) continue;
    const existing = byPartner.get(partner);
    if (existing === undefined) {
      byPartner.set(partner, {
        canonical: partner,
        handle: contact.handle,
        lastLine: "",
        lastAt: contact.updated_at ?? contact.added_at ?? "",
        fingerprint: contact.fingerprint
      });
    } else {
      existing.handle = contact.handle || existing.handle;
      existing.fingerprint = contact.fingerprint ?? existing.fingerprint;
    }
  }

  return [...byPartner.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}

function previewLine(body: string): string {
  const trimmed = (body ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

export async function savePendingOutbound(
  ownerCanonicalId: string,
  outbound: Omit<PendingOutbound, "owner_canonical_id">
): Promise<void> {
  await putRecord("pending_outbound", { ...outbound, owner_canonical_id: ownerCanonicalId });
}

export async function listPendingOutbound(ownerCanonicalId: string): Promise<PendingOutbound[]> {
  return getAllByIndex<PendingOutbound>("pending_outbound", "by_owner", ownerCanonicalId);
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

export async function saveTrustedDevice(device: LocalTrustedDevice): Promise<void> {
  // Trusted devices already carry owner_canonical_id from the protocol type.
  await putRecord("trusted_devices", device);
}

export async function listTrustedDevices(ownerCanonicalId: string): Promise<LocalTrustedDevice[]> {
  return getAllByIndex<LocalTrustedDevice>("trusted_devices", "by_owner", ownerCanonicalId);
}

export async function revokeTrustedDevice(deviceId: string): Promise<void> {
  const device = await getRecord<LocalTrustedDevice>("trusted_devices", deviceId);
  if (device === null) return;
  await putRecord("trusted_devices", {
    ...device,
    trust_state: "revoked",
    last_seen_at: new Date().toISOString()
  });
}

export async function upsertContact(
  ownerCanonicalId: string,
  contact: Omit<LocalContact, "owner_canonical_id">
): Promise<void> {
  await putRecord("contacts", { ...contact, owner_canonical_id: ownerCanonicalId });
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: contact.tier === "blocked" ? "contact.blocked" : "contact.added",
    created_at: new Date().toISOString(),
    subject_id: contact.canonical_id,
    data: { handle: contact.handle, tier: contact.tier }
  });
  broadcastLocalStateChange("contacts", ownerCanonicalId);
}

export async function listContacts(ownerCanonicalId: string): Promise<LocalContact[]> {
  return getAllByIndex<LocalContact>("contacts", "by_owner", ownerCanonicalId);
}

export async function getContact(ownerCanonicalId: string, canonicalId: string): Promise<LocalContact | null> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("contacts", "readonly").objectStore("contacts").get([ownerCanonicalId, canonicalId]);
    request.onsuccess = () => resolve((request.result as LocalContact | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("failed to read contact"));
  });
}

export async function deleteLocalContact(ownerCanonicalId: string, canonicalId: string): Promise<void> {
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("contacts", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("failed to delete contact"));
    tx.objectStore("contacts").delete([ownerCanonicalId, canonicalId]);
  });
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "contact.removed",
    created_at: new Date().toISOString(),
    subject_id: canonicalId
  });
  broadcastLocalStateChange("contacts", ownerCanonicalId);
}

export async function blockContact(ownerCanonicalId: string, canonicalId: string): Promise<void> {
  const existing = await getContact(ownerCanonicalId, canonicalId);
  const now = new Date().toISOString();
  await putRecord("contacts", {
    owner_canonical_id: ownerCanonicalId,
    canonical_id: canonicalId,
    handle: existing?.handle ?? canonicalId,
    tier: "blocked",
    added_at: existing?.added_at ?? now,
    updated_at: now,
    fingerprint: existing?.fingerprint
  } satisfies LocalContact);
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "contact.blocked",
    created_at: now,
    subject_id: canonicalId
  });
}

export async function unblockContact(ownerCanonicalId: string, canonicalId: string): Promise<void> {
  const existing = await getContact(ownerCanonicalId, canonicalId);
  if (existing === null) return;
  const now = new Date().toISOString();
  await putRecord("contacts", { ...existing, tier: "unknown", updated_at: now });
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "contact.unblocked",
    created_at: now,
    subject_id: canonicalId
  });
}

export async function listLocalEvents(ownerCanonicalId: string): Promise<LocalEvent[]> {
  return getAllByIndex<LocalEvent>("events", "by_owner", ownerCanonicalId);
}

export async function listLocalSubscriptions(ownerCanonicalId: string): Promise<LocalSubscription[]> {
  return getAllByIndex<LocalSubscription>("subscriptions", "by_owner", ownerCanonicalId);
}

// Composite-style key used by the sync slice so per-(owner, author)
// subscriptions stay unique across browser profiles. The legacy
// `subscription_id`/`source` fields are still populated for
// compatibility with older code paths that only read those.
function subscriptionRowId(ownerCanonicalId: string, authorCanonicalId: string): string {
  return `sync:${ownerCanonicalId}:${authorCanonicalId}`;
}

export type ProjectedSubscriptionInput = {
  author_canonical_id: string;
  include_public?: boolean;
  include_connections?: boolean;
  include_close?: boolean;
  updated_at?: string;
};

export async function upsertProjectedSubscription(
  ownerCanonicalId: string,
  input: ProjectedSubscriptionInput
): Promise<void> {
  const subscriptionId = subscriptionRowId(ownerCanonicalId, input.author_canonical_id);
  const updatedAt = input.updated_at ?? new Date().toISOString();
  const existing = await getRecord<LocalSubscription>("subscriptions", subscriptionId);
  const record: LocalSubscription = {
    subscription_id: subscriptionId,
    owner_canonical_id: ownerCanonicalId,
    source: input.author_canonical_id,
    created_at: existing?.created_at ?? updatedAt,
    author_canonical_id: input.author_canonical_id,
    include_public: input.include_public !== false,
    include_connections: input.include_connections !== false,
    include_close: input.include_close === true,
    updated_at: updatedAt
  };
  await putRecord("subscriptions", record);
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "subscription.added",
    created_at: updatedAt,
    subject_id: input.author_canonical_id,
    data: { include_public: record.include_public, include_connections: record.include_connections, include_close: record.include_close }
  });
}

export async function deleteProjectedSubscription(
  ownerCanonicalId: string,
  authorCanonicalId: string
): Promise<void> {
  const subscriptionId = subscriptionRowId(ownerCanonicalId, authorCanonicalId);
  const db = await openLocalDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("subscriptions", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("failed to delete subscription"));
    tx.objectStore("subscriptions").delete(subscriptionId);
  });
  await appendLocalEvent(ownerCanonicalId, {
    event_id: crypto.randomUUID(),
    type: "subscription.removed",
    created_at: new Date().toISOString(),
    subject_id: authorCanonicalId
  });
}

export async function getProjectedSubscription(
  ownerCanonicalId: string,
  authorCanonicalId: string
): Promise<LocalSubscription | null> {
  return getRecord<LocalSubscription>("subscriptions", subscriptionRowId(ownerCanonicalId, authorCanonicalId));
}

export async function listLocalDrafts(ownerCanonicalId: string): Promise<LocalDraft[]> {
  return getAllByIndex<LocalDraft>("drafts", "by_owner", ownerCanonicalId);
}

export async function getSetting(key: string): Promise<unknown | null> {
  const record = await getRecord<LocalSetting>("settings", key);
  return record?.value ?? null;
}

export async function getLocalDeviceMetadata(): Promise<{ device_id: string; device_name: string; created_at: string } | null> {
  return (await getSetting("device.metadata")) as { device_id: string; device_name: string; created_at: string } | null;
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

// Future device sync will stream encrypted diffs derived from the append-only
// local event log rather than mirroring whole stores.
export async function listLocalSyncEvents(
  ownerCanonicalId: string,
  sinceCreatedAt?: string
): Promise<LocalEvent[]> {
  const events = await listLocalEvents(ownerCanonicalId);
  if (sinceCreatedAt === undefined) return events;
  return events.filter((event) => Date.parse(event.created_at) > Date.parse(sinceCreatedAt));
}

// Owner-scoped backup snapshot. Pulls only records belonging to the signed-in
// account from each private store. Crypto accounts and the device-metadata
// setting remain device-global and are filtered to the current account where
// applicable.
export async function exportAccountSnapshot(ownerCanonicalId: string): Promise<LocalStateSnapshot> {
  const cryptoAccount = await getCryptoAccount(ownerCanonicalId);
  return {
    events: await listLocalEvents(ownerCanonicalId),
    messages: await listLocalMessages(ownerCanonicalId),
    contacts: await listContacts(ownerCanonicalId),
    subscriptions: await listLocalSubscriptions(ownerCanonicalId),
    drafts: await listLocalDrafts(ownerCanonicalId),
    crypto_accounts: cryptoAccount === null ? [] : [cryptoAccount],
    trusted_devices: await listTrustedDevices(ownerCanonicalId),
    identities: [],
    settings: [],
    pending_outbound: await listPendingOutbound(ownerCanonicalId),
    device_sync_events: []
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
    putMany("trusted_devices", snapshot.trusted_devices),
    putMany("identities", snapshot.identities),
    putMany("settings", snapshot.settings),
    putMany("pending_outbound", snapshot.pending_outbound),
    putMany("device_sync_events", snapshot.device_sync_events)
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
    pending_outbound: await countStore("pending_outbound"),
    trusted_devices: await countStore("trusted_devices"),
    device_sync_events: await countStore("device_sync_events")
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

async function getAllByIndex<T>(storeName: LocalStoreName, indexName: string, key: IDBValidKey): Promise<T[]> {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const index = transaction.objectStore(storeName).index(indexName);
    const request = index.getAll(key);
    request.onsuccess = () => resolve((request.result as T[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error(`failed to read ${storeName}/${indexName}`));
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

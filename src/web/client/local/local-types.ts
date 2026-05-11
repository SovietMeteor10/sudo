import type { DeviceSyncEvent, IdentityDocument, RelayEnvelope, RelayEnvelopeStatus, TrustedDevice } from "../../../protocol/types.js";

export type LocalEventType =
  | "message.sent.local"
  | "message.received.local"
  | "message.receive.failed.local"
  | "message.acked.local"
  | "message.failed.local"
  | "contact.added"
  | "contact.blocked"
  | "contact.unblocked"
  | "contact.removed"
  | "subscription.added"
  | "subscription.removed"
  | "draft.saved"
  | "device.created";

export type LocalEvent = {
  event_id: string;
  // Stamped with the signed-in account's canonical id at write time so the
  // event log never bleeds across accounts on the same browser. Optional
  // only because the legacy device.created event is a pre-signin global.
  owner_canonical_id?: string;
  type: LocalEventType;
  created_at: string;
  subject_id?: string;
  data?: unknown;
};

export type LocalMessage = {
  message_id: string;
  // The signed-in account that owns this local copy of the message. Always
  // equal to the canonical id of the user whose browser stored the message,
  // never derived from sender/recipient — so account A never reads account
  // B's IndexedDB rows even when they ran in the same browser.
  owner_canonical_id: string;
  conversation_id: string;
  direction: "sent" | "received";
  sender_canonical_id: string;
  recipient_canonical_id: string;
  sender_handle?: string;
  recipient_handle?: string;
  body: string;
  ciphertext?: string;
  created_at: string;
  updated_at: string;
  status: RelayEnvelopeStatus;
  relay_message_id?: string;
  // Tombstone marker. When set, `body` and `ciphertext` are blanked
  // and the row only carries enough metadata to keep conversation
  // ordering stable. UI renders these as "message deleted". The
  // tombstone is sticky: once a message is deleted on any linked
  // device, a later message.upsert (e.g. a re-replay during backfill)
  // must NOT resurrect the plaintext.
  deleted_at?: string;
};

export type LocalContact = {
  // Composite primary key elements: contacts live under the account that
  // added them, so the same external canonical id can appear once per
  // owner.
  owner_canonical_id: string;
  canonical_id: string;
  handle: string;
  tier: "known" | "close" | "unknown" | "blocked";
  added_at: string;
  updated_at: string;
  fingerprint?: string;
};

export type LocalSubscription = {
  subscription_id: string;
  owner_canonical_id: string;
  source: string;
  created_at: string;
  // Optional richer fields populated when the subscription arrives via
  // the encrypted sync slice. Older legacy rows that only carry
  // `source` remain valid; these fields fill in when sync events
  // project author / visibility flags onto the row.
  author_canonical_id?: string;
  include_public?: boolean;
  include_connections?: boolean;
  include_close?: boolean;
  updated_at?: string;
};

export type LocalDraft = {
  draft_id: string;
  owner_canonical_id: string;
  conversation_id: string;
  body: string;
  updated_at: string;
};

// Per-target-device row recording how far the initial-state backfill
// has gotten. Status drives the retry loop: `pending` and `failed`
// are eligible for retry on the next signin / settings-open;
// `running` is in-flight; `complete` is terminal. Backoff is encoded
// implicitly via attempts (1 → 30s, 2 → 2m, 3+ → 10m) so the row
// itself doesn't need to carry a scheduled-at timestamp.
export type LocalBackfillState = {
  owner_canonical_id: string;
  target_device_id: string;
  status: "pending" | "running" | "complete" | "failed";
  attempts: number;
  last_attempt_at: string;
  last_error?: string;
  total_events?: number;
  slice_progress?: { [slice: string]: number };
};

export type LocalCryptoAccountRecord = {
  canonical_id: string;
  handle: string;
  home_node: string;
  identity_document_json: string;
  encrypted_bundle_json: string;
  created_at: string;
  updated_at: string;
};

export type LocalTrustedDevice = TrustedDevice;

export type LocalIdentityRecord = {
  canonical_id: string;
  document: IdentityDocument;
  seen_at: string;
};

export type LocalSetting = {
  key: string;
  value: unknown;
  updated_at: string;
};

export type PendingOutbound = {
  local_queue_id: string;
  owner_canonical_id: string;
  message_id: string;
  recipient_canonical_id: string;
  status: RelayEnvelopeStatus;
  envelope: RelayEnvelope;
  created_at: string;
  updated_at: string;
  last_error?: string;
};

export type LocalStateSnapshot = {
  events: LocalEvent[];
  messages: LocalMessage[];
  contacts: LocalContact[];
  subscriptions: LocalSubscription[];
  drafts: LocalDraft[];
  crypto_accounts: LocalCryptoAccountRecord[];
  trusted_devices: LocalTrustedDevice[];
  identities: LocalIdentityRecord[];
  settings: LocalSetting[];
  pending_outbound: PendingOutbound[];
  device_sync_events: DeviceSyncEvent[];
};

export type LocalStorageStatus = {
  events: number;
  messages: number;
  contacts: number;
  subscriptions: number;
  drafts: number;
  crypto_accounts: number;
  trusted_devices: number;
  identities: number;
  settings: number;
  pending_outbound: number;
  device_sync_events: number;
};

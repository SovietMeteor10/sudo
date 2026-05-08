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
  | "subscription.added"
  | "subscription.removed"
  | "draft.saved"
  | "device.created";

export type LocalEvent = {
  event_id: string;
  type: LocalEventType;
  created_at: string;
  subject_id?: string;
  data?: unknown;
};

export type LocalMessage = {
  message_id: string;
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
};

export type LocalContact = {
  canonical_id: string;
  handle: string;
  tier: "known" | "unknown" | "blocked";
  added_at: string;
  updated_at: string;
  fingerprint?: string;
};

export type LocalSubscription = {
  subscription_id: string;
  source: string;
  created_at: string;
};

export type LocalDraft = {
  draft_id: string;
  conversation_id: string;
  body: string;
  updated_at: string;
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

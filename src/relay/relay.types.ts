export type {
  CanonicalId,
  LegacyEncryptedMessageEnvelope,
  StoredEncryptedMessage
} from "../protocol/types.js";
import type { RelayEnvelope, RelayEnvelopeStatus } from "../protocol/types.js";

export type RelayTier = "known" | "unknown" | "blocked";

export type { RelayEnvelope, RelayEnvelopeStatus };

export type RelayPolicyError =
  | "sender_blocked"
  | "unknown_quota_exceeded"
  | "known_quota_exceeded"
  | "recipient_inbox_full"
  | "sender_outbox_full"
  | "pair_quota_exceeded"
  | "relay_full"
  | "message_too_large"
  | "invalid_envelope"
  | "duplicate_message"
  | "expired";

export type SubmitRelayEnvelopeResult =
  | {
      ok: true;
      message_id: string;
      status: "stored_by_relay";
      expires_at: string;
    }
  | {
      ok: false;
      error: RelayPolicyError;
    };

export type RelayRelationship = {
  sender_canonical_id: string;
  recipient_canonical_id: string;
  tier: RelayTier;
  created_at: string;
  updated_at: string;
};

import {
  DEFAULT_MAX_TEXT_MESSAGE_BYTES,
  DEFAULT_RELAY_GLOBAL_PENDING_CAP,
  DEFAULT_RELAY_RECIPIENT_PENDING_CAP,
  DEFAULT_RELAY_SENDER_PENDING_CAP,
  KNOWN_MAX_PENDING_PER_PAIR,
  KNOWN_TTL_DAYS,
  UNKNOWN_MAX_PENDING_PER_RECIPIENT,
  UNKNOWN_TTL_HOURS
} from "../protocol/constants.js";
import type { RelayPolicyError, RelayTier } from "./relay.types.js";

export type RelayTierPolicy = {
  tier: RelayTier;
  acceptsMessages: boolean;
  ttlHours: number;
  maxPendingMessages: number | null;
};

export type RelayPendingCounts = {
  global: number;
  recipient: number;
  sender: number;
  pair: number;
};

export type RelayPolicyDecision =
  | { ok: true; ttlHours: number }
  | { ok: false; error: RelayPolicyError };

export const relayTierPolicies: Record<RelayTier, RelayTierPolicy> = {
  known: {
    tier: "known",
    acceptsMessages: true,
    ttlHours: KNOWN_TTL_DAYS * 24,
    maxPendingMessages: KNOWN_MAX_PENDING_PER_PAIR
  },
  unknown: {
    tier: "unknown",
    acceptsMessages: true,
    ttlHours: UNKNOWN_TTL_HOURS,
    maxPendingMessages: UNKNOWN_MAX_PENDING_PER_RECIPIENT
  },
  blocked: {
    tier: "blocked",
    acceptsMessages: false,
    ttlHours: 0,
    maxPendingMessages: 0
  }
};

export const relayQuotaPolicy = {
  maxTextMessageBytes: DEFAULT_MAX_TEXT_MESSAGE_BYTES,
  globalPendingCap: DEFAULT_RELAY_GLOBAL_PENDING_CAP,
  recipientPendingCap: DEFAULT_RELAY_RECIPIENT_PENDING_CAP,
  senderPendingCap: DEFAULT_RELAY_SENDER_PENDING_CAP,
  unknownMaxPendingPerRecipient: UNKNOWN_MAX_PENDING_PER_RECIPIENT,
  knownMaxPendingPerPair: KNOWN_MAX_PENDING_PER_PAIR
};

export function evaluateRelayPolicy(
  tier: RelayTier,
  counts: RelayPendingCounts,
  ciphertextBytes: number
): RelayPolicyDecision {
  if (ciphertextBytes > relayQuotaPolicy.maxTextMessageBytes) {
    return { ok: false, error: "message_too_large" };
  }

  if (counts.global >= relayQuotaPolicy.globalPendingCap) {
    return { ok: false, error: "relay_full" };
  }

  if (counts.recipient >= relayQuotaPolicy.recipientPendingCap) {
    return { ok: false, error: "recipient_inbox_full" };
  }

  if (counts.sender >= relayQuotaPolicy.senderPendingCap) {
    return { ok: false, error: "sender_outbox_full" };
  }

  const tierPolicy = relayTierPolicies[tier];
  if (!tierPolicy.acceptsMessages) {
    return { ok: false, error: "sender_blocked" };
  }

  if (tier === "unknown" && counts.pair >= relayQuotaPolicy.unknownMaxPendingPerRecipient) {
    return { ok: false, error: "unknown_quota_exceeded" };
  }

  if (tier === "known" && counts.pair >= relayQuotaPolicy.knownMaxPendingPerPair) {
    return { ok: false, error: "known_quota_exceeded" };
  }

  return { ok: true, ttlHours: tierPolicy.ttlHours };
}

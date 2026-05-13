export const SUDO_PROTOCOL_VERSION = "0.1.0";

// Phase 11.5: raised from 3 → 200. The original 3 was a hard
// anti-spam cap meant to throttle unsolicited messages from
// strangers, but it made the very first conversation between two
// real users feel quota-blocked: a normal back-and-forth in an
// unread chat can hit 3 messages instantly, and the sender saw a
// raw "unknown_quota_exceeded" error. The real spam vector is
// bulk delivery; 200 pending unacked messages from one stranger
// is firmly in spam territory, while letting real conversations
// flow until the recipient device acks them.
export const UNKNOWN_MAX_PENDING_PER_RECIPIENT = 200;
export const KNOWN_MAX_PENDING_PER_PAIR = 1000;
export const UNKNOWN_TTL_HOURS = 72;
export const KNOWN_TTL_DAYS = 30;
export const DEFAULT_MAX_TEXT_MESSAGE_BYTES = 16 * 1024;
export const DEFAULT_MAX_TEXT_FEED_POST_BYTES = 16 * 1024;
export const DEFAULT_RELAY_GLOBAL_PENDING_CAP = 1_000_000;
export const DEFAULT_RELAY_RECIPIENT_PENDING_CAP = 10_000;
// Phase 11.5: raised from 500 → 10_000. A single sender can have
// up to N pending envelopes in flight (across all recipients) at
// once. 500 was hit by power users in long-running conversations;
// 10k is well past normal use but still finite for abuse detection.
export const DEFAULT_RELAY_SENDER_PENDING_CAP = 10_000;

export const DEFAULT_MESSAGE_TTL_UNKNOWN_HOURS = UNKNOWN_TTL_HOURS;
export const DEFAULT_MESSAGE_TTL_KNOWN_DAYS = KNOWN_TTL_DAYS;
export const MAX_UNKNOWN_PENDING_MESSAGES = UNKNOWN_MAX_PENDING_PER_RECIPIENT;

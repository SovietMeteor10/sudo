// Web Push delivery service.
//
// Privacy invariants (see Part B/C of the Phase-1 plan):
//   - Payloads NEVER include message body bytes. The shape is:
//       { conversation_hint, sender_handle, unread_count, schema_version }
//     "conversation_hint" is the peer canonical_id, which the server
//     already sees in plaintext on the relay envelope (it's the routing
//     key — there is no way to hide it from the relay).
//   - "sender_handle" is the public handle, also already plaintext to
//     the relay.
//   - "unread_count" is a small integer derived from server-side
//     pending counts; it's a side-channel hint, not message content.
//   - We pass the same generic payload regardless of whether the
//     conversation has disappearing messages on, because the relay
//     server is conversation_id-blind (envelopes are opaque blobs
//     keyed by recipient canonical_id). The receiving SW decides
//     whether to render preview text vs. "new message" using local
//     conversation_settings.
//
// Delivery is fire-and-forget from the relay path. Failures are logged
// and 404/410 endpoints are pruned from push_subscriptions so a dead
// device doesn't permanently re-queue retries.

import webpush, { type RequestOptions, type SendResult } from "web-push";
import { getVapidKeys } from "./push.config.js";
import {
  deletePushSubscriptionsByEndpoint,
  listPushSubscriptionsForRecipient,
  type PushSubscriptionRow
} from "./push.store.js";

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  const keys = getVapidKeys();
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  configured = true;
}

export type PushPayload = {
  schema_version: 1;
  conversation_hint: string;
  sender_handle: string;
  unread_count: number;
};

export function buildPushPayload(input: {
  conversationHint: string;
  senderHandle: string;
  unreadCount: number;
}): PushPayload {
  return {
    schema_version: 1,
    conversation_hint: input.conversationHint,
    sender_handle: input.senderHandle,
    unread_count: input.unreadCount
  };
}

// Test-only injection of a fetch-style delivery function. The smoke
// suite swaps web-push for a stub HTTP server so we don't need live
// FCM/Mozilla credentials at CI time. Production goes through web-push.
type DeliverFn = (subscription: PushSubscriptionRow, payload: PushPayload) => Promise<{ statusCode: number }>;
let injectedDeliver: DeliverFn | null = null;
export function setDeliverFnForTests(fn: DeliverFn | null): void {
  injectedDeliver = fn;
}

// Dev-only stub knob, used by smoke:web-push to exercise the prune /
// failure code paths without standing up a real FCM key or HTTPS
// endpoint. web-push hardcodes HTTPS so a localhost stub server is not
// reachable from it. The stub is gated on local-dev mode and per-call
// (the smoke sets a thread-local for one fan-out, then clears it) so
// production paths are never affected.
let stubModeOverride: number | null = null;
export function setStubStatusForTests(statusCode: number | null): void {
  if (process.env.NODE_ENV === "production"
      && process.env.SUDO_LOCAL_DEV !== "1"
      && process.env.SUDO_LOCAL_DEV !== "true") {
    return;
  }
  stubModeOverride = statusCode;
}

async function deliver(subscription: PushSubscriptionRow, payload: PushPayload): Promise<{ statusCode: number }> {
  if (injectedDeliver) return injectedDeliver(subscription, payload);
  if (stubModeOverride !== null) {
    const sc = stubModeOverride;
    if (sc >= 400) {
      const err = new Error(`stubbed ${sc}`) as Error & { statusCode: number };
      err.statusCode = sc;
      throw err;
    }
    return { statusCode: sc };
  }
  ensureConfigured();
  const opts: RequestOptions = { TTL: 60 * 60 * 24 }; // 24h queue at the provider
  const target = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
  };
  const result: SendResult = await webpush.sendNotification(target, JSON.stringify(payload), opts);
  return { statusCode: result.statusCode };
}

export type DeliveryStats = {
  attempted: number;
  delivered: number;
  pruned: number;
  failed: number;
};

// Quiet-hours abstraction. The current implementation always returns
// false (no quiet hours configured). Wired in here so the call site at
// fan-out time doesn't need to change when a UI lands later. The
// per-owner schedule will live in conversation_settings or a new
// table; until then this is a no-op.
function isQuietHoursForOwner(_ownerCanonicalId: string, _now: Date): boolean {
  return false;
}

export async function notifyEnvelopeRecipient(input: {
  recipientCanonicalId: string;
  senderCanonicalId: string;
  senderHandle: string;
  unreadCount: number;
  now?: Date;
}): Promise<DeliveryStats> {
  const stats: DeliveryStats = { attempted: 0, delivered: 0, pruned: 0, failed: 0 };
  const now = input.now ?? new Date();
  if (isQuietHoursForOwner(input.recipientCanonicalId, now)) return stats;

  const subs = listPushSubscriptionsForRecipient(input.recipientCanonicalId);
  if (subs.length === 0) return stats;

  // conversation_hint is the *peer* canonical_id from the recipient's
  // perspective (i.e. the sender). For 1:1 chats it identifies the
  // conversation the user would land in if they tap the notification.
  // The SW dedups by this hint — when a tab is foregrounded on this
  // peer, push toasts are suppressed.
  const payload = buildPushPayload({
    conversationHint: input.senderCanonicalId,
    senderHandle: input.senderHandle,
    unreadCount: input.unreadCount
  });

  await Promise.all(subs.map(async (sub) => {
    stats.attempted++;
    try {
      const { statusCode } = await deliver(sub, payload);
      if (statusCode >= 200 && statusCode < 300) {
        stats.delivered++;
      } else if (statusCode === 404 || statusCode === 410) {
        deletePushSubscriptionsByEndpoint(sub.endpoint);
        stats.pruned++;
      } else {
        stats.failed++;
      }
    } catch (err) {
      // web-push throws WebPushError on non-2xx. Inspect statusCode if
      // available; otherwise it's a transport-level fail and we leave
      // the row in place for a retry on the next message.
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        deletePushSubscriptionsByEndpoint(sub.endpoint);
        stats.pruned++;
      } else {
        if (process.env.SUDO_PUSH_DEBUG === "1") {
          // eslint-disable-next-line no-console
          console.warn("[push] deliver threw", { status, err: String((err as Error)?.message ?? err) });
        }
        stats.failed++;
      }
    }
  }));

  return stats;
}

// Convenience for the relay hook — never throws, never blocks the
// caller. The relay submit path is in-band with the user-visible POST
// /api/relay/envelopes response; we cannot afford to wait on a third-
// party HTTPS round-trip.
export function fireAndForgetPush(input: {
  recipientCanonicalId: string;
  senderCanonicalId: string;
  senderHandle: string;
  unreadCount: number;
}): void {
  // Best-effort scheduling. Use setImmediate so the relay route returns
  // first. Any throw inside notifyEnvelopeRecipient is swallowed here.
  setImmediate(() => {
    notifyEnvelopeRecipient(input).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[push] fan-out failed", err);
    });
  });
}

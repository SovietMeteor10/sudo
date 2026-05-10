// Lower-left notifications coordinator. Polls the read-only
// /api/notifications/incoming endpoint (follow notifications +
// reaction / reply / repost notifications derived server-side from
// existing canonical state — no separate notifications table),
// filters out anything the recipient device has already dismissed
// (kept in IndexedDB so reload preserves state), and re-renders
// into the notifications panel. Dismissal lives client-side because
// the underlying social-action rows are owner-canonical on the
// server — we don't add a server-side dismissed table for the MVP.
//
// Actions:
//   - follow-back / block : drives the existing relationship helpers
//   - view                : opens the relevant post via onView()
//   - dismiss             : local-only mark
//   - clear-all           : marks every visible row dismissed in one
//                           write so the list returns to "no
//                           notifications"; persists across reload.

import {
  listConnections,
  listFeedSubscriptions,
  listIncomingSocialNotifications,
  upsertConnectionRelationship
} from "../api.js";
import { applyContactUpsertWithBroadcast } from "../sync/contactSync.js";
import { applySubscriptionUpsertWithBroadcast } from "../sync/subscriptionSync.js";
import {
  getSetting,
  putSetting
} from "../local/local-store.js";
import {
  renderNotificationsPanel,
  type NotificationActionKind
} from "../components.js";
import type { ConnectionRelationship, SocialNotification } from "../types.js";

const POLL_INTERVAL_MS = 12000;

type Coordinator = {
  ownerCanonicalId: string;
  list: HTMLElement;
  empty: HTMLElement;
  clearAllButton: HTMLButtonElement | null;
  onView: ((postId: string) => void) | null;
  onChatTargetsChanged: (() => void) | null;
  // Last-rendered visible ids — used by clear-all so we can dismiss
  // exactly what the user can see, even if the next poll arrives
  // before the click.
  lastVisibleIds: string[];
};

let active: Coordinator | null = null;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let polling = false;

function dismissedKey(ownerCanonicalId: string): string {
  return `notifications.dismissed:${ownerCanonicalId}`;
}

async function readDismissed(ownerCanonicalId: string): Promise<Set<string>> {
  const value = (await getSetting(dismissedKey(ownerCanonicalId))) as string[] | null;
  return new Set(Array.isArray(value) ? value : []);
}

async function writeDismissed(ownerCanonicalId: string, dismissed: Set<string>): Promise<void> {
  await putSetting(dismissedKey(ownerCanonicalId), [...dismissed]);
}

export type StartNotificationsOptions = {
  list: HTMLElement;
  empty: HTMLElement;
  clearAllButton?: HTMLButtonElement | null;
  onView?: (postId: string) => void;
  // Called after a `connection_confirmed` notification has been
  // auto-handled and a chat-eligible contact was upserted, so the
  // host UI can refresh its chat list immediately.
  onChatTargetsChanged?: () => void;
};

export function startNotificationsPolling(
  ownerCanonicalId: string,
  options: StartNotificationsOptions
): void {
  stopNotificationsPolling();
  active = {
    ownerCanonicalId,
    list: options.list,
    empty: options.empty,
    clearAllButton: options.clearAllButton ?? null,
    onView: options.onView ?? null,
    onChatTargetsChanged: options.onChatTargetsChanged ?? null,
    lastVisibleIds: []
  };
  if (active.clearAllButton !== null) {
    active.clearAllButton.addEventListener("click", handleClearAll);
  }
  void pollOnce();
  pollHandle = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopNotificationsPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (active !== null) {
    if (active.clearAllButton !== null) {
      active.clearAllButton.removeEventListener("click", handleClearAll);
      active.clearAllButton.hidden = true;
    }
    active.list.replaceChildren();
    active.list.hidden = true;
    active.empty.hidden = false;
  }
  active = null;
}

function handleClearAll(): void {
  if (active === null) return;
  const ownerCanonicalId = active.ownerCanonicalId;
  const ids = [...active.lastVisibleIds];
  if (ids.length === 0) return;
  void (async () => {
    const dismissed = await readDismissed(ownerCanonicalId);
    for (const id of ids) dismissed.add(id);
    await writeDismissed(ownerCanonicalId, dismissed);
    void pollOnce();
  })();
}

async function pollOnce(): Promise<void> {
  if (active === null || polling) return;
  polling = true;
  try {
    const { ownerCanonicalId, list, empty, clearAllButton } = active;
    const [incoming, dismissed, ownConnections, ownSubscriptions] = await Promise.all([
      listIncomingSocialNotifications(ownerCanonicalId).catch(() => [] as SocialNotification[]),
      readDismissed(ownerCanonicalId),
      listConnections(ownerCanonicalId).catch(() => [] as ConnectionRelationship[]),
      listFeedSubscriptions(ownerCanonicalId).catch(() => [])
    ]);

    if (active === null || active.ownerCanonicalId !== ownerCanonicalId) return;

    // Auto-handle connection_confirmed: server has detected mutual
    // subscriptions, so promote the peer to a known contact (which
    // is what unlocks the chat target on this side) and dismiss the
    // notification immediately. This is the ONLY path that creates a
    // chat-eligible contact; raw follow alone never does.
    let dismissedDirty = false;
    for (const notification of incoming) {
      if (notification.kind !== "connection_confirmed") continue;
      if (dismissed.has(notification.id)) continue;
      try {
        await upsertConnectionRelationship({
          owner_canonical_id: ownerCanonicalId,
          subject_canonical_id: notification.actor_canonical_id,
          subject_handle: notification.actor_handle,
          tier: "known",
          subscribed: true
        });
        await applyContactUpsertWithBroadcast(ownerCanonicalId, {
          canonical_id: notification.actor_canonical_id,
          handle: notification.actor_handle ?? notification.actor_canonical_id,
          tier: "known",
          added_at: notification.created_at,
          updated_at: notification.updated_at
        });
        dismissed.add(notification.id);
        dismissedDirty = true;
      } catch (error) {
        // Best-effort: keep the notification visible; the next poll
        // will retry. We don't want to drop the row silently if the
        // promotion failed.
        console.warn("[notifications] connection_confirmed auto-promote failed", error instanceof Error ? error.message : error);
      }
    }
    if (dismissedDirty) {
      await writeDismissed(ownerCanonicalId, dismissed);
      try { active?.onChatTargetsChanged?.(); } catch { /* ignore */ }
    }

    const visible = incoming.filter((notification) => !dismissed.has(notification.id));
    active.lastVisibleIds = visible.map((notification) => notification.id);

    const connectionMap = new Map<string, ConnectionRelationship["tier"]>();
    for (const relationship of ownConnections) {
      connectionMap.set(relationship.subject_canonical_id, relationship.tier);
    }
    const subscriptionSet = new Set<string>();
    for (const sub of ownSubscriptions) {
      if (!sub.muted) subscriptionSet.add(sub.author_canonical_id);
    }

    renderNotificationsPanel(
      list,
      empty,
      clearAllButton,
      {
        notifications: visible,
        ownConnections: connectionMap,
        ownSubscriptions: subscriptionSet
      },
      (notification, action) => {
        void handleNotificationAction(ownerCanonicalId, notification, action);
      }
    );
  } finally {
    polling = false;
  }
}

async function handleNotificationAction(
  ownerCanonicalId: string,
  notification: SocialNotification,
  action: NotificationActionKind
): Promise<void> {
  if (active === null || active.ownerCanonicalId !== ownerCanonicalId) return;

  // "view" is the one action that doesn't dismiss the row — the
  // user might want to see the same post twice. Hand off to
  // main.ts's thread navigator and stop here.
  if (action === "view") {
    if (typeof notification.post_id === "string" && notification.post_id.length > 0
        && active.onView !== null) {
      try { active.onView(notification.post_id); } catch { /* ignore */ }
    }
    return;
  }

  try {
    if (action === "follow-back") {
      await applySubscriptionUpsertWithBroadcast(ownerCanonicalId, {
        author_canonical_id: notification.actor_canonical_id,
        author_handle: notification.actor_handle,
        include_public: true,
        include_connections: true,
        include_close: false,
        muted: false
      });
    } else if (action === "block") {
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: notification.actor_canonical_id,
        subject_handle: notification.actor_handle,
        tier: "blocked",
        subscribed: false
      });
      await applyContactUpsertWithBroadcast(ownerCanonicalId, {
        canonical_id: notification.actor_canonical_id,
        handle: notification.actor_handle ?? notification.actor_canonical_id,
        tier: "blocked",
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  } catch (error) {
    console.warn("[notifications] action failed", error instanceof Error ? error.message : error);
  }

  // Always dismiss locally after follow-back / block / dismiss; the
  // notification has been "handled" from the user's POV. View skips
  // dismissal (handled above).
  const dismissed = await readDismissed(ownerCanonicalId);
  dismissed.add(notification.id);
  await writeDismissed(ownerCanonicalId, dismissed);

  // Re-render immediately so the row disappears without waiting for
  // the next interval.
  void pollOnce();
}

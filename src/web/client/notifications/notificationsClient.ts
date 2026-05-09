// Lower-left notifications coordinator. Polls the read-only
// /api/notifications/incoming endpoint, filters out anything the
// recipient device has already dismissed (kept in IndexedDB so
// reload preserves state), and re-renders into the notifications
// panel. Dismissal lives client-side because the underlying social
// actions (follow / connect) are still owner-canonical on the
// server — we don't add a server-side dismissed table for the MVP.
//
// No new architecture: piggy-backs on the existing settings store
// and the same lookup-pane relationship helpers that drive the
// "connect back" / "block" actions.

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

export function startNotificationsPolling(
  ownerCanonicalId: string,
  list: HTMLElement,
  empty: HTMLElement
): void {
  stopNotificationsPolling();
  active = { ownerCanonicalId, list, empty };
  void pollOnce();
  pollHandle = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopNotificationsPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (active !== null) {
    active.list.replaceChildren();
    active.list.hidden = true;
    active.empty.hidden = false;
  }
  active = null;
}

async function pollOnce(): Promise<void> {
  if (active === null || polling) return;
  polling = true;
  try {
    const { ownerCanonicalId, list, empty } = active;
    const [incoming, dismissed, ownConnections, ownSubscriptions] = await Promise.all([
      listIncomingSocialNotifications(ownerCanonicalId).catch(() => [] as SocialNotification[]),
      readDismissed(ownerCanonicalId),
      listConnections(ownerCanonicalId).catch(() => [] as ConnectionRelationship[]),
      listFeedSubscriptions(ownerCanonicalId).catch(() => [])
    ]);

    if (active === null || active.ownerCanonicalId !== ownerCanonicalId) return;

    const visible = incoming.filter((notification) => !dismissed.has(notification.id));

    const connectionMap = new Map<string, ConnectionRelationship["tier"]>();
    for (const relationship of ownConnections) {
      connectionMap.set(relationship.subject_canonical_id, relationship.tier);
    }
    const subscriptionSet = new Set<string>();
    for (const sub of ownSubscriptions) {
      if (!sub.muted) subscriptionSet.add(sub.author_canonical_id);
    }

    renderNotificationsPanel(list, empty, visible, connectionMap, subscriptionSet, (notification, action) => {
      void handleNotificationAction(ownerCanonicalId, notification, action);
    });
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
    } else if (action === "connect-back") {
      // Reciprocate the trust tier the actor chose. Default to known
      // when the actor's tier is missing (older event).
      const tier = notification.tier === "close" ? "close" : "known";
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: notification.actor_canonical_id,
        subject_handle: notification.actor_handle,
        tier,
        subscribed: true
      });
      await applyContactUpsertWithBroadcast(ownerCanonicalId, {
        canonical_id: notification.actor_canonical_id,
        handle: notification.actor_handle ?? notification.actor_canonical_id,
        tier,
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
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

  // Always dismiss locally after any of the above actions; the
  // notification has been "handled" from the user's POV.
  const dismissed = await readDismissed(ownerCanonicalId);
  dismissed.add(notification.id);
  await writeDismissed(ownerCanonicalId, dismissed);

  // Re-render immediately so the row disappears without waiting for
  // the next interval.
  void pollOnce();
}

// Conversation-settings slice. One row per (owner, conversation_id)
// carrying per-chat preferences shared with the peer through sync.
// Today this is just the disappearing-messages TTL but the same row
// is intentionally shaped to absorb future per-conversation prefs
// (mute, pinned, etc.) without a second slice.
//
// Merge policy is monotonic on updated_at: a later (or equal-newer)
// event wins, so re-replays during initial-state backfill never
// undo a change the user just made. The slice carries the actor's
// canonical id + optional handle so the inline "@alice changed
// message expiry to 24 hours" system message can render across
// linked devices the same way it does for the actor.
//
// What is deliberately NOT in this slice:
//   - any plaintext peer canonical ids beyond the conversation key
//     (already an opaque sorted pair on the wire)
//   - per-device UI flags (notification sound, scroll position)
//   - per-message reaction state
// Those stay on the writing device per the "sync is explicit, not
// automatic" policy in docs/SECURITY.md.

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import {
  appendConversationSystemEvent,
  getConversationSettings,
  upsertConversationSettingsMonotonic
} from "../local/local-store.js";

type ConversationSettingsPayload = {
  conversation_id: string;
  message_ttl_seconds: number;
  updated_at: string;
  updated_by_canonical_id: string;
  updated_by_handle?: string;
  // Symmetric with read_state.upsert; the projector rejects events
  // whose owner doesn't match the active account.
  owner_canonical_id?: string;
};

// User-driven settings change: write locally, then broadcast. The
// local write is the source of truth so the gear-icon dialog
// closes immediately even when offline. Returns whether anything
// changed so the system-message + UI refresh can skip on no-ops.
export async function notifyConversationSettingsUpsert(
  ownerCanonicalId: string,
  patch: {
    conversation_id: string;
    message_ttl_seconds: number;
    updated_by_canonical_id: string;
    updated_by_handle?: string;
  }
): Promise<{ written: boolean; broadcast: boolean; row: { message_ttl_seconds: number } | null }> {
  const now = new Date().toISOString();
  const result = await upsertConversationSettingsMonotonic(ownerCanonicalId, {
    conversation_id: patch.conversation_id,
    message_ttl_seconds: patch.message_ttl_seconds,
    updated_at: now,
    updated_by_canonical_id: patch.updated_by_canonical_id,
    updated_by_handle: patch.updated_by_handle
  });
  if (!result.written) {
    return { written: false, broadcast: false, row: result.row };
  }
  // Locally append the system message so the actor sees the change
  // in their own chat without waiting for the projector round-trip.
  await appendConversationSystemEvent(ownerCanonicalId, {
    event_id: `cs:${patch.conversation_id}:${now}`,
    conversation_id: patch.conversation_id,
    created_at: now,
    kind: "conversation_settings_change",
    text: describeTtlChange(patch.message_ttl_seconds, patch.updated_by_handle, patch.updated_by_canonical_id, ownerCanonicalId)
  });
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) {
    return { written: true, broadcast: false, row: result.row };
  }
  const payload: ConversationSettingsPayload = {
    conversation_id: patch.conversation_id,
    message_ttl_seconds: patch.message_ttl_seconds,
    updated_at: now,
    updated_by_canonical_id: patch.updated_by_canonical_id,
    updated_by_handle: patch.updated_by_handle,
    owner_canonical_id: ownerCanonicalId
  };
  const broadcast = await buildAndPostSyncEvent("conversation_settings", "conversation_settings.upsert", payload);
  return { written: true, broadcast, row: result.row };
}

// Pretty-print the inline system message. We pick the handle when
// available because canonical ids are long and noisy; the user
// sees "@alice" not "sudo:ed25519:abc…". When the actor is the
// device's owner we use "you" to read naturally.
export function describeTtlChange(seconds: number, handle: string | undefined, actorCanonicalId: string, ownerCanonicalId: string): string {
  const actor = actorCanonicalId === ownerCanonicalId ? "you" : (handle ? (handle.startsWith("@") ? handle : `@${handle}`) : "the other person");
  const label = ttlLabel(seconds);
  if (seconds <= 0) {
    return `${actor} turned off disappearing messages`;
  }
  return `${actor} set disappearing messages to ${label}`;
}

function ttlLabel(seconds: number): string {
  if (seconds <= 0) return "off";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hour${Math.round(seconds / 3600) === 1 ? "" : "s"}`;
  if (seconds < 2592000) return `${Math.round(seconds / 86400)} day${Math.round(seconds / 86400) === 1 ? "" : "s"}`;
  return `${Math.round(seconds / 2592000)} month${Math.round(seconds / 2592000) === 1 ? "" : "s"}`;
}

registerSliceProjector("conversation_settings", async (account, event, payload) => {
  if (event.kind !== "conversation_settings.upsert") return false;
  const p = payload as Partial<ConversationSettingsPayload>;
  if (typeof p.conversation_id !== "string") return false;
  if (typeof p.message_ttl_seconds !== "number") return false;
  if (typeof p.updated_at !== "string") return false;
  if (typeof p.updated_by_canonical_id !== "string") return false;
  if (typeof p.owner_canonical_id === "string" && p.owner_canonical_id !== account.canonical_id) {
    return false;
  }
  const prior = await getConversationSettings(account.canonical_id, p.conversation_id);
  const result = await upsertConversationSettingsMonotonic(account.canonical_id, {
    conversation_id: p.conversation_id,
    message_ttl_seconds: p.message_ttl_seconds,
    updated_at: p.updated_at,
    updated_by_canonical_id: p.updated_by_canonical_id,
    updated_by_handle: p.updated_by_handle
  });
  if (result.written && (prior === null || prior.message_ttl_seconds !== p.message_ttl_seconds)) {
    await appendConversationSystemEvent(account.canonical_id, {
      event_id: `cs:${p.conversation_id}:${p.updated_at}`,
      conversation_id: p.conversation_id,
      created_at: p.updated_at,
      kind: "conversation_settings_change",
      text: describeTtlChange(
        p.message_ttl_seconds,
        p.updated_by_handle,
        p.updated_by_canonical_id,
        account.canonical_id
      )
    });
  }
  return true;
});

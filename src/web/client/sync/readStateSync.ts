// Read-state slice. One row per (owner, conversation_id) carrying
// the last-read timestamp and an optional last-read message pointer.
// Drives the chat-list unread badge and converges across linked
// devices: opening a chat on desktop clears the unread count on
// mobile, and vice versa.
//
// Why a dedicated slice rather than piggybacking on contact or
// message: read state has its own lifecycle (changes on every
// chat-open, not on contact/message writes), its own merge rule
// (monotonic by last_read_at, no UI history), and it intentionally
// carries NO message body or peer plaintext — only the
// conversation_id (which is already an opaque sorted pair on the
// wire, never plaintext canonical_ids).
//
// What is deliberately NOT in this slice:
//   - per-message read receipts (would mean an event per message;
//     out of scope for the current "look the same on every device"
//     goal)
//   - dismissal flags, scroll positions, draft cursor positions
//     (those are per-device UI state, see docs/SECURITY.md on the
//     "sync is explicit, not automatic" policy)

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import { upsertReadStateMonotonic } from "../local/local-store.js";

type ReadStatePayload = {
  conversation_id: string;
  last_read_message_id?: string;
  last_read_at: string;
  // The owner_canonical_id is included for symmetry with other
  // slices' payloads and to let the projector reject cross-account
  // events early.
  owner_canonical_id?: string;
};

// User-driven mark-as-read path. Writes locally first (so the badge
// clears immediately even if we're offline), then broadcasts the
// upsert. The local write is the source of truth; the broadcast is
// best-effort. Returns whether anything actually changed so callers
// can skip downstream work on a no-op.
export async function notifyReadStateUpsert(
  ownerCanonicalId: string,
  patch: { conversation_id: string; last_read_message_id?: string; last_read_at: string }
): Promise<{ written: boolean; broadcast: boolean }> {
  const result = await upsertReadStateMonotonic(ownerCanonicalId, patch);
  if (!result.written) return { written: false, broadcast: false };
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) {
    return { written: true, broadcast: false };
  }
  const payload: ReadStatePayload = {
    conversation_id: result.row.conversation_id,
    last_read_at: result.row.last_read_at,
    owner_canonical_id: ownerCanonicalId
  };
  if (typeof result.row.last_read_message_id === "string") {
    payload.last_read_message_id = result.row.last_read_message_id;
  }
  const broadcast = await buildAndPostSyncEvent("read_state", "read_state.upsert", payload);
  return { written: true, broadcast };
}

registerSliceProjector("read_state", async (account, event, payload) => {
  if (event.kind !== "read_state.upsert") return false;
  const p = payload as Partial<ReadStatePayload>;
  if (typeof p.conversation_id !== "string" || typeof p.last_read_at !== "string") return false;
  if (typeof p.owner_canonical_id === "string" && p.owner_canonical_id !== account.canonical_id) {
    return false;
  }
  // The local upsert is itself monotonic, so applying a peer's event
  // that's older than what we already have is a safe no-op. We still
  // return true so the cursor advances past the event.
  await upsertReadStateMonotonic(account.canonical_id, {
    conversation_id: p.conversation_id,
    last_read_at: p.last_read_at,
    last_read_message_id: typeof p.last_read_message_id === "string" ? p.last_read_message_id : undefined
  });
  return true;
});

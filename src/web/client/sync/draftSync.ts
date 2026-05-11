// Draft slice of trusted-device sync. Same shape as contactSync.ts.
//
// Contracts:
//   - applyDraftUpsertWithBroadcast / applyDraftDeleteWithBroadcast
//     are called from user-driven UI flows. They write locally first,
//     then broadcast a sync event.
//   - The projector calls upsertLocalDraft / deleteLocalDraft
//     directly (NOT the broadcast wrappers) so applying a peer's
//     event cannot trigger an echo.
//   - Drafts are owner-scoped via owner_canonical_id; the projector
//     stamps it from the active account so a malformed event can't
//     forge an owner.

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import {
  deleteLocalDraft,
  upsertLocalDraft
} from "../local/local-store.js";
import type { LocalDraft } from "../local/local-types.js";

export async function applyDraftUpsertWithBroadcast(
  ownerCanonicalId: string,
  draft: Omit<LocalDraft, "owner_canonical_id">
): Promise<void> {
  const record: LocalDraft = { ...draft, owner_canonical_id: ownerCanonicalId };
  await upsertLocalDraft(record);
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return;
  void buildAndPostSyncEvent("draft", "draft.upsert", {
    draft_id: record.draft_id,
    conversation_id: record.conversation_id,
    body: record.body,
    updated_at: record.updated_at
  });
}

export async function applyDraftDeleteWithBroadcast(
  ownerCanonicalId: string,
  draftId: string
): Promise<void> {
  await deleteLocalDraft(draftId);
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return;
  void buildAndPostSyncEvent("draft", "draft.delete", { draft_id: draftId });
}

registerSliceProjector("draft", async (account, event, payload) => {
  if (event.kind === "draft.upsert"
    && typeof payload.draft_id === "string"
    && typeof payload.conversation_id === "string"
    && typeof payload.body === "string"
  ) {
    await upsertLocalDraft({
      draft_id: String(payload.draft_id),
      owner_canonical_id: account.canonical_id,
      conversation_id: String(payload.conversation_id),
      body: String(payload.body),
      updated_at: typeof payload.updated_at === "string" ? payload.updated_at : new Date().toISOString()
    });
    return true;
  }
  if (event.kind === "draft.delete" && typeof payload.draft_id === "string") {
    await deleteLocalDraft(String(payload.draft_id));
    return true;
  }
  return false;
});

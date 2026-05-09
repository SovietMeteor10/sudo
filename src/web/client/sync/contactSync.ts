// Contact slice of trusted-device sync. Plugs into the shared
// coordinator (src/web/client/sync/coordinator.ts) — this module
// contributes the contact projector and the user-driven helpers that
// wrap a local IndexedDB write together with a best-effort encrypted
// sync event.
//
// Contracts:
//   - applyContactUpsertWithBroadcast / applyContactDeleteWithBroadcast
//     are called from user-driven UI flows. They write locally first,
//     then broadcast. If the sync POST fails (offline, no membership
//     yet, etc.) the local write still stands.
//   - The receiver-side projector calls upsertContact/deleteLocalContact
//     directly — never through the broadcast wrapper — so applying
//     a peer's event cannot trigger a sync echo.

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import {
  deleteLocalContact,
  upsertContact
} from "../local/local-store.js";
import type { LocalContact } from "../local/local-types.js";

export async function applyContactUpsertWithBroadcast(
  ownerCanonicalId: string,
  contact: Omit<LocalContact, "owner_canonical_id">
): Promise<void> {
  await upsertContact(ownerCanonicalId, contact);
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return;
  void buildAndPostSyncEvent("contact", "contact.upsert", {
    canonical_id: contact.canonical_id,
    handle: contact.handle,
    tier: contact.tier,
    added_at: contact.added_at,
    updated_at: contact.updated_at,
    fingerprint: contact.fingerprint
  });
}

export async function applyContactDeleteWithBroadcast(
  ownerCanonicalId: string,
  canonicalId: string
): Promise<void> {
  await deleteLocalContact(ownerCanonicalId, canonicalId);
  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return;
  void buildAndPostSyncEvent("contact", "contact.delete", { canonical_id: canonicalId });
}

// Inbound projection. Trusts the verified+decrypted payload from the
// coordinator. Writes via the low-level local-store helpers (NOT the
// broadcast wrappers) so applying an event cannot trigger another.
registerSliceProjector("contact", async (account, event, payload) => {
  if (event.kind === "contact.upsert" && typeof payload.canonical_id === "string") {
    await upsertContact(account.canonical_id, {
      canonical_id: String(payload.canonical_id),
      handle: typeof payload.handle === "string" ? payload.handle : String(payload.canonical_id),
      tier: (payload.tier as LocalContact["tier"]) ?? "known",
      added_at: typeof payload.added_at === "string" ? payload.added_at : new Date().toISOString(),
      updated_at: typeof payload.updated_at === "string" ? payload.updated_at : new Date().toISOString(),
      fingerprint: typeof payload.fingerprint === "string" ? payload.fingerprint : undefined
    });
    return true;
  }
  if (event.kind === "contact.delete" && typeof payload.canonical_id === "string") {
    await deleteLocalContact(account.canonical_id, String(payload.canonical_id));
    return true;
  }
  return false;
});

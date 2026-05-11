// Profile slice of trusted-device sync. Carries account-wide
// fields the user expects to look the same on every linked device:
//
//   - bio: free-text profile bio the user types in the account
//     dialog. Today stored under settings key `profile.bio.<canonical>`.
//   - last_backup_at: timestamp of the most recent successful
//     `.sudo-backup.json` export. Used by the passive recovery
//     indicator in the account dropdown; a user who exported on
//     their desktop and then opens the app on their phone should
//     see the same "✓ backup" posture there.
//
// Both fields are persisted in the existing `settings` store, so
// the projector reads/writes through getSetting/putSetting (which
// the backup export and bio save flows also use). One payload per
// upsert keeps the protocol simple — bio updates are infrequent
// and the field is bounded (280 chars).
//
// What is deliberately NOT in this slice:
//   - device.metadata (per-device by design; ensureCurrentDeviceId
//     mints a fresh one per install)
//   - profile.signinCount.* / profile.firstSeenAt.* (per-device
//     session bookkeeping)
//
// And more broadly: there is no generic "settings.upsert" slice. The
// settings IndexedDB store is a kitchen drawer — it holds the bio,
// the backup timestamp, per-device sync cursors, dismissals,
// session markers, transient dialog state. Replicating it wholesale
// would (a) loop (a write applied on the peer would echo back),
// (b) leak per-device cursors and secrets cross-device, and
// (c) surprise the user with cross-device UI behavior (a reminder
// dismissed on desktop shouldn't disappear on mobile). Each piece of
// account-wide state we DO want synced gets its own slice, like this
// one. See src/protocol/types.ts and docs/SECURITY.md for the policy.
//
// Contracts mirror contactSync.ts: broadcast wrappers fire on user
// writes; the projector calls putSetting directly so applying a
// peer's event can't trigger an echo.

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import { getSetting, putSetting } from "../local/local-store.js";

type ProfilePayload = {
  bio?: string;
  last_backup_at?: string;
};

function bioKey(canonicalId: string): string { return `profile.bio.${canonicalId}`; }
function lastBackupAtKey(canonicalId: string): string { return `profile.lastBackupAt.${canonicalId}`; }

// Called from the account dialog "save bio" path AND from
// exportEncryptedBackup. Either may pass partial fields; we read
// any unspecified value out of the local store so the broadcast
// always carries the full current state (an idempotent overwrite
// on the remote side).
export async function applyProfileUpsertWithBroadcast(
  ownerCanonicalId: string,
  patch: ProfilePayload
): Promise<void> {
  // Apply the patch to the local settings store first.
  if (typeof patch.bio === "string") await putSetting(bioKey(ownerCanonicalId), patch.bio);
  if (typeof patch.last_backup_at === "string") await putSetting(lastBackupAtKey(ownerCanonicalId), patch.last_backup_at);

  const account = activeAccount();
  if (account === null || account.canonical_id !== ownerCanonicalId) return;

  // Build the full current payload so the projector on the other
  // device gets a complete picture even if only one field changed.
  const bioValue = await getSetting(bioKey(ownerCanonicalId));
  const lastBackupValue = await getSetting(lastBackupAtKey(ownerCanonicalId));
  const out: ProfilePayload = {};
  if (typeof bioValue === "string") out.bio = bioValue;
  if (typeof lastBackupValue === "string") out.last_backup_at = lastBackupValue;
  void buildAndPostSyncEvent("profile", "profile.upsert", out);
}

registerSliceProjector("profile", async (account, event, payload) => {
  if (event.kind !== "profile.upsert") return false;
  const p = payload as ProfilePayload;
  // Apply each field independently; absent fields don't clear the
  // local value (peer might have sent a partial update or rolled in
  // from an older client). Each putSetting is idempotent.
  if (typeof p.bio === "string") await putSetting(bioKey(account.canonical_id), p.bio);
  if (typeof p.last_backup_at === "string") await putSetting(lastBackupAtKey(account.canonical_id), p.last_backup_at);
  return true;
});

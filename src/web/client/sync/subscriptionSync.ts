// Subscription slice of trusted-device sync. Plugs into the shared
// poller in contactSync.ts via registerSliceProjector. The protocol
// shape mirrors the contact slice — local write first, then a
// best-effort encrypted sync event signed by the device key.
//
// Subscriptions are still hosted as a server-canonical resource
// (POST /api/subscriptions) so the personal-feed query can filter
// without round-tripping every device. The sync event carries the
// same intent in encrypted form so paired devices observe a
// projected local copy and can react without re-querying the server.

import { upsertFeedSubscription as serverUpsertFeedSubscription, deleteFeedSubscription as serverDeleteFeedSubscription } from "../api.js";
import {
  buildAndPostSyncEvent,
  registerSliceProjector
} from "./coordinator.js";
import {
  deleteProjectedSubscription,
  upsertProjectedSubscription
} from "../local/local-store.js";

export type ProjectedSubscriptionPayload = {
  author_canonical_id: string;
  include_public: boolean;
  include_connections: boolean;
  include_close: boolean;
  updated_at: string;
};

export type ApplySubscriptionUpsertInput = {
  author_canonical_id: string;
  author_handle?: string;
  include_public: boolean;
  include_connections: boolean;
  include_close: boolean;
  muted: boolean;
};

// Mutate the server-canonical subscription, project locally, and
// best-effort post the encrypted sync event. The server upsert and
// the local projection both run regardless of whether the sync POST
// succeeds — sync delivery is convenience, not the source of truth.
export async function applySubscriptionUpsertWithBroadcast(
  ownerCanonicalId: string,
  input: ApplySubscriptionUpsertInput
): Promise<void> {
  await serverUpsertFeedSubscription({
    owner_canonical_id: ownerCanonicalId,
    author_canonical_id: input.author_canonical_id,
    author_handle: input.author_handle,
    include_public: input.include_public,
    include_connections: input.include_connections,
    include_close: input.include_close,
    muted: input.muted
  });
  const updatedAt = new Date().toISOString();
  await upsertProjectedSubscription(ownerCanonicalId, {
    author_canonical_id: input.author_canonical_id,
    include_public: input.include_public,
    include_connections: input.include_connections,
    include_close: input.include_close,
    updated_at: updatedAt
  });
  void buildAndPostSyncEvent("subscription", "subscription.upsert", {
    author_canonical_id: input.author_canonical_id,
    include_public: input.include_public,
    include_connections: input.include_connections,
    include_close: input.include_close,
    updated_at: updatedAt
  } satisfies ProjectedSubscriptionPayload);
}

export async function applySubscriptionDeleteWithBroadcast(
  ownerCanonicalId: string,
  authorCanonicalId: string
): Promise<void> {
  await serverDeleteFeedSubscription(ownerCanonicalId, authorCanonicalId);
  await deleteProjectedSubscription(ownerCanonicalId, authorCanonicalId);
  void buildAndPostSyncEvent("subscription", "subscription.delete", {
    author_canonical_id: authorCanonicalId
  });
}

// Receiver-side projection. Runs after the shared poller has verified
// signature, decrypted the payload, and confirmed the origin device's
// active membership. Idempotent on retry: writing the same payload
// twice is a no-op.
registerSliceProjector("subscription", async (account, event, payload) => {
  if (event.kind === "subscription.upsert" && typeof payload.author_canonical_id === "string") {
    await upsertProjectedSubscription(account.canonical_id, {
      author_canonical_id: String(payload.author_canonical_id),
      include_public: payload.include_public !== false,
      include_connections: payload.include_connections !== false,
      include_close: payload.include_close === true,
      updated_at: typeof payload.updated_at === "string" ? payload.updated_at : new Date().toISOString()
    });
    return true;
  }
  if (event.kind === "subscription.delete" && typeof payload.author_canonical_id === "string") {
    await deleteProjectedSubscription(account.canonical_id, String(payload.author_canonical_id));
    return true;
  }
  return false;
});

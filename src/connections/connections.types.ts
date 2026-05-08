import type { ConnectionRelationship, ConnectionTier, FeedSubscription } from "../protocol/types.js";

export type {
  ConnectionRelationship,
  ConnectionTier,
  FeedSubscription
} from "../protocol/types.js";

export type UpsertConnectionInput = {
  owner_canonical_id: string;
  subject_canonical_id: string;
  subject_handle?: string;
  tier: ConnectionTier;
  subscribed?: boolean;
  notes?: string;
};

export type UpsertSubscriptionInput = {
  owner_canonical_id: string;
  author_canonical_id: string;
  author_handle?: string;
  include_public?: boolean;
  include_connections?: boolean;
  include_close?: boolean;
  muted?: boolean;
};

export class ConnectionError extends Error {
  constructor(
    readonly code:
      | "invalid_relationship"
      | "invalid_subscription"
      | "blocked_relationship"
      | "not_found",
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

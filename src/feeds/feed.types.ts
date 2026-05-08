import type { FeedPublicMetadata, FeedVisibility } from "../protocol/types.js";

export type {
  CanonicalId,
  FeedPost,
  FeedPublicMetadata,
  FeedVisibility,
  Handle,
  Signature,
  SignableFeedPost
} from "../protocol/types.js";

export type CreateFeedPostInput = {
  post_id?: string;
  author_canonical_id: string;
  author_handle?: string;
  visibility: FeedVisibility;
  body?: string;
  encrypted_body?: string;
  public_metadata?: Partial<FeedPublicMetadata>;
  allowed_recipients?: string[];
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  sequence?: number;
  signature?: string;
};

export class FeedError extends Error {
  constructor(
    readonly code:
      | "author_not_found"
      | "invalid_post"
      | "invalid_visibility"
      | "post_too_large"
      | "close_connections_requires_recipients"
      | "invalid_signature"
      | "not_feed_post"
      | "post_not_found",
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

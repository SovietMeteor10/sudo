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
  author_canonical_id: string;
  author_handle?: string;
  visibility: FeedVisibility;
  body?: string;
  encrypted_body?: string;
  public_metadata?: Partial<FeedPublicMetadata>;
  allowed_recipients?: string[];
};

export class FeedError extends Error {
  constructor(
    readonly code:
      | "author_not_found"
      | "invalid_post"
      | "invalid_visibility"
      | "post_too_large"
      | "close_connections_requires_recipients"
      | "not_feed_post"
      | "post_not_found",
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

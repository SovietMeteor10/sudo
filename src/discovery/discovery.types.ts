export type { DiscoveryPostIndex, DiscoveryReaction, SearchResult } from "../protocol/types.js";

export class DiscoveryError extends Error {
  constructor(
    readonly code:
      | "invalid_reaction"
      | "not_discoverable"
      | "reaction_not_found"
      | "duplicate_reaction"
      | "post_not_found"
      | "discovery_error",
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

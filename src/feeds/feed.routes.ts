import { Router } from "express";
import {
  createFeedPost,
  deleteFeedPost,
  getPostForApiWithViewer,
  getThreadForApi,
  getUserRssFeed,
  listFeedPosts,
  listPersonalFeedForApi,
  listRepliesForApi,
  listUserPostsForApi
} from "./feed.service.js";
import { FeedError, type CreateFeedPostInput } from "./feed.types.js";
import { requireSignedRequest } from "../identity/request-auth.js";
import { getFeedPost } from "./feed.store.js";

export const feedRouter = Router();

feedRouter.get("/posts", (_request, response) => {
  response.json({ posts: listFeedPosts() });
});

feedRouter.post("/posts", (request, response) => {
  try {
    const post = createFeedPost(request.body as CreateFeedPostInput);
    response.status(201).json({ ok: true, post });
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.get("/personal/:viewerCanonicalId", (request, response) => {
  try {
    response.json(listPersonalFeedForApi(request.params.viewerCanonicalId));
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.get("/posts/:postId", (request, response) => {
  try {
    const result = getPostForApiWithViewer(request.params.postId, getViewer(request));
    response.json(result.warning === undefined
      ? { post: result.post }
      : { warning: result.warning, post: result.post });
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.get("/posts/:postId/thread", (request, response) => {
  try {
    response.json(getThreadForApi(request.params.postId, getViewer(request)));
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.get("/posts/:postId/replies", (request, response) => {
  try {
    response.json(listRepliesForApi(request.params.postId, getViewer(request)));
  } catch (error) {
    sendFeedError(response, error);
  }
});

// Phase 14 HIGH-2: feed-post deletion now requires the caller to
// prove possession of the author's identity key via a per-request
// signature. Previously the route trusted the body's
// `requester_canonical_id` field and only checked equality against
// the post's stored author_canonical_id — and author canonical_ids
// are public via RSS / /api/feeds/users/:id, so anyone who knew a
// post_id could delete it.
feedRouter.delete("/posts/:postId", requireSignedRequest({ kind: "identity" }), (request, response) => {
  try {
    const post = getFeedPost(request.params.postId);
    if (post === null) {
      response.status(404).json({ ok: false, error: "post_not_found", message: "feed post not found" });
      return;
    }
    if (post.author_canonical_id !== request.authenticatedCanonicalId) {
      response.status(403).json({ ok: false, error: "not_author", message: "signer does not match post author" });
      return;
    }
    response.json({ ok: true, post: deleteFeedPost(request.params.postId, request.authenticatedCanonicalId!) });
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.get("/users/:canonicalId/rss", (request, response) => {
  const baseUrl = `${request.protocol}://${request.get("host") ?? "localhost"}`;
  response.type("application/rss+xml").send(getUserRssFeed(request.params.canonicalId, baseUrl));
});

feedRouter.get("/users/:canonicalId", (request, response) => {
  const result = listUserPostsForApi(request.params.canonicalId, getViewer(request));
  response.json(result.warning === undefined
    ? { posts: result.posts }
    : { warning: result.warning, posts: result.posts });
});

function getViewer(request: { query: Record<string, unknown> }): string | undefined {
  return typeof request.query["viewer"] === "string" && request.query["viewer"].length > 0
    ? request.query["viewer"]
    : undefined;
}

function sendFeedError(
  response: { status: (status: number) => { json: (body: unknown) => void } },
  error: unknown
): void {
  if (error instanceof FeedError) {
    const payload: Record<string, unknown> = { ok: false, error: error.code, message: error.message };
    if (error.retry_after_seconds !== undefined) {
      payload["retry_after_seconds"] = error.retry_after_seconds;
    }
    response.status(error.status).json(payload);
    return;
  }

  response.status(500).json({ ok: false, error: "feed_error", message: "feed operation failed" });
}

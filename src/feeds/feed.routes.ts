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

feedRouter.delete("/posts/:postId", (request, response) => {
  try {
    // Phase 13.1: pull requester canonical id from either the JSON
    // body (preferred, matches createFeedPost shape) or a query
    // param (for fetch-without-body callers). The service-level
    // check returns 404 when the requester isn't the author.
    const body = (request.body ?? {}) as { requester_canonical_id?: unknown };
    const queryRequester = typeof request.query.requester_canonical_id === "string" ? request.query.requester_canonical_id : "";
    const requester = typeof body.requester_canonical_id === "string" && body.requester_canonical_id.length > 0
      ? body.requester_canonical_id
      : queryRequester;
    response.json({ ok: true, post: deleteFeedPost(request.params.postId, requester) });
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

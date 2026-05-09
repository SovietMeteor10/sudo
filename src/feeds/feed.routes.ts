import { Router } from "express";
import {
  createFeedPost,
  deleteFeedPost,
  getPostForApiWithViewer,
  getUserRssFeed,
  listFeedPosts,
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

feedRouter.get("/posts/:postId/replies", (request, response) => {
  try {
    response.json(listRepliesForApi(request.params.postId, getViewer(request)));
  } catch (error) {
    sendFeedError(response, error);
  }
});

feedRouter.delete("/posts/:postId", (request, response) => {
  try {
    response.json({ ok: true, post: deleteFeedPost(request.params.postId) });
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
    response.status(error.status).json({ ok: false, error: error.code, message: error.message });
    return;
  }

  response.status(500).json({ ok: false, error: "feed_error", message: "feed operation failed" });
}

import { Router } from "express";
import {
  createFeedPost,
  deleteFeedPost,
  getPostForApi,
  getUserRssFeed,
  listFeedPosts,
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
    const result = getPostForApi(request.params.postId);
    response.json(result.warning === undefined
      ? { post: result.post }
      : { warning: result.warning, post: result.post });
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
  const includeRestricted = request.query["include_restricted"] === "true";
  const result = listUserPostsForApi(request.params.canonicalId, includeRestricted);
  response.json(result.warning === undefined
    ? { posts: result.posts }
    : { warning: result.warning, posts: result.posts });
});

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

import { Router } from "express";
import { listFeedPosts } from "./feed.service.js";

export const feedRouter = Router();

feedRouter.get("/posts", (_request, response) => {
  response.json({ posts: listFeedPosts() });
});

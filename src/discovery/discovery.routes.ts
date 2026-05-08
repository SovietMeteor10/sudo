import { Router } from "express";
import { searchIdentityHandles } from "./discovery.service.js";

export const discoveryRouter = Router();

discoveryRouter.get("/handles", (request, response) => {
  const query = typeof request.query["q"] === "string" ? request.query["q"] : "";
  response.json({ results: searchIdentityHandles(query) });
});

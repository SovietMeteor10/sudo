import { Router } from "express";
import {
  createDiscoveryReaction,
  getDiscoveryPost,
  listDiscoveryHot,
  listDiscoveryRecent,
  listDiscoveryRising,
  reindexDiscovery,
  searchIdentityHandles
} from "./discovery.service.js";
import { DiscoveryError } from "./discovery.types.js";

export const discoveryRouter = Router();

discoveryRouter.get("/handles", (request, response) => {
  const query = typeof request.query["q"] === "string" ? request.query["q"] : "";
  response.json({ results: searchIdentityHandles(query) });
});

discoveryRouter.post("/reactions", (request, response) => {
  try {
    const body = request.body as {
      post_id?: unknown;
      actor_canonical_id?: unknown;
      actor_handle?: unknown;
      reaction?: unknown;
      reaction_id?: unknown;
      created_at?: unknown;
      signature?: unknown;
    };

    if (
      typeof body.post_id !== "string"
      || typeof body.actor_canonical_id !== "string"
      || !isReactionType(body.reaction)
    ) {
      throw new DiscoveryError("invalid_reaction", "invalid reaction payload");
    }

    const result = createDiscoveryReaction({
      post_id: body.post_id,
      actor_canonical_id: body.actor_canonical_id,
      actor_handle: typeof body.actor_handle === "string" ? body.actor_handle : undefined,
      reaction: body.reaction,
      reaction_id: typeof body.reaction_id === "string" ? body.reaction_id : undefined,
      created_at: typeof body.created_at === "string" ? body.created_at : undefined,
      signature: typeof body.signature === "string" ? body.signature : undefined
    });

    response.status(201).json({ ok: true, ...result });
  } catch (error) {
    sendDiscoveryError(response, error);
  }
});

discoveryRouter.get("/posts/:postId", (request, response) => {
  const index = getDiscoveryPost(request.params.postId);
  if (index === null) {
    response.status(404).json({ ok: false, error: "post_not_found" });
    return;
  }

  response.json({ index });
});

discoveryRouter.get("/hot", (request, response) => {
  response.json({ posts: listDiscoveryByQuery(request, "hot") });
});

discoveryRouter.get("/rising", (request, response) => {
  response.json({ posts: listDiscoveryByQuery(request, "rising") });
});

discoveryRouter.get("/recent", (request, response) => {
  response.json({ posts: listDiscoveryRecent(parseLimit(request.query["limit"]), parseOffset(request.query["offset"])) });
});

discoveryRouter.post("/reindex", (_request, response) => {
  response.json({ ok: true, count: reindexDiscovery() });
});

function listDiscoveryByQuery(
  request: { query: Record<string, unknown> },
  mode: "hot" | "rising"
) {
  const limit = parseLimit(request.query["limit"]);
  const offset = parseOffset(request.query["offset"]);
  return mode === "hot"
    ? listDiscoveryHot(limit, offset)
    : listDiscoveryRising(limit, offset);
}

function parseLimit(value: unknown): number {
  if (typeof value !== "string") return 20;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 100);
}

function parseOffset(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function isReactionType(value: unknown): value is "recommend" | "downrank" | "reply" | "repost" | "report" {
  return value === "recommend" || value === "downrank" || value === "reply" || value === "repost" || value === "report";
}

function sendDiscoveryError(
  response: { status: (status: number) => { json: (body: unknown) => void } },
  error: unknown
): void {
  if (error instanceof DiscoveryError) {
    response.status(error.status).json({ ok: false, error: error.code, message: error.message });
    return;
  }

  response.status(500).json({ ok: false, error: "discovery_error", message: "discovery operation failed" });
}

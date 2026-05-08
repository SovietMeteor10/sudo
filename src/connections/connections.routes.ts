import { Router } from "express";
import {
  getConnection,
  listConnections,
  listSubscriptions,
  removeConnection,
  removeSubscription,
  upsertConnection,
  upsertSubscription
} from "./connections.service.js";
import { ConnectionError } from "./connections.types.js";
import type { ConnectionTier } from "../protocol/types.js";

export const connectionsRouter = Router();
export const subscriptionsRouter = Router();

connectionsRouter.post("/", (request, response) => {
  try {
    const body = request.body as {
      owner_canonical_id?: unknown;
      subject_canonical_id?: unknown;
      subject_handle?: unknown;
      tier?: unknown;
      subscribed?: unknown;
      notes?: unknown;
    };

    if (
      typeof body.owner_canonical_id !== "string"
      || typeof body.subject_canonical_id !== "string"
      || !isConnectionTier(body.tier)
    ) {
      throw new ConnectionError("invalid_relationship", "invalid relationship payload");
    }

    const result = upsertConnection({
      owner_canonical_id: body.owner_canonical_id,
      subject_canonical_id: body.subject_canonical_id,
      subject_handle: typeof body.subject_handle === "string" ? body.subject_handle : undefined,
      tier: body.tier,
      subscribed: typeof body.subscribed === "boolean" ? body.subscribed : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined
    });

    response.status(201).json({ ok: true, ...result });
  } catch (error) {
    sendConnectionError(response, error);
  }
});

connectionsRouter.get("/:ownerCanonicalId", (request, response) => {
  const tier = isConnectionTier(request.query["tier"]) ? request.query["tier"] : undefined;
  response.json({ relationships: listConnections(request.params.ownerCanonicalId, tier) });
});

connectionsRouter.get("/:ownerCanonicalId/:subjectCanonicalId", (request, response) => {
  response.json({ relationship: getConnection(request.params.ownerCanonicalId, request.params.subjectCanonicalId) });
});

connectionsRouter.delete("/:ownerCanonicalId/:subjectCanonicalId", (request, response) => {
  response.json({ ok: true, removed: removeConnection(request.params.ownerCanonicalId, request.params.subjectCanonicalId) });
});

subscriptionsRouter.post("/", (request, response) => {
  try {
    const body = request.body as {
      owner_canonical_id?: unknown;
      author_canonical_id?: unknown;
      author_handle?: unknown;
      include_public?: unknown;
      include_connections?: unknown;
      include_close?: unknown;
      muted?: unknown;
    };

    if (typeof body.owner_canonical_id !== "string" || typeof body.author_canonical_id !== "string") {
      throw new ConnectionError("invalid_subscription", "invalid subscription payload");
    }

    response.status(201).json({
      ok: true,
      subscription: upsertSubscription({
        owner_canonical_id: body.owner_canonical_id,
        author_canonical_id: body.author_canonical_id,
        author_handle: typeof body.author_handle === "string" ? body.author_handle : undefined,
        include_public: typeof body.include_public === "boolean" ? body.include_public : undefined,
        include_connections: typeof body.include_connections === "boolean" ? body.include_connections : undefined,
        include_close: typeof body.include_close === "boolean" ? body.include_close : undefined,
        muted: typeof body.muted === "boolean" ? body.muted : undefined
      })
    });
  } catch (error) {
    sendConnectionError(response, error);
  }
});

subscriptionsRouter.get("/:ownerCanonicalId", (request, response) => {
  response.json({ subscriptions: listSubscriptions(request.params.ownerCanonicalId) });
});

subscriptionsRouter.delete("/:ownerCanonicalId/:authorCanonicalId", (request, response) => {
  response.json({ ok: true, removed: removeSubscription(request.params.ownerCanonicalId, request.params.authorCanonicalId) });
});

function isConnectionTier(value: unknown): value is ConnectionTier {
  return value === "unknown" || value === "known" || value === "close" || value === "blocked";
}

function sendConnectionError(
  response: { status: (status: number) => { json: (body: unknown) => void } },
  error: unknown
): void {
  if (error instanceof ConnectionError) {
    response.status(error.status).json({ ok: false, error: error.code, message: error.message });
    return;
  }

  response.status(500).json({ ok: false, error: "connection_error", message: "relationship operation failed" });
}

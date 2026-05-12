import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { listSyncCounts, summarizeSyncStats } from "../devices/syncStore.js";
import {
  listAllTombstoneWatermarks,
  readStaleUpsertRejectionCount
} from "../devices/tombstone-watermark.store.js";
import {
  handleIdentitySearch,
  handleIdentitySession
} from "../identity/identity-auth.handlers.js";
import { readNodeRuntimeConfig } from "../node/node.config.js";

export const devRouter = Router();

// One-shot logger for each deprecated path so a noisy bot can't fill
// the logs. Logged at process scope, not per-request.
const warnedPaths = new Set<string>();

function deprecate(canonical: string): RequestHandler {
  return (request, response, next) => {
    response.setHeader("Deprecation", "true");
    response.setHeader("Link", `<${canonical}>; rel="successor-version"`);
    if (!warnedPaths.has(request.path)) {
      warnedPaths.add(request.path);
      console.warn(`deprecated route used: ${request.method} ${request.path} -> ${canonical}`);
    }
    next();
  };
}

// Transitional read-only aliases. /dev/signup, /dev/signin, and
// /dev/recover were removed in migration steps 5 and 6 alongside their
// canonical /api/identity/* counterparts. Cached clients that still POST
// to those paths fall through to the app.ts catch-all 404, which is the
// correct signal: the routes are gone.
devRouter.get("/dev/session", deprecate("/api/identity/session"), handleIdentitySession);
devRouter.get("/dev/search-handles", deprecate("/api/identity/search"), handleIdentitySearch);

// Operator/dev diagnostic: counts of stored encrypted sync events
// grouped by (owner, slice, kind). Exposes plaintext owner canonical
// IDs alongside counts, so it must not be reachable on production
// nodes. Gated on isLocalDevelopment — production returns 404.
devRouter.get("/dev/sync/counts", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.json({ counts: listSyncCounts() });
});

// Operator/dev diagnostic: aggregate sync stats — device_sync_log
// row counts, top owners by row volume, active+revoked membership
// totals, and recipient-cursor sync-lag histogram (max + avg + count
// of devices observed). Exposes plaintext owner canonical IDs in the
// top-N list, so it's gated identically to /dev/sync/counts:
// production returns 404. The route is also under the /api/admin
// path prefix so an operator-gated production variant can replace
// the gate later without changing client expectations.
devRouter.get("/api/admin/sync/stats", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.json(summarizeSyncStats());
});

// Operator/dev diagnostic: tombstone purge watermark state. Exposes
// the per-(owner, origin_device) `purged_before_sequence` snapshot
// alongside the process-local counter of message.upsert events the
// server has rejected for falling below an origin's watermark. Owner
// canonical IDs are PLAINTEXT in this response (the listing is for
// operators to diagnose convergence lag), so it's gated to
// development the same way as the other diagnostic routes. No
// message bodies or ciphertext are exposed.
devRouter.get("/api/admin/tombstone-watermarks", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.json({
    watermarks: listAllTombstoneWatermarks(),
    stale_upserts_rejected: readStaleUpsertRejectionCount()
  });
});

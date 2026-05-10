import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { listSyncCounts } from "../devices/syncStore.js";
import {
  handleIdentityRecover,
  handleIdentitySearch,
  handleIdentitySession,
  handleIdentitySignin,
  handleIdentitySignup
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

// Transitional aliases. These keep cached browsers running while
// clients migrate to the canonical /api/identity/* surface. Plan to
// remove in the release after all known clients have migrated.
devRouter.post("/dev/signup", deprecate("/api/identity/signup"), handleIdentitySignup);
devRouter.post("/dev/signin", deprecate("/api/identity/signin"), handleIdentitySignin);
devRouter.post("/dev/recover", deprecate("/api/identity/recover"), handleIdentityRecover);
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

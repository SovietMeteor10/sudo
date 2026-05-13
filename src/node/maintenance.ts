// Phase 13: maintenance-mode middleware.
//
// When the file `${dataDir}/.maintenance` exists, the server
// short-circuits every non-health request with HTTP 503 and a
// human-readable message. /health + /api/health still return ok so
// load-balancers / monitoring don't trigger a hard alert during a
// scheduled reset.
//
// Maintenance state lives on disk (not in env) so a running server
// notices toggles without a restart — the reset script flips the
// flag, runs destructive ops, then removes the flag.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { readNodeRuntimeConfig } from "./node.config.js";

const ALLOWED_PATHS = new Set(["/health", "/api/health"]);

function maintenancePath(): string {
  return resolve(readNodeRuntimeConfig().dataDir, ".maintenance");
}

export function isMaintenanceModeActive(): boolean {
  return existsSync(maintenancePath());
}

export function maintenanceModeMessage(): string {
  try {
    const value = readFileSync(maintenancePath(), "utf-8").trim();
    return value.length > 0
      ? value
      : "sudo is in maintenance. please reconnect in a moment.";
  } catch {
    return "sudo is in maintenance. please reconnect in a moment.";
  }
}

// Express middleware. Mount BEFORE every route except the two
// health endpoints. Returns 503 + Retry-After 30 so well-behaved
// clients back off without retry spam.
export function maintenanceMiddleware(request: Request, response: Response, next: NextFunction): void {
  if (!isMaintenanceModeActive()) {
    next();
    return;
  }
  if (ALLOWED_PATHS.has(request.path)) {
    next();
    return;
  }
  response.setHeader("Retry-After", "30");
  response.status(503);
  // Match the client's expected JSON shape so /api/* callers don't
  // hit a parse error. HTML / static-asset requests get plain text.
  const wantsJson = request.path.startsWith("/api/")
    || (request.get("accept") ?? "").includes("application/json");
  if (wantsJson) {
    response.json({
      ok: false,
      error: "maintenance",
      message: maintenanceModeMessage()
    });
  } else {
    response.type("text/plain").send(`${maintenanceModeMessage()}\n`);
  }
}

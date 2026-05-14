import express from "express";
import "./storage/db.js";
import { connectionsRouter, subscriptionsRouter } from "./connections/connections.routes.js";
import { devicesRouter } from "./devices/devices.routes.js";
import { discoveryRouter } from "./discovery/discovery.routes.js";
import { feedRouter } from "./feeds/feed.routes.js";
import { identityRouter } from "./identity/identity.routes.js";
import { mountStaticClientPortal } from "./portal/clientPortal.js";
import { CONTENT_SECURITY_POLICY } from "./portal/csp.js";
import { maintenanceMiddleware } from "./node/maintenance.js";
import { getNetworkEpoch } from "./node/network.epoch.js";
import { notificationsRouter } from "./notifications/notifications.routes.js";
import { SUDO_PROTOCOL_VERSION } from "./protocol/constants.js";
import { pushRouter } from "./push/push.routes.js";
import { relayRouter } from "./relay/relay.routes.js";
import { typingRouter } from "./typing/typing.routes.js";
import { mediaRouter } from "./media/media.routes.js";
import { devRouter } from "./routes/dev.js";
import { fingerRouter } from "./routes/finger.js";
import { profileRouter } from "./routes/profile.js";
import { wellKnownRouter } from "./routes/wellKnown.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // nginx is the only public listener (DEPLOY_UBUNTU.md). Trusting
  // the immediate loopback peer lets request.ip fall back to the
  // X-Forwarded-For value nginx sets, which the per-IP rate limit
  // on the challenge endpoints needs to differentiate real callers
  // from "all traffic comes from 127.0.0.1".
  app.set("trust proxy", "loopback");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    // Phase 12.2 — explicit deny list for every Permissions-Policy
    // feature sudo doesn't use. Camera is allowed on this origin
    // (for the collect-account QR scanner via BarcodeDetector +
    // getUserMedia). Everything else is denied so a future bug or
    // a malicious script via a hypothetical CSP bypass can't reach
    // sensors / payment / USB / Bluetooth / the tracking-cohort APIs.
    response.setHeader("Permissions-Policy", [
      "geolocation=()",
      "microphone=()",
      "camera=(self)",
      "payment=()",
      "usb=()",
      "bluetooth=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "display-capture=()",
      "fullscreen=(self)",
      "interest-cohort=()",
      "browsing-topics=()"
    ].join(", "));
    // Phase 12.2 — cross-origin isolation. Sets up the page as
    // origin-isolated so a malicious cross-origin window can't
    // share the same process or read window.opener back. Safe to
    // apply on both clearnet and .onion; Tor browsers honor it.
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    next();
  });
  // Phase 13: maintenance-mode short-circuit. If
  // `${dataDir}/.maintenance` exists, every non-health request gets
  // a 503 + Retry-After. The reset script flips the flag before
  // destructive ops and clears it on completion. Mounted BEFORE the
  // media router so uploads can't slip through during a reset.
  app.use(maintenanceMiddleware);

  // /api/media MUST be mounted BEFORE the JSON body middleware.
  // Uploads stream raw ciphertext octets up to 50MB; the JSON
  // parser would otherwise consume the body (and reject with 413
  // because the limit is 64kb). Downloads + the rate-limit error
  // response are JSON-shaped, but the router emits them through
  // response.json() directly without needing the parser.
  app.use("/api/media", mediaRouter);

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, protocol: "sudo", version: SUDO_PROTOCOL_VERSION });
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, protocol: "sudo", version: SUDO_PROTOCOL_VERSION });
  });

  // Phase 13: NETWORK_EPOCH endpoint. Public, unauthenticated. The
  // client polls on boot and compares to its last-seen value; a
  // mismatch wipes IDB + service-worker caches and forces a fresh
  // connect. Cheap — the value is cached in memory after first
  // file read.
  app.get("/api/network/epoch", (_request, response) => {
    response.json({ epoch: getNetworkEpoch() });
  });

  app.use("/api/identity", identityRouter);
  app.use("/api/devices", devicesRouter);
  app.use("/api/connections", connectionsRouter);
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use("/api/relay", relayRouter);
  app.use("/api/feeds", feedRouter);
  app.use("/api/discovery", discoveryRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/typing", typingRouter);

  mountStaticClientPortal(app);

  app.use(wellKnownRouter);
  app.use(devRouter);
  app.use(profileRouter);
  app.use(fingerRouter);

  app.use((_request, response) => {
    response.status(404).type("text/plain").send("sudo: not found\n");
  });

  return app;
}

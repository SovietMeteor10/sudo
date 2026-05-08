import type { Express, Response } from "express";
import express from "express";
import { resolve } from "node:path";

// While sudo is in early-development we explicitly disable caching for the
// JS module graph the browser pulls (`/client` and `/protocol`). Stale
// `/client/main.js` bundles in the field have caused canonical_id and
// auth flow regressions even after a fresh deploy. `no-store` defeats
// browser, intermediary, and CDN caches; once the protocol stabilizes this
// can move to versioned filenames + long-cache.
function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
}

export function mountStaticClientPortal(app: Express): void {
  const publicPath = resolve("src/web/static");
  const clientPath = resolve("dist/web/client");
  const protocolPath = resolve("dist/protocol");
  const pretextPath = resolve("node_modules/@chenglou/pretext/dist");

  app.use(express.static(publicPath, { extensions: ["html"] }));
  app.use("/client", express.static(clientPath, { setHeaders: setNoStore }));
  app.use("/protocol", express.static(protocolPath, { setHeaders: setNoStore }));
  app.use("/vendor/pretext", express.static(pretextPath));

  app.get("/", (_request, response) => {
    setNoStore(response);
    response.sendFile(resolve(publicPath, "index.html"));
  });
}

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

  // The service worker MUST NOT be cached by the browser HTTP cache; the
  // browser's own SW update check fetches /sw.js and compares bytes, so a
  // stale cached copy can pin a deploy generation indefinitely. Same
  // reasoning for the manifest — a stale manifest hides icon/scope
  // changes from the install criteria.
  app.get("/sw.js", (_request, response) => {
    setNoStore(response);
    response.type("application/javascript");
    response.sendFile(resolve(publicPath, "sw.js"));
  });
  app.get("/manifest.webmanifest", (_request, response) => {
    setNoStore(response);
    response.type("application/manifest+json");
    response.sendFile(resolve(publicPath, "manifest.webmanifest"));
  });

  app.use(express.static(publicPath, { extensions: ["html"] }));
  app.use("/client", express.static(clientPath, { setHeaders: setNoStore }));
  app.use("/protocol", express.static(protocolPath, { setHeaders: setNoStore }));
  app.use("/vendor/pretext", express.static(pretextPath));

  // Phase 14B: expose the user-facing docs (HOW_SUDO_WORKS, TRUST_MODEL,
  // PRIVACY, SECURITY) so links in the about overlay land somewhere
  // readable. Markdown is served as text/plain so curious readers see
  // the source; a richer renderer can land later. Restricted to .md
  // to avoid leaking anything else from the docs/ tree by accident.
  app.get("/docs/:file", (request, response, next) => {
    const file = request.params.file;
    if (!/^[A-Za-z0-9_]+\.md$/.test(file)) { next(); return; }
    response.type("text/plain; charset=utf-8");
    response.sendFile(resolve("docs", file));
  });

  app.get("/", (_request, response) => {
    setNoStore(response);
    response.sendFile(resolve(publicPath, "index.html"));
  });
}

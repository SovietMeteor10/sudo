import type { Express, Response } from "express";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdownToHtml, wrapDocHtml } from "./markdown.js";

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

  // Phase 14B mobile polish: render the docs through a small in-tree
  // markdown -> HTML pipeline so the about overlay's "how it works /
  // trust model / privacy" cards land on a sudo-styled page instead
  // of raw text. Source files stay markdown in docs/; the renderer is
  // in src/portal/markdown.ts. Restricted to a fixed allowlist of
  // user-facing docs so the route can't surface anything else in the
  // tree by accident.
  const DOC_ALLOW: Record<string, string> = {
    "HOW_SUDO_WORKS.md": "how sudo works",
    "TRUST_MODEL.md": "trust model",
    "PRIVACY.md": "privacy",
    "SECURITY.md": "security overview",
    "SECURITY_AUDIT.md": "security audit"
  };
  app.get("/docs/:file", (request, response, next) => {
    const file = request.params.file;
    const title = DOC_ALLOW[file];
    if (title === undefined) { next(); return; }
    let source: string;
    try {
      source = readFileSync(resolve("docs", file), "utf-8");
    } catch {
      response.status(404).type("text/html").send(wrapDocHtml({
        title: "not found",
        bodyHtml: `<h1>not found</h1><p>that document isn't here.</p>`
      }));
      return;
    }
    const html = wrapDocHtml({
      title,
      bodyHtml: renderMarkdownToHtml(source)
    });
    response.type("text/html; charset=utf-8");
    response.send(html);
  });

  app.get("/", (_request, response) => {
    setNoStore(response);
    response.sendFile(resolve(publicPath, "index.html"));
  });
}

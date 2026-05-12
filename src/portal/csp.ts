// Content-Security-Policy is computed once at module load: we read the
// served index.html, extract the inline <script type="importmap"> body
// verbatim, and hash it. The browser hashes the exact bytes between the
// opening tag's `>` and the closing `</script>`, so any whitespace edit
// to the importmap will invalidate the hash and the next deploy must
// recompute it. Doing it at startup means a stale hash is impossible
// without an explicit deploy.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const IMPORTMAP_RE = /<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/i;

function computeImportmapHash(): string {
  const indexPath = resolve("src/web/static/index.html");
  const html = readFileSync(indexPath, "utf-8");
  const match = IMPORTMAP_RE.exec(html);
  if (!match) {
    throw new Error("csp: failed to locate <script type=\"importmap\"> in index.html");
  }
  const body = match[1] ?? "";
  const digest = createHash("sha256").update(body, "utf-8").digest("base64");
  return `'sha256-${digest}'`;
}

const importmapHash = computeImportmapHash();

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${importmapHash}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  // Same-origin service worker + manifest. Push subscription endpoints live
  // off-origin (FCM / Mozilla autopush / Apple) but the browser does that
  // fetch out-of-band from the page so it does NOT need to be in connect-src.
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

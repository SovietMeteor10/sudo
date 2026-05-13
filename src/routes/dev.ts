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
import { listUntrackedBlobs, runOrphanBlobGc } from "../media/media.gc.js";
import { summarizeMediaStorage } from "../media/media.store.js";
import { readNodeRuntimeConfig } from "../node/node.config.js";
import { runRelayRetentionSweep } from "../relay/relay.retention.js";

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

// Phase 11.1: smoke + operator hooks for the new lifecycle sweepers.
// All three are gated identically to /dev/sync/counts — production
// returns 404. The handlers are POST so a caching proxy / browser
// preview can't accidentally fire them.
//
// /api/admin/media/gc accepts an optional ?dry_run=1 query parameter.
// Dry-run mode returns the candidate set without deleting anything;
// this is the path the orphan-blob-gc smoke uses to confirm the
// retention math BEFORE asking the server to actually delete.

devRouter.post("/api/admin/relay/retention-sweep", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.json({ ok: true, ...runRelayRetentionSweep() });
});

devRouter.post("/api/admin/media/gc", (request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  const dryRun = String(request.query.dry_run ?? "") === "1";
  response.json({ ok: true, ...runOrphanBlobGc({ dryRun }) });
});

devRouter.get("/api/admin/media/summary", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.json({
    ...summarizeMediaStorage(),
    untracked_blobs: listUntrackedBlobs()
  });
});

// Phase 10.3: dev diagnostics page. Serves a small HTML panel that
// reads client-local state (queue depth, last sync, push/SW status,
// linked-device count, storage usage estimate) directly from the
// page's IDB + navigator APIs. The route is gated identically to
// the other dev diagnostics — production returns 404 + plaintext
// "not found" exactly like /dev/sync/counts. The page never sends
// any of the read data over the network; it's a read-only mirror
// of in-browser state for the operator.
devRouter.get("/dev/diagnostics", (_request: Request, response: Response) => {
  if (!readNodeRuntimeConfig().isLocalDevelopment) {
    response.status(404).type("text/plain").send("sudo: not found\n");
    return;
  }
  response.type("text/html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>sudo dev diagnostics</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { padding: 16px; }
    .diag { display: grid; gap: 8px; max-width: 720px; margin: 0 auto; }
    .diag h1 { font-size: 16px; margin: 0 0 12px; }
    .diag-row { display: grid; grid-template-columns: 200px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
    .diag-row__label { color: var(--muted); font-size: 12px; }
    .diag-row__value { font-family: var(--font-mono, monospace); word-break: break-all; font-size: 13px; }
    .diag-warn { color: #d9534f; }
    .diag-ok { color: var(--focus); }
  </style>
</head>
<body>
  <div class="diag">
    <h1>dev diagnostics</h1>
    <p class="signup-dialog__hint">read-only mirror of this browser's local sudo state. development build only — this page is 404 in production.</p>
    <div class="diag-row"><div class="diag-row__label">online</div><div class="diag-row__value" id="diag-online">…</div></div>
    <div class="diag-row"><div class="diag-row__label">queue depth (pending_outbound)</div><div class="diag-row__value" id="diag-queue-depth">…</div></div>
    <div class="diag-row"><div class="diag-row__label">queue retry attempts (max)</div><div class="diag-row__value" id="diag-retry-max">…</div></div>
    <div class="diag-row"><div class="diag-row__label">last sync</div><div class="diag-row__value" id="diag-last-sync">…</div></div>
    <div class="diag-row"><div class="diag-row__label">linked devices</div><div class="diag-row__value" id="diag-devices">…</div></div>
    <div class="diag-row"><div class="diag-row__label">push subscription</div><div class="diag-row__value" id="diag-push">…</div></div>
    <div class="diag-row"><div class="diag-row__label">service worker</div><div class="diag-row__value" id="diag-sw">…</div></div>
    <div class="diag-row"><div class="diag-row__label">storage estimate</div><div class="diag-row__value" id="diag-storage">…</div></div>
    <div class="diag-row"><div class="diag-row__label">IDB record counts</div><div class="diag-row__value" id="diag-idb">…</div></div>
  </div>
  <script type="module">
    async function getAllByIndex(store, indexName, owner) {
      const db = await new Promise((r, j) => { const req = indexedDB.open("sudo_local_state"); req.onsuccess = () => r(req.result); req.onerror = () => j(req.error); });
      try {
        const tx = db.transaction(store, "readonly");
        const idx = tx.objectStore(store).index(indexName);
        return await new Promise((r, j) => { const req = idx.getAll(owner); req.onsuccess = () => r(req.result || []); req.onerror = () => j(req.error); });
      } finally { db.close(); }
    }
    async function countStore(store) {
      const db = await new Promise((r, j) => { const req = indexedDB.open("sudo_local_state"); req.onsuccess = () => r(req.result); req.onerror = () => j(req.error); });
      try {
        const tx = db.transaction(store, "readonly");
        return await new Promise((r, j) => { const req = tx.objectStore(store).count(); req.onsuccess = () => r(req.result); req.onerror = () => j(req.error); });
      } finally { db.close(); }
    }
    async function load() {
      document.getElementById("diag-online").textContent = navigator.onLine ? "yes" : "no";
      // Try to read owner canonical from cookie / fallback to first crypto_account.
      let owner = "";
      try {
        const db = await new Promise((r, j) => { const req = indexedDB.open("sudo_local_state"); req.onsuccess = () => r(req.result); req.onerror = () => j(req.error); });
        const tx = db.transaction("crypto_accounts", "readonly");
        const all = await new Promise((r, j) => { const req = tx.objectStore("crypto_accounts").getAll(); req.onsuccess = () => r(req.result || []); req.onerror = () => j(req.error); });
        if (all.length > 0) owner = all[0].canonical_id;
        db.close();
      } catch (e) { /* no IDB yet */ }
      if (owner.length === 0) {
        document.getElementById("diag-queue-depth").textContent = "(not signed in)";
        document.getElementById("diag-retry-max").textContent = "(not signed in)";
        document.getElementById("diag-last-sync").textContent = "(not signed in)";
        document.getElementById("diag-devices").textContent = "(not signed in)";
      } else {
        const pending = await getAllByIndex("pending_outbound", "by_owner", owner);
        document.getElementById("diag-queue-depth").textContent = String(pending.length);
        const maxAttempts = pending.reduce((m, p) => Math.max(m, p.attempts || 0), 0);
        document.getElementById("diag-retry-max").textContent = String(maxAttempts);
        try {
          const devs = await getAllByIndex("trusted_devices", "by_owner", owner);
          document.getElementById("diag-devices").textContent = String(devs.length);
        } catch { document.getElementById("diag-devices").textContent = "?"; }
        try {
          const evts = await getAllByIndex("events", "by_owner", owner);
          const last = evts.length > 0 ? evts.map((e) => e.created_at).sort().pop() : null;
          document.getElementById("diag-last-sync").textContent = last ?? "(no events yet)";
        } catch { document.getElementById("diag-last-sync").textContent = "?"; }
      }
      // Push + SW
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          document.getElementById("diag-sw").textContent = reg ? ("active scope=" + reg.scope) : "(none)";
          if (reg) {
            const sub = await reg.pushManager.getSubscription();
            document.getElementById("diag-push").textContent = sub ? "subscribed" : "not subscribed";
          } else {
            document.getElementById("diag-push").textContent = "(no SW)";
          }
        } else {
          document.getElementById("diag-sw").textContent = "(unsupported)";
          document.getElementById("diag-push").textContent = "(unsupported)";
        }
      } catch (e) {
        document.getElementById("diag-sw").textContent = "err: " + e.message;
      }
      // Storage estimate
      try {
        if ("storage" in navigator && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          const used = (est.usage / (1024 * 1024)).toFixed(2);
          const quota = (est.quota / (1024 * 1024)).toFixed(0);
          document.getElementById("diag-storage").textContent = used + " MB used / " + quota + " MB quota";
        } else {
          document.getElementById("diag-storage").textContent = "(unsupported)";
        }
      } catch (e) {
        document.getElementById("diag-storage").textContent = "err: " + e.message;
      }
      // IDB record counts
      try {
        const stores = ["events", "messages", "pending_outbound", "contacts", "subscriptions", "trusted_devices", "drafts", "settings", "device_sync_events"];
        const parts = [];
        for (const s of stores) {
          try { parts.push(s + "=" + await countStore(s)); } catch { parts.push(s + "=?"); }
        }
        document.getElementById("diag-idb").textContent = parts.join(", ");
      } catch (e) {
        document.getElementById("diag-idb").textContent = "err: " + e.message;
      }
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
`);
});

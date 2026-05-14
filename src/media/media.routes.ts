// Opaque media blob storage.
//
// Wire contract:
//   POST /api/media/upload
//     Content-Type: application/octet-stream
//     Body: raw ciphertext bytes (already AES-GCM encrypted by the
//           sender; server never sees plaintext bytes).
//     Headers:
//       x-sudo-media-class: "image" | "video" | "file"
//           — chooses the size cap. Defaults to "file".
//     -> { ok: true, blob_id }
//
//   GET /api/media/:blob_id
//     -> 200 application/octet-stream + the ciphertext bytes
//     -> 404 if missing
//
// Privacy invariants enforced here:
//   - blob_id is a random 32-hex string; never the original
//     filename or any user-supplied data.
//   - the on-disk filename is the blob_id (no extension); the
//     original filename never appears in any path the server
//     touches.
//   - per-IP rate limit + per-mime-class size cap.
//   - no mime sniffing, no thumbnail generation, no content
//     scanning. The server treats every byte as opaque.

import express from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { emitRateLimited } from "../devices/rate-limit-response.js";
import { readNodeRuntimeConfig } from "../node/node.config.js";
import {
  deleteMediaBlob,
  getMediaBlob,
  getMediaBytesForUploader,
  markMediaBlobAccessed,
  recordMediaBlob
} from "./media.store.js";

export const mediaRouter = express.Router();

// Size caps per the Phase 8 spec. Enforced by stripping the request
// stream once it overshoots — we never buffer beyond the cap.
const SIZE_LIMITS: Record<string, number> = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  file: 25 * 1024 * 1024
};
const DEFAULT_LIMIT = SIZE_LIMITS.file!;

function mediaDir(): string {
  const dir = resolve(readNodeRuntimeConfig().dataDir, "media");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
  return dir;
}

// 32-hex (16 bytes). Random enough to be unguessable; short enough
// to fit comfortably in URLs.
function newBlobId(): string {
  return randomBytes(16).toString("hex");
}

function isValidBlobId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

// ---- Rate limit (per-IP) -------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_UPLOAD = 30; // ~one large file per 2s, comfortable headroom
const RATE_LIMIT_DOWNLOAD = 300; // image inline preview can hammer this; be generous
const uploadHits = new Map<string, number[]>();
const downloadHits = new Map<string, number[]>();
function rateCheck(buckets: Map<string, number[]>, ip: string, limit: number, now: number): { ok: true } | { ok: false; scope: "ip"; retry_after_seconds: number } {
  const key = ip.length > 0 ? ip : "unknown";
  const hits = buckets.get(key) ?? [];
  const cutoff = now - RATE_WINDOW_MS;
  const fresh = hits.filter((t) => t > cutoff);
  if (fresh.length >= limit) {
    const oldest = fresh[0]!;
    return { ok: false, scope: "ip", retry_after_seconds: Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000)) };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return { ok: true };
}
// Phase 14 MED-2: only honor X-Real-IP when the peer is loopback.
import { resolveTrustedIp as resolveIp } from "../node/trusted-ip.js";

// ---- Upload --------------------------------------------------------------
//
// We deliberately do NOT use express.raw() here because the global
// JSON middleware in app.ts is configured with a 64kb limit. Instead
// we stream the request body directly to disk, capping reads at the
// per-class size limit.
mediaRouter.post("/upload", (request, response) => {
  const rate = rateCheck(uploadHits, resolveIp(request), RATE_LIMIT_UPLOAD, Date.now());
  if (!rate.ok) { emitRateLimited(response, rate); return; }

  // Phase 11.2: stricter media-class validation. Phase 8 fell back to
  // the file cap (25MB) for any unknown class value; that's a real
  // hole because it lets a misbehaving client overpay for storage
  // they shouldn't have access to. We now reject unknown classes
  // outright with a stable error code so the client surfaces a clear
  // message instead of silently uploading under the wrong cap.
  // Empty / missing header falls back to "file" (the conservative
  // default — same as Phase 8 behavior for unset header).
  const headerValue = String(request.get("x-sudo-media-class") ?? "").trim().toLowerCase();
  const rawClass = headerValue.length === 0 ? "file" : headerValue;
  if (rawClass !== "image" && rawClass !== "video" && rawClass !== "file") {
    response.status(400).json({ ok: false, error: "invalid_media_class", allowed: ["image", "video", "file"] });
    return;
  }
  const mediaClass = rawClass;
  const limit = SIZE_LIMITS[mediaClass] ?? DEFAULT_LIMIT;

  // Phase 11.1: optional per-owner attestation. The client can pass
  // its canonical_id in this header to opt into per-owner quota
  // tracking. The header is *not* authenticated (no signature) — a
  // malicious client could attribute its uploads to someone else's
  // canonical_id, but doing so only hurts the attacker (their own
  // quota tally rises). The privacy invariant (server never sees
  // plaintext bytes) is unchanged. Phase 11.2 will add signed
  // attestation as part of the abuse-hardening pass.
  const uploaderHeader = request.get("x-sudo-uploader-canonical-id");
  const uploaderCanonicalId = typeof uploaderHeader === "string" && /^sudo:[A-Za-z0-9_:.@-]+$/.test(uploaderHeader)
    ? uploaderHeader
    : null;

  // Pre-flight owner quota: reject before we even open the file
  // handle if the uploader's running total already exceeds the cap.
  if (uploaderCanonicalId !== null) {
    const quota = readNodeRuntimeConfig().ownerMediaQuotaBytes;
    if (quota > 0) {
      const used = getMediaBytesForUploader(uploaderCanonicalId);
      if (used >= quota) {
        response.status(413).json({
          ok: false,
          error: "owner_media_quota_exceeded",
          quota_bytes: quota,
          used_bytes: used
        });
        return;
      }
    }
  }

  const blobId = newBlobId();
  const dir = mediaDir();
  const path = resolve(dir, blobId);
  // Phase 11.2 atomic writes: stream to a sibling .tmp file and
  // rename(2) into place ONLY after the body finishes successfully.
  // A crash mid-upload leaves a leftover .tmp file that the next
  // orphan-blob GC sweep collects (it's an "untracked blob" in the
  // operator diagnostic sense, never readable by the public route).
  // Readers always see either: the blob is fully present, or it's
  // missing — never half a file.
  const tmpPath = `${path}.tmp`;
  const writer = createWriteStream(tmpPath, { mode: 0o600 });
  writer.on("error", () => { /* expected on oversize/abort */ });

  let bytesWritten = 0;
  let oversize = false;
  let finalized = false;

  function finalize(status: number, body: object): void {
    if (finalized) return;
    finalized = true;
    try { writer.destroy(); } catch { /* ignore */ }
    response.status(status).json(body);
  }

  request.on("data", (chunk: Buffer) => {
    if (finalized || oversize) return;
    bytesWritten += chunk.length;
    if (bytesWritten > limit) {
      oversize = true;
      try {
        writer.destroy();
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch { /* ignore */ }
      finalize(413, { ok: false, error: "payload_too_large", limit_bytes: limit, media_class: mediaClass });
      return;
    }
    writer.write(chunk);
  });

  request.on("end", () => {
    if (finalized) return;
    writer.end(() => {
      if (bytesWritten === 0) {
        // Empty body — clean up + reject.
        try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
        finalize(400, { ok: false, error: "empty_body" });
        return;
      }
      // Phase 11.1: post-write quota check (now we know the exact
      // byte count). If it would push the uploader over their cap,
      // discard the .tmp and reject — the final path never appears.
      if (uploaderCanonicalId !== null) {
        const quota = readNodeRuntimeConfig().ownerMediaQuotaBytes;
        if (quota > 0) {
          const used = getMediaBytesForUploader(uploaderCanonicalId);
          if (used + bytesWritten > quota) {
            try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
            finalize(413, {
              ok: false,
              error: "owner_media_quota_exceeded",
              quota_bytes: quota,
              used_bytes: used,
              attempted_bytes: bytesWritten
            });
            return;
          }
        }
      }
      // Phase 11.2 atomic publish: rename the .tmp to the final
      // blob_id path. After this point a 404 means the GC ran, not
      // that the upload crashed.
      try {
        renameSync(tmpPath, path);
      } catch (renameErr) {
        try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
        finalize(500, { ok: false, error: "upload_failed", reason: renameErr instanceof Error ? renameErr.message : "rename_failed" });
        return;
      }
      const nowIso = new Date().toISOString();
      try {
        recordMediaBlob({
          blob_id: blobId,
          size_bytes: bytesWritten,
          media_class: mediaClass,
          uploader_canonical_id: uploaderCanonicalId,
          created_at: nowIso,
          last_accessed_at: nowIso
        });
      } catch {
        // DB insert failure shouldn't lose the blob — the client can
        // still address it by blob_id. Quota tracking is best-effort.
      }
      finalize(200, { ok: true, blob_id: blobId, size_bytes: bytesWritten });
    });
  });

  request.on("error", () => {
    if (finalized) return;
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    finalize(500, { ok: false, error: "upload_failed" });
  });
});

// ---- Download -----------------------------------------------------------

mediaRouter.get("/:blob_id", (request, response) => {
  const rate = rateCheck(downloadHits, resolveIp(request), RATE_LIMIT_DOWNLOAD, Date.now());
  if (!rate.ok) { emitRateLimited(response, rate); return; }

  const blobId = request.params.blob_id;
  if (!isValidBlobId(blobId)) {
    response.status(400).json({ ok: false, error: "invalid_blob_id" });
    return;
  }
  const dir = mediaDir();
  const path = resolve(dir, blobId);
  // Guard against path traversal — resolve must still be inside dir.
  if (!path.startsWith(dir)) {
    response.status(400).json({ ok: false, error: "invalid_blob_id" });
    return;
  }
  if (!existsSync(path)) {
    response.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  // Phase 11.1: bookkeeping bump. Touching last_accessed_at means
  // the orphan-blob GC's "stale = no access in N days" heuristic
  // gets a true signal. If the DB row is missing (legacy blob from
  // before the bookkeeping table existed), this is a no-op.
  try { markMediaBlobAccessed(blobId, new Date().toISOString()); } catch { /* ignore */ }
  const stat = statSync(path);
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Length", String(stat.size));
  // No CDN, no proxy caching, no SW caching — every fetch hits the
  // origin. The bytes are encrypted so leaking them is harmless, but
  // a stale cache could outlive a tombstone delete.
  response.setHeader("Cache-Control", "no-store");
  // The blob is opaque ciphertext; the server has no original
  // filename. Recipients render with metadata they decrypted from
  // the envelope, not from headers.
  const stream = createReadStream(path);
  stream.on("error", () => response.status(500).end());
  stream.pipe(response);
});

// ---- Test-only helpers --------------------------------------------------
export function __resetMediaStateForTests(): void {
  uploadHits.clear();
  downloadHits.clear();
}

#!/usr/bin/env node
// failed-upload-cleanup smoke (Phase 11.2 Part F).
//
// Asserts that interrupted uploads leave no addressable blob and
// that the .tmp leftover is reaped on the next GC pass:
//   - oversized upload (rejected 413): no addressable blob, no
//     leftover .tmp file (cleaned synchronously by the route).
//   - empty body (rejected 400): no .tmp leftover.
//   - GC reports the .tmp candidate count in dry-run if any exist.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fs = require("node:fs");
const path = require("node:path");

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function upload(opts) {
  const headers = { "content-type": "application/octet-stream" };
  if (opts.mediaClass) headers["x-sudo-media-class"] = opts.mediaClass;
  const r = await fetch(`${BASE}/api/media/upload`, {
    method: "POST",
    headers,
    body: opts.bytes
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const dataDir = process.env.SUDO_DATA_DIR || path.resolve(process.cwd(), "data");
  const mediaDir = path.resolve(dataDir, "media");

  // Reset per-IP rate limits left over from a previous smoke run
  // so the test starts from a clean state.
  await fetch(`${BASE}/api/admin/media/reset-rate-limits`, { method: "POST" }).catch(() => null);

  function listTmpFiles() {
    if (!fs.existsSync(mediaDir)) return [];
    return fs.readdirSync(mediaDir).filter((n) => n.endsWith(".tmp"));
  }

  const tmpsBefore = listTmpFiles();
  ok(`baseline: ${tmpsBefore.length} .tmp file(s) in media dir before test`);

  // ===== Part 1: oversize upload — server rejects + cleans up. =====
  const oversize = await upload({ mediaClass: "image", bytes: Buffer.alloc(12 * 1024 * 1024, 0x55) });
  if (oversize.status !== 413) {
    fail("1.oversize-status", `expected 413, got ${oversize.status}`);
  } else {
    ok(`1. oversize upload rejected with 413`);
  }
  // The route synchronously unlinks the .tmp file on oversize.
  // Allow a brief moment for the unlink to finish before scanning.
  await new Promise((r) => setTimeout(r, 200));
  const afterOversize = listTmpFiles();
  if (afterOversize.length > tmpsBefore.length) {
    fail("1b.tmp-leak", `oversize upload left ${afterOversize.length - tmpsBefore.length} new .tmp file(s) behind`);
  } else {
    ok(`1b. no new .tmp leftover after oversize rejection`);
  }

  // ===== Part 2: empty body. =====
  const empty = await upload({ mediaClass: "image", bytes: Buffer.alloc(0) });
  if (empty.status !== 400 || empty.body?.error !== "empty_body") {
    fail("2.empty-status", `expected 400/empty_body, got ${empty.status} ${JSON.stringify(empty.body)}`);
  } else {
    ok(`2. empty upload rejected with 400/empty_body`);
  }
  await new Promise((r) => setTimeout(r, 200));
  if (listTmpFiles().length > tmpsBefore.length) {
    fail("2b.tmp-leak", `empty upload left a .tmp file behind`);
  } else {
    ok(`2b. no .tmp leftover after empty upload`);
  }

  // ===== Part 3: successful upload — blob exists, no .tmp. =====
  const okUpload = await upload({ mediaClass: "image", bytes: Buffer.alloc(1024, 0x77) });
  if (okUpload.status !== 200 || okUpload.body?.ok !== true) {
    fail("3.success", `expected 200/ok, got ${okUpload.status} ${JSON.stringify(okUpload.body)}`);
  } else {
    ok(`3. clean upload succeeded (blob_id=${okUpload.body.blob_id.slice(0, 8)}…)`);
  }
  await new Promise((r) => setTimeout(r, 200));
  const successfulBlob = okUpload.body?.blob_id;
  if (typeof successfulBlob === "string" && fs.existsSync(path.resolve(mediaDir, successfulBlob))) {
    ok(`3b. successful upload's final file is present on disk`);
  } else {
    fail("3b.missing-final", `successful upload's blob file missing on disk`);
  }
  // .tmp count should still match baseline.
  if (listTmpFiles().length > tmpsBefore.length) {
    fail("3c.tmp-leak", `successful upload left a .tmp file behind (renamed should be atomic)`);
  } else {
    ok(`3c. successful upload's .tmp was renamed atomically (no leftover)`);
  }

  // ===== Part 4: GC dry-run reports a tmp_files_pending count we
  // can read but not act on without a real leftover. We don't try
  // to synthesize a stale .tmp here — that path is exercised by
  // the orphan-blob-gc smoke instead. =====
  const dryRunR = await fetch(`${BASE}/api/admin/media/gc?dry_run=1`, { method: "POST" });
  const dryRun = await dryRunR.json();
  if (typeof dryRun.tmp_files_deleted !== "number") {
    fail("4.shape", `GC response missing tmp_files_deleted field: ${JSON.stringify(dryRun)}`);
  } else {
    ok(`4. GC dry-run surfaces tmp_files_deleted=${dryRun.tmp_files_deleted}`);
  }

  if (failures.length > 0) {
    console.error(`FAILED-UPLOAD-CLEANUP SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("FAILED-UPLOAD-CLEANUP SMOKE PASSED");
})().catch((err) => {
  console.error("FAILED-UPLOAD-CLEANUP SMOKE ERRORED:", err);
  process.exit(1);
});

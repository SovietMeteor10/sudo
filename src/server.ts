import { createApp } from "./app.js";
import { runOrphanBlobGc } from "./media/media.gc.js";
import { readNodeRuntimeConfig } from "./node/node.config.js";
import { runRelayRetentionSweep } from "./relay/relay.retention.js";
import { expireRelayEnvelopes } from "./relay/relay.store.js";

const config = readNodeRuntimeConfig();
const app = createApp();

app.listen(config.bindPort, config.bindHost, () => {
  console.log(`sudo listening on http://${config.bindHost}:${config.bindPort}`);
});

// Phase 11.1: periodic lifecycle sweeps.
//
// expireRelayEnvelopes() flips status to "expired" + blanks the
// ciphertext for rows past their TTL. runRelayRetentionSweep()
// hard-deletes pairing tokens, identity challenges, dev sessions,
// and long-expired envelopes. runOrphanBlobGc() drops media blobs
// whose last_accessed_at is older than the retention window.
//
// All three are cheap and idempotent. Cadence:
//   - Relay envelope expiry: every 5 minutes (matches the original
//     /api/relay/expire dev endpoint's frequency).
//   - Retention sweep + media GC: every hour. Lower frequency since
//     they only matter on a long-running node.
const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
setInterval(() => {
  try { expireRelayEnvelopes(new Date()); } catch (err) {
    console.warn("[relay] envelope expiry sweep failed", err);
  }
}, FIVE_MIN_MS);
setInterval(() => {
  try {
    const retention = runRelayRetentionSweep();
    const gc = runOrphanBlobGc();
    if (retention.pairing_tokens_pruned + retention.identity_challenges_pruned
        + retention.dev_sessions_pruned + retention.expired_envelopes_hard_deleted
        + gc.files_deleted > 0) {
      console.log("[lifecycle]", { retention, gc });
    }
  } catch (err) {
    console.warn("[lifecycle] sweep failed", err);
  }
}, ONE_HOUR_MS);

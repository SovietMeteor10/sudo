#!/usr/bin/env node
// onion-origin-generation smoke (Phase 12.1 Part A).
//
// Asserts that node.json + identity profiles are served origin-
// aware: when a request arrives on a .onion hostname, the response
// must NOT advertise clearnet relay capabilities. When the request
// arrives on clearnet, the response can still advertise the
// .onion alternative.
//
// We don't actually deploy onto Tor here; we use the standard
// trick of setting the Host header to a synthetic .onion address
// and rely on Express's `request.hostname` reading from there.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const SYNTHETIC_ONION = process.env.SUDO_TEST_ONION_HOST || "sudosmoketest1234567890.onion";

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function fetchNodeJson(host) {
  const headers = { accept: "application/json" };
  if (host !== null) headers["host"] = host;
  // Node's fetch refuses to override Host; use HTTP module directly.
  const url = new URL(BASE + "/.well-known/sudo/node.json");
  const http = url.protocol === "https:" ? require("node:https") : require("node:http");
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  // ===== Part 1: clearnet request returns the default doc. =====
  const clearnet = await fetchNodeJson(null);
  if (clearnet.status !== 200) {
    fail("1.clearnet-status", `expected 200, got ${clearnet.status}`);
    process.exit(1);
  }
  if (!Array.isArray(clearnet.body?.relay_capabilities)) {
    fail("1.clearnet-shape", `relay_capabilities not an array: ${JSON.stringify(clearnet.body)}`);
    process.exit(1);
  }
  const clearnetTransports = clearnet.body.relay_capabilities.map((c) => c.transport);
  ok(`1. clearnet request: relay_capabilities=[${clearnetTransports.join(", ")}]`);

  // ===== Part 2: synthetic .onion host returns onion-only caps. =====
  const onion = await fetchNodeJson(SYNTHETIC_ONION);
  if (onion.status !== 200) {
    fail("2.onion-status", `expected 200, got ${onion.status}`);
    process.exit(1);
  }
  const onionTransports = onion.body.relay_capabilities.map((c) => c.transport);
  // Two valid shapes here:
  //   (a) The node has no onion_base_url configured → relay_capabilities is empty.
  //       This is expected for a clearnet-only deployment; the smoke
  //       passes with a note.
  //   (b) The node has onion configured → relay_capabilities has
  //       only onion transports, no https / local_dev.
  if (onionTransports.length === 0) {
    ok(`2. onion host with no onion_base_url configured: relay_capabilities is empty (clearnet-only deployment)`);
  } else {
    const nonOnion = onionTransports.filter((t) => t !== "onion");
    if (nonOnion.length > 0) {
      fail("2.onion-leak", `onion-host request returned non-onion capabilities: ${nonOnion.join(", ")}`);
    } else {
      ok(`2. onion host request: relay_capabilities = onion-only`);
    }
  }

  // ===== Part 3: public_base_url normalization on onion request. =====
  if (onionTransports.length > 0) {
    if (typeof onion.body.public_base_url === "string" && !onion.body.public_base_url.includes(".onion")) {
      fail("3.public-base", `onion request returned non-onion public_base_url: ${onion.body.public_base_url}`);
    } else if (typeof onion.body.public_base_url === "string") {
      ok(`3. onion request public_base_url is the onion URL`);
    }
  } else {
    ok(`3. (skipped: no onion_base_url configured)`);
  }

  // ===== Part 4: clearnet response still contains onion_base_url
  // when configured, so Tor-using visitors can discover the .onion. =====
  if (clearnet.body.onion_base_url !== null && clearnet.body.onion_base_url !== undefined) {
    ok(`4. clearnet response advertises onion_base_url=${clearnet.body.onion_base_url} (Tor users can discover)`);
  } else {
    ok(`4. (skipped: no onion_base_url configured on this node)`);
  }

  if (failures.length > 0) {
    console.error(`ONION-ORIGIN-GENERATION SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("ONION-ORIGIN-GENERATION SMOKE PASSED");
})().catch((err) => {
  console.error("ONION-ORIGIN-GENERATION SMOKE ERRORED:", err);
  process.exit(1);
});

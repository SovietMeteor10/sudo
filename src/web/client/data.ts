import type { ChatSummary, LocalIdentity, StreamPost } from "./types.js";

export const localIdentity: LocalIdentity = {
  handle: "@SovietMeteor",
  bio: "building sudo",
  status: "quiet",
  privacyMode: "account locked",
  onionState: "relay: connected",
  fingerprintSnippet: "8fa2...",
  portalTransport: "portal: https",
  relayTransport: "relay: unknown",
  nodeName: "sudo",
  nodeBaseUrl: "https://sudochat.xyz",
  nodeOnionBaseUrl: null,
  nodeRoles: ["portal", "identity_registry", "relay", "feed_host", "discovery_index"],
  nodeRelaySummary: "relay capabilities unavailable",
};

export const streamPosts: StreamPost[] = [
  {
    id: "p-001",
    handle: "@SovietMeteor",
    at: "2026-05-06 08:12",
    body: "wired the registry to plain old URLs. the nice thing about boring primitives is that you can inspect them with curl.",
  },
  {
    id: "p-002",
    handle: "@northcatalog",
    at: "2026-05-06 08:47",
    body: "rss still feels like the right shape for a human-scale network: a small note, a timestamp, no applause button.",
  },
  {
    id: "p-003",
    handle: "@SovietMeteor",
    at: "2026-05-06 09:03",
    body: "status: writing the first client shell. three panes. no feed ranking. no counters.",
  },
  {
    id: "p-004",
    handle: "@linebreak",
    at: "2026-05-06 09:31",
    body: "finger endpoints are underrated. stable text over stable routes is easier to archive, mirror, and distrust carefully.",
  },
  {
    id: "p-005",
    handle: "@SovietMeteor",
    at: "2026-05-06 10:06",
    body: "todo: make key continuity understandable without turning the UI into a crypto dashboard.",
  },
];

export const chatSummaries: ChatSummary[] = [
  {
    id: "c-001",
    handle: "@northcatalog",
    state: "quiet",
    lastLine: "sealed note received",
  },
  {
    id: "c-002",
    handle: "@linebreak",
    state: "draft",
    lastLine: "draft saved locally",
  },
  {
    id: "c-003",
    handle: "@SovietMeteor",
    state: "sealed",
    lastLine: "loopback test",
  },
];

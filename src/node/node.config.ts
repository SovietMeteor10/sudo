import { resolve } from "node:path";
import { DEFAULT_MAX_TEXT_MESSAGE_BYTES, KNOWN_MAX_PENDING_PER_PAIR, KNOWN_TTL_DAYS, UNKNOWN_MAX_PENDING_PER_RECIPIENT, UNKNOWN_TTL_HOURS } from "../protocol/constants.js";
import { sha256Hex } from "../crypto/hash.js";
import { sortRelayCapabilities } from "../protocol/relays.js";
import type { NodeCapabilityDocument, RelayCapability, TransportType } from "../protocol/types.js";

const NODE_CREATED_AT = new Date().toISOString();

export type LogLevel = "debug" | "info" | "warn" | "error";

export type NodeRuntimeConfig = {
  nodeName: string;
  publicBaseUrl: string;
  onionBaseUrl: string | null;
  enableHttpsRelayFallback: boolean;
  preferOnionRelays: boolean;
  isLocalDevelopment: boolean;
  bindHost: string;
  bindPort: number;
  dataDir: string;
  dbPath: string;
  allowSignups: boolean;
  requireInvite: boolean;
  logLevel: LogLevel;
};

export function readNodeRuntimeConfig(): NodeRuntimeConfig {
  const nodeName = process.env.SUDO_NODE_NAME?.trim() || "sudo";
  const publicBaseUrl = normalizeBaseUrl(process.env.SUDO_PUBLIC_BASE_URL?.trim() || inferDefaultPublicBaseUrl());
  const onionBaseUrl = normalizeOptionalBaseUrl(process.env.SUDO_ONION_BASE_URL?.trim() || null);
  const dataDir = resolve(process.env.SUDO_DATA_DIR?.trim() || "./data");
  return {
    nodeName,
    publicBaseUrl,
    onionBaseUrl,
    enableHttpsRelayFallback: readBooleanEnv("SUDO_ENABLE_HTTPS_RELAY_FALLBACK", true),
    preferOnionRelays: readBooleanEnv("SUDO_PREFER_ONION_RELAYS", true),
    isLocalDevelopment: isLocalDevelopmentNode(),
    bindHost: readBindHost(),
    bindPort: readBindPort(),
    dataDir,
    dbPath: resolveDbPath(dataDir),
    allowSignups: readBooleanEnv("SUDO_ALLOW_SIGNUPS", true),
    requireInvite: readBooleanEnv("SUDO_REQUIRE_INVITE", false),
    logLevel: readLogLevel()
  };
}

export function resolveIdentityHost(config: NodeRuntimeConfig = readNodeRuntimeConfig()): string {
  const explicit = process.env.SUDO_IDENTITY_HOST?.trim();
  if (explicit) return explicit;

  const legacy = process.env.SUDO_HOST?.trim();
  if (legacy && !looksLikeBindAddress(legacy)) return legacy;

  try {
    return new URL(config.publicBaseUrl).hostname;
  } catch {
    return "localhost";
  }
}

export function buildNodeCapabilityDocument(config: NodeRuntimeConfig = readNodeRuntimeConfig()): NodeCapabilityDocument {
  const relayCapabilities = sortRelayCapabilities(buildRelayCapabilities(config), config.preferOnionRelays);

  return {
    type: "sudo_node",
    protocol_version: "0.1.0",
    node_id: createNodeId(config),
    name: config.nodeName,
    public_base_url: config.publicBaseUrl,
    onion_base_url: config.onionBaseUrl,
    roles: ["portal", "identity_registry", "relay", "feed_host", "discovery_index"],
    relay_capabilities: relayCapabilities,
    created_at: NODE_CREATED_AT,
    software: {
      name: "sudo",
      version: "0.1.0"
    }
  };
}

function buildRelayCapabilities(config: NodeRuntimeConfig): RelayCapability[] {
  const capabilities: RelayCapability[] = [];

  if (config.onionBaseUrl !== null) {
    capabilities.push(createRelayCapability({
      relayId: `${config.nodeName}-onion`,
      transport: "onion",
      url: config.onionBaseUrl,
      priority: 0
    }));
  }

  if (config.enableHttpsRelayFallback && isHttpsUrl(config.publicBaseUrl)) {
    capabilities.push(createRelayCapability({
      relayId: `${config.nodeName}-https`,
      transport: "https",
      url: config.publicBaseUrl,
      priority: config.onionBaseUrl === null ? 10 : 100
    }));
  }

  if (config.isLocalDevelopment) {
    capabilities.push(createRelayCapability({
      relayId: `${config.nodeName}-local-dev`,
      transport: "local_dev",
      url: config.publicBaseUrl,
      priority: 200
    }));
  }

  return capabilities;
}

function createRelayCapability(input: {
  relayId: string;
  transport: TransportType;
  url: string;
  priority: number;
}): RelayCapability {
  return {
    type: "sudo_relay_capability",
    protocol_version: "0.1.0",
    relay_id: input.relayId,
    transport: input.transport,
    url: input.url,
    priority: input.priority,
    supports_store_and_forward: true,
    supports_ack: true,
    supports_unknown_sender_queue: true,
    max_message_bytes: DEFAULT_MAX_TEXT_MESSAGE_BYTES,
    unknown_sender_policy: {
      max_pending: UNKNOWN_MAX_PENDING_PER_RECIPIENT,
      ttl_hours: UNKNOWN_TTL_HOURS
    },
    known_sender_policy: {
      max_pending: KNOWN_MAX_PENDING_PER_PAIR,
      ttl_days: KNOWN_TTL_DAYS
    }
  };
}

function createNodeId(config: NodeRuntimeConfig): string {
  return `sudo-node:${sha256Hex(`${config.nodeName}|${config.publicBaseUrl}|${config.onionBaseUrl ?? ""}`)}`;
}

function inferDefaultPublicBaseUrl(): string {
  if (process.env.NODE_ENV !== "production") {
    return `http://localhost:${process.env.PORT ?? "3000"}`;
  }

  return "https://sudochat.xyz";
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.toString().replace(/\/$/, "");
}

function normalizeOptionalBaseUrl(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return normalizeBaseUrl(value);
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalDevelopmentNode(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.SUDO_LOCAL_DEV === "1" || process.env.SUDO_LOCAL_DEV === "true";
}

function readBindHost(): string {
  const legacy = process.env.HOST?.trim();
  if (legacy) return legacy;
  const value = process.env.SUDO_HOST?.trim();
  if (value) return value;
  return "127.0.0.1";
}

function readBindPort(): number {
  const legacy = process.env.PORT?.trim();
  const next = process.env.SUDO_PORT?.trim();
  const raw = legacy || next || "3000";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return 3000;
  return parsed;
}

function resolveDbPath(dataDir: string): string {
  const explicit = process.env.SUDO_DB_PATH?.trim();
  if (explicit) return resolve(explicit);
  return resolve(dataDir, "sudo.sqlite");
}

function readLogLevel(): LogLevel {
  const value = process.env.SUDO_LOG_LEVEL?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return "info";
}

function looksLikeBindAddress(value: string): boolean {
  if (value === "localhost" || value === "0.0.0.0" || value === "127.0.0.1") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return true;
  if (value.startsWith("::")) return true;
  return false;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

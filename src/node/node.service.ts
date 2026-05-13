import type { NodeCapabilityDocument } from "../protocol/types.js";
import { buildNodeCapabilityDocument, readNodeRuntimeConfig } from "./node.config.js";

export function getNodeCapabilityDocument(): NodeCapabilityDocument {
  return buildNodeCapabilityDocument(readNodeRuntimeConfig());
}

// Phase 12.1: origin-aware capability doc. When a request lands on
// a .onion hostname, suppress the clearnet relay capability from
// the response so an onion client doesn't accidentally fall back
// to a clearnet endpoint. The onion_base_url stays advertised on
// the clearnet path because a Tor-using visitor on clearnet
// benefits from seeing the .onion alternative.
//
// requestHost is `request.hostname` (Express) or null when unknown.
export function getNodeCapabilityDocumentForOrigin(requestHost: string | null): NodeCapabilityDocument {
  const config = readNodeRuntimeConfig();
  const doc = buildNodeCapabilityDocument(config);
  const isOnionRequest = typeof requestHost === "string" && requestHost.toLowerCase().endsWith(".onion");
  if (!isOnionRequest) return doc;
  // On an onion-served request, strip non-onion transports from the
  // advertised relay list. Also normalize public_base_url to the
  // onion URL so generated identity / relay URLs stay onion-native.
  return {
    ...doc,
    public_base_url: config.onionBaseUrl ?? doc.public_base_url,
    relay_capabilities: doc.relay_capabilities.filter((c) => c.transport === "onion")
  };
}

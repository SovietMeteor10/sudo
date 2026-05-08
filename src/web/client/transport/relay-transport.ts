import type { IdentityDocument, RelayCapability } from "../../../protocol/types.js";
import { sortRelayCapabilities } from "../../../protocol/relays.js";

export type RelayTransportPrivacyLevel = "onion" | "https_fallback" | "local_dev";

export type RelayTransportSelection = {
  ok: true;
  relay: RelayCapability;
  privacy_level: RelayTransportPrivacyLevel;
  warning?: string;
};

export type RelayTransportSelectionFailure = {
  ok: false;
  error: "no_delivery_relay";
};

export type RelayTransportSelectionResult = RelayTransportSelection | RelayTransportSelectionFailure;

export function selectRelayForRecipient(
  identityDocument: Pick<IdentityDocument, "delivery_relays">,
  options: {
    preferOnion?: boolean;
  } = {}
): RelayTransportSelectionResult {
  const relays = sortRelayCapabilities(
    Array.isArray(identityDocument.delivery_relays) ? identityDocument.delivery_relays : [],
    options.preferOnion ?? true
  );
  if (relays.length === 0) {
    return { ok: false, error: "no_delivery_relay" };
  }

  const onionRelay = relays.find((relay) => relay.transport === "onion");
  if (onionRelay !== undefined) {
    return {
      ok: true,
      relay: onionRelay,
      privacy_level: "onion"
    };
  }

  const httpsRelay = relays.find((relay) => relay.transport === "https");
  if (httpsRelay !== undefined) {
    return {
      ok: true,
      relay: httpsRelay,
      privacy_level: "https_fallback",
      warning: "HTTPS relay fallback is in use; private message contents stay encrypted, but transport is not onion-routed."
    };
  }

  const localRelay = relays.find((relay) => relay.transport === "local_dev");
  if (localRelay !== undefined) {
    return {
      ok: true,
      relay: localRelay,
      privacy_level: "local_dev",
      warning: "local development relay transport is in use."
    };
  }

  return { ok: false, error: "no_delivery_relay" };
}

export function describePortalTransport(origin: string): "onion" | "local_dev" | "https" {
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith(".onion")) return "onion";
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
      return "local_dev";
    }
    return url.protocol === "https:" ? "https" : "local_dev";
  } catch {
    return "https";
  }
}

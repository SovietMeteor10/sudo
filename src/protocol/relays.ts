import type { RelayCapability, TransportType } from "./types.js";

export function sortRelayCapabilities(relays: RelayCapability[], preferOnionRelays = true): RelayCapability[] {
  return [...relays].sort((left, right) => {
    if (preferOnionRelays) {
      const transportRank = transportPreference(left.transport) - transportPreference(right.transport);
      if (transportRank !== 0) return transportRank;
    }

    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.relay_id.localeCompare(right.relay_id);
  });
}

function transportPreference(transport: TransportType): number {
  switch (transport) {
    case "onion":
      return 0;
    case "local_dev":
      return 1;
    case "https":
    default:
      return 2;
  }
}

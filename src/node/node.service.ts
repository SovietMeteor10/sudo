import type { NodeCapabilityDocument } from "../protocol/types.js";
import { buildNodeCapabilityDocument, readNodeRuntimeConfig } from "./node.config.js";

export function getNodeCapabilityDocument(): NodeCapabilityDocument {
  return buildNodeCapabilityDocument(readNodeRuntimeConfig());
}

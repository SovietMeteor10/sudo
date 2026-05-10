import {
  createEd25519KeyPairBase64Url,
  generateIdentityGrid
} from "../crypto/index.js";
import type { IdentityDocument } from "../protocol/types.js";
import { accountAccessProvider } from "../localState/accountAccess.js";
import { getNodeCapabilityDocument } from "../node/node.service.js";
import { createHandle, getIdentityByHandle, saveIdentity } from "./registry.js";
import { createSignedIdentityDocument } from "./identity.service.js";

export type DevSignupOptions = {
  rawHandle: string;
  password: string;
  recoveryQuestion: string;
  recoveryAnswer: string;
  baseUrl: string;
  host: string;
};

export type DevSignupResult = {
  identity: IdentityDocument;
  backupCode: string;
  canonicalId: string;
};

export class DevSignupError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_handle" | "duplicate_handle"
  ) {
    super(message);
  }
}

// Legacy server-mediated signup. Used today only by HTTP-direct
// fixture smokes (which mint test users fast) and by the
// /api/identity/signup + /dev/signup aliases. The production browser
// path goes through createBrowserCryptoAccount + /api/identity/register
// and never touches this function.
//
// Historical behavior wrote four files per account into data/keys/
// (the identity PEM, the feed PEM, an identity JSON dump, and a
// fingerprint JSON dump). All four writes are now gone. The keypairs
// are still generated in memory long enough to sign the identity
// document the registry stores, then immediately discarded — the
// process never persists them.
//
// Existing PEMs on disk from prior versions are still readable by the
// feed service (operator action: prune them once confident no live
// account depends on them). New accounts created via this function
// cannot be server-signed and therefore must arrive with a valid
// client signature on /api/feeds/posts.
export function createDevIdentity(options: DevSignupOptions): DevSignupResult {
  let handle: string;
  try {
    handle = createHandle(options.rawHandle);
  } catch {
    throw new DevSignupError(
      "handles must be 3-32 chars: letters, numbers, underscore only",
      "invalid_handle"
    );
  }

  if (getIdentityByHandle(handle) !== null) {
    throw new DevSignupError("handle already exists", "duplicate_handle");
  }

  const identityKeys = createEd25519KeyPairBase64Url();
  const feedKeys = createEd25519KeyPairBase64Url();
  const messagingPublicKey = `placeholder:${identityKeys.publicKey.slice(0, 24)}`;
  const nodeDocument = getNodeCapabilityDocument();
  const identityDocument = createSignedIdentityDocument({
    handle,
    homeNode: options.host,
    identityPublicKey: identityKeys.publicKey,
    identityPrivateKey: identityKeys.privateKey,
    messagingPublicKey,
    feedPublicKey: feedKeys.publicKey,
    deliveryRelays: nodeDocument.relay_capabilities
  });
  const canonicalId = identityDocument.canonical_id;
  const legacyDocument: IdentityDocument = {
    ...identityDocument,
    canonical: `@${canonicalId}:${options.host}`,
    public_key: identityDocument.keys.identity.public_key,
    profile: `${options.baseUrl}/u/${encodeURIComponent(canonicalId)}`,
    finger: `${options.baseUrl}/finger/${handle.slice(1)}`,
    inbox: `${options.baseUrl}/inbox/${encodeURIComponent(canonicalId)}`,
    visual_fingerprint: generateIdentityGrid(identityKeys.publicKey)
  };

  try {
    saveIdentity(canonicalId, legacyDocument);
  } catch (error) {
    if (isSqliteUniqueError(error)) {
      throw new DevSignupError("handle already exists", "duplicate_handle");
    }

    throw error;
  }

  // Private key material is intentionally not retained anywhere
  // beyond the locals above. Both `identityKeys.privateKey` and
  // `feedKeys.privateKey` go out of scope when this function returns.
  const credential = accountAccessProvider.createCredential(
    canonicalId,
    options.password,
    options.recoveryQuestion,
    options.recoveryAnswer
  );

  return {
    identity: legacyDocument,
    backupCode: credential.backupCode,
    canonicalId,
  };
}

function isSqliteUniqueError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) || (
    error instanceof Error
    && error.message.includes("UNIQUE constraint failed")
  );
}

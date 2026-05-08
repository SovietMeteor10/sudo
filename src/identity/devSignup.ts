import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

  const keyDir = resolve("data/keys");
  mkdirSync(keyDir, { recursive: true });

  // DEV ONLY: plaintext private key material is stored on the server filesystem.
  // This is unsafe and exists only for local iteration. Production signup must
  // generate and protect keys on the client/device with passkeys, WebAuthn,
  // Secure Enclave, or equivalent hardware-backed key storage.
  writeFileSync(
    resolve(keyDir, `${canonicalId}.dev-private-key.pem`),
    identityKeys.privateKey,
    { mode: 0o600 }
  );

  writeFileSync(
    resolve(keyDir, `${canonicalId}.dev-feed-private-key.pem`),
    feedKeys.privateKey,
    { mode: 0o600 }
  );

  writeFileSync(
    resolve(keyDir, `${canonicalId}.identity.json`),
    `${JSON.stringify(legacyDocument, null, 2)}\n`,
    { mode: 0o600 }
  );

  writeFileSync(
    resolve(keyDir, `${canonicalId}.fingerprint.json`),
    `${JSON.stringify(generateIdentityGrid(identityKeys.publicKey), null, 2)}\n`,
    { mode: 0o600 }
  );

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

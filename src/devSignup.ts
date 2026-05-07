import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCanonicalId,
  createEd25519KeyPair,
  type IdentityDocument,
  type SignableIdentityDocument,
  signIdentityDocument
} from "./crypto.js";
import { accountAccessProvider } from "./accountAccess.js";
import { createHandle, getIdentityByHandle, saveIdentity } from "./registry.js";

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

  const canonicalId = createCanonicalId();
  const canonical = `@${canonicalId}:${options.host}`;
  const keys = createEd25519KeyPair();
  const updatedAt = new Date().toISOString();

  const signableDocument: SignableIdentityDocument = {
    handle,
    canonical,
    public_key: keys.publicKey,
    profile: `${options.baseUrl}/u/${canonicalId}`,
    finger: `${options.baseUrl}/finger/${handle.slice(1)}`,
    inbox: `${options.baseUrl}/inbox/${canonicalId}`,
    updated_at: updatedAt
  };

  const identityDocument: IdentityDocument = {
    ...signableDocument,
    signature: signIdentityDocument(signableDocument, keys.privateKey)
  };

  try {
    saveIdentity(canonicalId, identityDocument);
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
    keys.privateKey,
    { mode: 0o600 }
  );

  writeFileSync(
    resolve(keyDir, `${canonicalId}.identity.json`),
    `${JSON.stringify(identityDocument, null, 2)}\n`,
    { mode: 0o600 }
  );

  const credential = accountAccessProvider.createCredential(
    canonicalId,
    options.password,
    options.recoveryQuestion,
    options.recoveryAnswer
  );

  return {
    identity: identityDocument,
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

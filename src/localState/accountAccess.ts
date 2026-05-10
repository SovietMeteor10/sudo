import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "../storage/db.js";
import { getIdentityByCanonicalId, getIdentityByHandle } from "../identity/registry.js";
import type { IdentityDocument } from "../protocol/types.js";

export type CreatedCredential = {
  backupCode: string;
};

export type DevSession = {
  token: string;
  expiresAt: string;
};

export interface AccountAccessProvider {
  createCredential(canonicalId: string, password: string, recoveryQuestion: string, recoveryAnswer: string): CreatedCredential;
  // unlockCredential removed in migration step 5. The legacy
  // /api/identity/signin route it backed is gone; the production
  // browser portal uses the client-signed challenge flow.
  recoverCredential(handle: string, backupCode: string, recoveryAnswer: string): { identity: IdentityDocument; session: DevSession };
  exportRecoveryMaterial(): never;
  verifyBackupCode(canonicalId: string, backupCode: string): boolean;
  verifyRecoveryAnswer(canonicalId: string, recoveryAnswer: string): boolean;
}

type AccessRow = {
  password_salt: string | null;
  password_hash: string | null;
  recovery_secret_hash: string;
  recovery_phrase_salt: string | null;
  recovery_phrase_hash: string | null;
};

type SessionRow = {
  canonical_id: string;
  expires_at: string;
};

export class DevRecoverySecretProvider implements AccountAccessProvider {
  createCredential(canonicalId: string, password: string, recoveryQuestion: string, recoveryAnswer: string): CreatedCredential {
    const backupCode = formatRecoverySecret(randomBytes(24));
    const passwordSalt = base64Url(randomBytes(16));
    const recoveryPhraseSalt = base64Url(randomBytes(16));
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO dev_account_access (
        canonical_id,
        password_salt,
        password_hash,
        recovery_secret_hash,
        recovery_phrase_salt,
        recovery_phrase_hash,
        recovery_question,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      canonicalId,
      passwordSalt,
      hashPassword(password, passwordSalt),
      hashSecret(backupCode),
      recoveryPhraseSalt,
      hashSecretWithSalt(recoveryAnswer, recoveryPhraseSalt),
      recoveryQuestion,
      createdAt
    );

    return { backupCode };
  }

  recoverCredential(handle: string, backupCode: string, recoveryAnswer: string): { identity: IdentityDocument; session: DevSession } {
    const identity = getIdentityByHandle(handle);
    if (!identity) {
      throw new AccountAccessError("invalid credentials", "invalid_credentials");
    }

    if (
      !this.verifyBackupCode(identity.canonicalId, backupCode)
      || !this.verifyRecoveryAnswer(identity.canonicalId, recoveryAnswer)
    ) {
      throw new AccountAccessError("invalid credentials", "invalid_credentials");
    }

    return {
      identity: identity.document,
      session: createDevSession(identity.canonicalId),
    };
  }

  exportRecoveryMaterial(): never {
    throw new AccountAccessError("raw backup codes are shown once and never stored", "recovery_unavailable");
  }

  verifyBackupCode(canonicalId: string, backupCode: string): boolean {
    const row = db
      .prepare("SELECT recovery_secret_hash FROM dev_account_access WHERE canonical_id = ?")
      .get(canonicalId) as AccessRow | undefined;

    if (!row) return false;

    return timingSafeStringEqual(row.recovery_secret_hash, hashSecret(backupCode));
  }

  verifyRecoveryAnswer(canonicalId: string, recoveryAnswer: string): boolean {
    const row = db
      .prepare("SELECT recovery_secret_hash, recovery_phrase_salt, recovery_phrase_hash FROM dev_account_access WHERE canonical_id = ?")
      .get(canonicalId) as AccessRow | undefined;

    if (!row || row.recovery_phrase_salt === null || row.recovery_phrase_hash === null) return false;

    return timingSafeStringEqual(row.recovery_phrase_hash, hashSecretWithSalt(recoveryAnswer, row.recovery_phrase_salt));
  }

}

export class AccountAccessError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_credentials" | "recovery_unavailable"
  ) {
    super(message);
  }
}

export const accountAccessProvider: AccountAccessProvider = new DevRecoverySecretProvider();

// TODO: WebAuthnPasskeyProvider should create a device-held credential and use
// the authenticator to unlock/sign locally. Biometrics should only unlock the
// local credential; they are not secrets sent to sudo. Recovery should move to
// encrypted backup codes, encrypted device backup, or social recovery.

export function getIdentityForDevSession(token: string): IdentityDocument | null {
  const tokenHash = hashSecret(token);
  const row = db
    .prepare("SELECT canonical_id, expires_at FROM dev_sessions WHERE token_hash = ?")
    .get(tokenHash) as SessionRow | undefined;

  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM dev_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }

  return getIdentityByCanonicalId(row.canonical_id)?.document ?? null;
}

export function createDevSession(canonicalId: string): DevSession {
  const token = base64Url(randomBytes(32));
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.valueOf() + 7 * 24 * 60 * 60 * 1000);

  // DEV ONLY: this local session token is intentionally simple and exists only
  // for local iteration. Production access should be bound to device-held keys.
  db.prepare(`
    INSERT INTO dev_sessions (
      token_hash,
      canonical_id,
      expires_at,
      created_at
    ) VALUES (?, ?, ?, ?)
  `).run(hashSecret(token), canonicalId, expiresAt.toISOString(), createdAt.toISOString());

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashSecretWithSalt(secret: string, salt: string): string {
  return createHash("sha256").update(salt).update("\0").update(secret).digest("hex");
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function formatRecoverySecret(bytes: Buffer): string {
  return base64Url(bytes).match(/.{1,4}/g)?.join("-") ?? base64Url(bytes);
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

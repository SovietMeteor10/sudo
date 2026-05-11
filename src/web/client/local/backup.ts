import { exportAccountSnapshot, importLocalSnapshot } from "./local-store.js";
import type { LocalStateSnapshot } from "./local-types.js";
import { base64Url, base64UrlToBytes, deriveBackupKey, randomBytes, toBufferSource } from "./crypto.js";

const BACKUP_VERSION = 1;
const BACKUP_ITERATIONS = 250000;

export type EncryptedSudoBackup = {
  type: "sudo_backup";
  version: 1;
  created_at: string;
  // The owner whose state this backup contains. Restoring imports records
  // back under the same owner, so account A's backup never leaks into
  // account B's local state.
  owner_canonical_id: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
  };
  ciphertext: string;
};

export async function createEncryptedBackup(ownerCanonicalId: string, passphrase: string): Promise<EncryptedSudoBackup> {
  const snapshot = await exportAccountSnapshot(ownerCanonicalId);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(passphrase, salt, BACKUP_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBufferSource(iv) }, key, plaintext);

  return {
    type: "sudo_backup",
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    owner_canonical_id: ownerCanonicalId,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: BACKUP_ITERATIONS,
      salt: base64Url(salt)
    },
    cipher: {
      name: "AES-GCM",
      iv: base64Url(iv)
    },
    ciphertext: base64Url(ciphertext)
  };
}

export type ImportedBackupResult = {
  handle: string | null;
  canonicalId: string | null;
};

export async function importEncryptedBackup(
  backup: EncryptedSudoBackup,
  passphrase: string
): Promise<ImportedBackupResult> {
  validateBackupEnvelope(backup);
  const salt = base64UrlToBytes(backup.kdf.salt);
  const iv = base64UrlToBytes(backup.cipher.iv);
  const ciphertext = base64UrlToBytes(backup.ciphertext);
  const key = await deriveBackupKey(passphrase, salt, backup.kdf.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBufferSource(iv) }, key, toBufferSource(ciphertext));
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext)) as LocalStateSnapshot;
  validateSnapshot(snapshot);
  await importLocalSnapshot(snapshot);
  // Return the restored account's handle so the caller can chain
  // straight into the challenge-flow signin without prompting the
  // user for the passphrase a second time. A backup file is expected
  // to carry exactly one crypto_account; if there's none the caller
  // falls back to manual signin.
  const account = snapshot.crypto_accounts[0] ?? null;
  return {
    handle: account?.handle ?? null,
    canonicalId: account?.canonical_id ?? null
  };
}

function validateBackupEnvelope(value: EncryptedSudoBackup): void {
  if (
    value.type !== "sudo_backup" ||
    value.version !== BACKUP_VERSION ||
    value.kdf?.name !== "PBKDF2" ||
    value.kdf.hash !== "SHA-256" ||
    value.cipher?.name !== "AES-GCM" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("invalid sudo backup");
  }
}

function validateSnapshot(value: LocalStateSnapshot): void {
  const required = [
    value.events,
    value.messages,
    value.contacts,
    value.subscriptions,
    value.drafts,
    value.crypto_accounts,
    value.identities,
    value.settings,
    value.pending_outbound
  ];

  if (!required.every(Array.isArray)) {
    throw new Error("invalid sudo backup contents");
  }
}

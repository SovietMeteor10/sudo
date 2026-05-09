import type { IdentityDocument, RelayCapability } from "../../../protocol/types.js";
import { deriveBackupKey, randomBytes, toBufferSource, base64Url, base64UrlToBytes } from "../local/crypto.js";
import { getCryptoAccount, saveCryptoAccount } from "../local/local-store.js";
import type { LocalCryptoAccountRecord } from "../local/local-types.js";
import { createIdentityDocumentDraft } from "./identity.js";
import { generateDeviceKeyPair, generateMessagingKeyPair, generateSigningKeyPair, importMessagingKeyPair, importSigningKeyPair } from "./keys.js";
import { signIdentityDocument } from "./signing.js";
import { deriveSyncSymKey } from "./sync.js";

// ACCOUNT_VERSION 2 added the account_sync key to the bundle. v1
// bundles are still readable: unlock generates a fresh sync key and
// re-encrypts the bundle in place. There is no migration path that
// moves any private sync key off-device.
const ACCOUNT_VERSION = 2;
const ACCOUNT_ITERATIONS = 250000;

type StoredPrivateBundle = {
  identity: {
    type: "ed25519" | "ecdsa-p256";
    publicKeySpki: string;
    privateKeyPkcs8: string;
  };
  messaging: {
    type: "x25519" | "ecdh-p256";
    publicKeySpki: string;
    privateKeyPkcs8: string;
  };
  feed: {
    type: "ed25519" | "ecdsa-p256";
    publicKeySpki: string;
    privateKeyPkcs8: string;
  };
  device: {
    type: "ed25519" | "ecdsa-p256";
    publicKeySpki: string;
    privateKeyPkcs8: string;
  };
  // Per-account signing key used to authenticate future encrypted
  // device-to-device sync messages. The private half lives only inside
  // this encrypted bundle; the public half can be advertised later
  // (e.g. via SignedDeviceMembership) once the sync layer lands.
  account_sync?: {
    type: "ed25519" | "ecdsa-p256";
    publicKeySpki: string;
    privateKeyPkcs8: string;
  };
};

export type BrowserCryptoAccount = {
  canonical_id: string;
  handle: string;
  identity_document: IdentityDocument;
  identity_key: CryptoKey;
  feed_key: CryptoKey;
  messaging_key: CryptoKey;
  device_key: CryptoKey;
  account_sync_key: CryptoKey;
  account_sync_public_key_spki: string;
  account_sync_key_type: "ed25519" | "ecdsa-p256";
  // AES-GCM key derived once at unlock from the account sync key's
  // raw bytes. Same on every device that holds the bundle, so paired
  // devices can decrypt each other's sync events without further
  // negotiation. The bytes used to derive it never leave this module.
  account_sync_sym_key: CryptoKey;
  identity_key_type: "ed25519" | "ecdsa-p256";
  messaging_key_type: "x25519" | "ecdh-p256";
};

export type BrowserCryptoAccountDraft = {
  identity_document: IdentityDocument;
  account: BrowserCryptoAccount;
  record: LocalCryptoAccountRecord;
};

let unlockedAccount: BrowserCryptoAccount | null = null;

function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "");
}

export async function createBrowserCryptoAccount(options: {
  handle: string;
  passphrase: string;
  homeNode: string;
  deliveryRelays?: RelayCapability[];
}): Promise<BrowserCryptoAccountDraft> {
  const handle = `@${normalizeHandle(options.handle)}`;
  const identity = await generateSigningKeyPair();
  const feed = await generateSigningKeyPair();
  const messaging = await generateMessagingKeyPair();
  const device = await generateDeviceKeyPair();
  const accountSync = await generateSigningKeyPair();

  const unsigned = await createIdentityDocumentDraft({
    handle,
    homeNode: options.homeNode,
    identityPublicKey: identity.publicKeySpki,
    messagingPublicKey: messaging.publicKeySpki,
    feedPublicKey: feed.publicKeySpki,
    devicePublicKey: device.publicKeySpki,
    deliveryRelays: options.deliveryRelays ?? [],
    identityKeyType: identity.type,
    messagingKeyType: messaging.type,
    feedKeyType: feed.type,
    deviceKeyType: device.type
  });
  const signature = await signIdentityDocument(unsigned, identity.privateKey, identity.type);
  const identityDocument: IdentityDocument = {
    ...unsigned,
    signature
  };

  const accountSyncSymKey = await deriveSyncSymKey(accountSync.privateKeyPkcs8);

  const account: BrowserCryptoAccount = {
    canonical_id: identityDocument.canonical_id,
    handle: identityDocument.handle,
    identity_document: identityDocument,
    identity_key: identity.privateKey,
    feed_key: feed.privateKey,
    messaging_key: messaging.privateKey,
    device_key: device.privateKey,
    account_sync_key: accountSync.privateKey,
    account_sync_public_key_spki: accountSync.publicKeySpki,
    account_sync_key_type: accountSync.type,
    account_sync_sym_key: accountSyncSymKey,
    identity_key_type: identity.type,
    messaging_key_type: messaging.type
  };

  const record = await encryptAccountRecord(identityDocument, account, options.passphrase);
  unlockedAccount = account;
  return { identity_document: identityDocument, account, record };
}

export async function storeBrowserCryptoAccount(record: LocalCryptoAccountRecord): Promise<void> {
  await saveCryptoAccount(record);
}

export async function unlockBrowserCryptoAccount(
  canonicalId: string,
  passphrase: string
): Promise<BrowserCryptoAccount> {
  const record = await getCryptoAccount(canonicalId);
  if (record === null) {
    throw new Error("crypto account not found");
  }

  const identityDocument = JSON.parse(record.identity_document_json) as IdentityDocument;
  const bundle = await decryptAccountBundle(record.encrypted_bundle_json, passphrase);

  const identity = await importSigningKeyPair({
    type: bundle.identity.type,
    publicKeySpki: bundle.identity.publicKeySpki,
    privateKeyPkcs8: bundle.identity.privateKeyPkcs8
  });
  const feed = await importSigningKeyPair({
    type: bundle.feed.type,
    publicKeySpki: bundle.feed.publicKeySpki,
    privateKeyPkcs8: bundle.feed.privateKeyPkcs8
  });
  const messaging = await importMessagingKeyPair({
    type: bundle.messaging.type,
    publicKeySpki: bundle.messaging.publicKeySpki,
    privateKeyPkcs8: bundle.messaging.privateKeyPkcs8
  });
  const device = await importSigningKeyPair({
    type: bundle.device.type,
    publicKeySpki: bundle.device.publicKeySpki,
    privateKeyPkcs8: bundle.device.privateKeyPkcs8
  });

  // Legacy v1 bundles predate account_sync. Generate it here, mark
  // the bundle as needing re-encryption, and persist the upgraded
  // record back to local storage so the next unlock is a no-op. The
  // private sync key never leaves the device.
  let accountSync;
  let accountSyncBundle = bundle.account_sync ?? null;
  if (accountSyncBundle === null) {
    const generated = await generateSigningKeyPair();
    accountSync = generated;
    accountSyncBundle = {
      type: generated.type,
      publicKeySpki: generated.publicKeySpki,
      privateKeyPkcs8: generated.privateKeyPkcs8
    };
  } else {
    accountSync = await importSigningKeyPair({
      type: accountSyncBundle.type,
      publicKeySpki: accountSyncBundle.publicKeySpki,
      privateKeyPkcs8: accountSyncBundle.privateKeyPkcs8
    });
  }

  const accountSyncSymKey = await deriveSyncSymKey(accountSyncBundle.privateKeyPkcs8);

  unlockedAccount = {
    canonical_id: identityDocument.canonical_id,
    handle: identityDocument.handle,
    identity_document: identityDocument,
    identity_key: identity.privateKey,
    feed_key: feed.privateKey,
    messaging_key: messaging.privateKey,
    device_key: device.privateKey,
    account_sync_key: accountSync.privateKey,
    account_sync_public_key_spki: accountSyncBundle.publicKeySpki,
    account_sync_key_type: accountSyncBundle.type,
    account_sync_sym_key: accountSyncSymKey,
    identity_key_type: identity.type,
    messaging_key_type: messaging.type
  };

  if (bundle.account_sync === undefined) {
    const upgraded = await encryptAccountRecord(identityDocument, unlockedAccount, passphrase);
    await saveCryptoAccount(upgraded);
  }

  return unlockedAccount;
}

export function lockBrowserCryptoAccount(): void {
  unlockedAccount = null;
}

export function getUnlockedBrowserCryptoAccount(): BrowserCryptoAccount | null {
  return unlockedAccount;
}

async function encryptAccountRecord(
  identityDocument: IdentityDocument,
  account: BrowserCryptoAccount,
  passphrase: string
): Promise<LocalCryptoAccountRecord> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(passphrase, salt, ACCOUNT_ITERATIONS);
  const bundle: StoredPrivateBundle = {
    identity: {
      type: account.identity_key_type,
      publicKeySpki: account.identity_document.keys.identity.public_key,
      privateKeyPkcs8: base64Url(await crypto.subtle.exportKey("pkcs8", account.identity_key))
    },
    messaging: {
      type: account.messaging_key_type,
      publicKeySpki: account.identity_document.keys.messaging.public_key,
      privateKeyPkcs8: base64Url(await crypto.subtle.exportKey("pkcs8", account.messaging_key))
    },
    feed: {
      type: account.identity_key_type,
      publicKeySpki: account.identity_document.keys.feed.public_key,
      privateKeyPkcs8: base64Url(await crypto.subtle.exportKey("pkcs8", account.feed_key))
    },
    device: {
      type: account.identity_key_type,
      publicKeySpki: account.identity_document.keys.device?.public_key ?? account.identity_document.keys.identity.public_key,
      privateKeyPkcs8: base64Url(await crypto.subtle.exportKey("pkcs8", account.device_key))
    },
    account_sync: {
      type: account.account_sync_key_type,
      publicKeySpki: account.account_sync_public_key_spki,
      privateKeyPkcs8: base64Url(await crypto.subtle.exportKey("pkcs8", account.account_sync_key))
    }
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    new TextEncoder().encode(JSON.stringify(bundle))
  );

  return {
    canonical_id: identityDocument.canonical_id,
    handle: identityDocument.handle,
    home_node: identityDocument.home_node,
    identity_document_json: JSON.stringify(identityDocument),
    encrypted_bundle_json: JSON.stringify({
      type: "sudo_crypto_account",
      version: ACCOUNT_VERSION,
      created_at: identityDocument.created_at,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: ACCOUNT_ITERATIONS,
        salt: base64Url(salt)
      },
      cipher: {
        name: "AES-GCM",
        iv: base64Url(iv)
      },
      ciphertext: base64Url(ciphertext)
    }),
    created_at: identityDocument.created_at,
    updated_at: identityDocument.updated_at
  };
}

async function decryptAccountBundle(value: string, passphrase: string): Promise<StoredPrivateBundle> {
  const envelope = JSON.parse(value) as {
    type: string;
    version: number;
    kdf: { name: string; hash: string; iterations: number; salt: string };
    cipher: { name: string; iv: string };
    ciphertext: string;
  };

  // v1 bundles predate account_sync; unlock will detect the missing
  // field and re-encrypt at v2 in place. Anything outside [1, 2] is
  // rejected.
  const acceptedVersions = new Set([1, ACCOUNT_VERSION]);
  if (
    envelope.type !== "sudo_crypto_account"
    || !acceptedVersions.has(envelope.version)
    || envelope.kdf?.name !== "PBKDF2"
    || envelope.kdf?.hash !== "SHA-256"
    || envelope.cipher?.name !== "AES-GCM"
  ) {
    throw new Error("invalid crypto account");
  }

  const key = await deriveBackupKey(passphrase, base64UrlToBytes(envelope.kdf.salt), envelope.kdf.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(base64UrlToBytes(envelope.cipher.iv)) },
    key,
    toBufferSource(base64UrlToBytes(envelope.ciphertext))
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as StoredPrivateBundle;
}

import type { IdentityDocument, RelayCapability } from "../../../protocol/types.js";
import { deriveBackupKey, randomBytes, toBufferSource, base64Url, base64UrlToBytes } from "../local/crypto.js";
import { getCryptoAccount, saveCryptoAccount } from "../local/local-store.js";
import type { LocalCryptoAccountRecord } from "../local/local-types.js";
import { createIdentityDocumentDraft } from "./identity.js";
import { generateDeviceKeyPair, generateMessagingKeyPair, generateSigningKeyPair, importMessagingKeyPair, importSigningKeyPair } from "./keys.js";
import { signIdentityDocument } from "./signing.js";

const ACCOUNT_VERSION = 1;
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
};

export type BrowserCryptoAccount = {
  canonical_id: string;
  handle: string;
  identity_document: IdentityDocument;
  identity_key: CryptoKey;
  feed_key: CryptoKey;
  messaging_key: CryptoKey;
  device_key: CryptoKey;
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

  const account: BrowserCryptoAccount = {
    canonical_id: identityDocument.canonical_id,
    handle: identityDocument.handle,
    identity_document: identityDocument,
    identity_key: identity.privateKey,
    feed_key: feed.privateKey,
    messaging_key: messaging.privateKey,
    device_key: device.privateKey,
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

  unlockedAccount = {
    canonical_id: identityDocument.canonical_id,
    handle: identityDocument.handle,
    identity_document: identityDocument,
    identity_key: identity.privateKey,
    feed_key: feed.privateKey,
    messaging_key: messaging.privateKey,
    device_key: device.privateKey,
    identity_key_type: identity.type,
    messaging_key_type: messaging.type
  };

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

  if (
    envelope.type !== "sudo_crypto_account"
    || envelope.version !== ACCOUNT_VERSION
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

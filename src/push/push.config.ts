// VAPID configuration.
//
// In production we want operators to supply a long-lived VAPID keypair
// via env vars (SUDO_VAPID_PUBLIC_KEY / SUDO_VAPID_PRIVATE_KEY /
// SUDO_VAPID_SUBJECT) so a node redeploy does not invalidate existing
// subscriptions. In local development that's awkward — every fresh
// clone would need to generate one — so we fall back to a persisted
// keypair under SUDO_DATA_DIR/vapid.json. The auto-generated keypair
// lives alongside the SQLite DB, has the same trust level, and is
// gitignored by the existing data/ rule.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import webpush from "web-push";
import { readNodeRuntimeConfig } from "../node/node.config.js";

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

let cached: VapidKeys | null = null;

function envOrNull(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultSubject(): string {
  const explicit = envOrNull("SUDO_VAPID_SUBJECT");
  if (explicit) return explicit.startsWith("mailto:") || explicit.startsWith("http") ? explicit : `mailto:${explicit}`;
  // RFC 8292 requires either an https URL or a mailto. We default to a
  // local mailto so the value is syntactically valid even when nothing
  // is configured; operators should override in prod.
  return "mailto:admin@sudochat.xyz";
}

function persistedPath(): string {
  return resolve(readNodeRuntimeConfig().dataDir, "vapid.json");
}

function readPersisted(): VapidKeys | null {
  const path = persistedPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.publicKey === "string" && typeof parsed?.privateKey === "string") {
      return {
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
        subject: typeof parsed.subject === "string" && parsed.subject.length > 0
          ? parsed.subject
          : defaultSubject()
      };
    }
  } catch {
    /* fall through to regenerate */
  }
  return null;
}

function writePersisted(keys: VapidKeys): void {
  const path = persistedPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { encoding: "utf-8" });
  // Tighten perms — the private key is sensitive (it signs the server's
  // VAPID JWTs). Same threat model as the SQLite DB next to it.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const envPub = envOrNull("SUDO_VAPID_PUBLIC_KEY");
  const envPriv = envOrNull("SUDO_VAPID_PRIVATE_KEY");
  if (envPub && envPriv) {
    cached = { publicKey: envPub, privateKey: envPriv, subject: defaultSubject() };
    return cached;
  }

  const persisted = readPersisted();
  if (persisted) {
    cached = persisted;
    return cached;
  }

  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: defaultSubject()
  };
  writePersisted(keys);
  cached = keys;
  return keys;
}

// Expose only the public half + subject to the world.
export function getPublicVapidKey(): string {
  return getVapidKeys().publicKey;
}

// Cache reset (smoke harness uses this).
export function resetVapidCacheForTests(): void {
  cached = null;
}

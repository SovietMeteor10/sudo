// PWA + service worker bridge.
//
// Responsibilities:
//   - Register /sw.js on demand (called after the user signs in so we
//     never request notification permission on a cold landing).
//   - Unregister on sign-out / reset so a recycled device can't keep
//     receiving notifications for the previous account.
//   - Foreground dedup: when the user has a tab focused on a
//     conversation, tell the SW to suppress push notifications for that
//     conversation_hint. The page is already painting the message, the
//     OS-level toast would be redundant.
//   - Web Push subscription provisioning: after SW activation, fetch
//     the VAPID public key, call pushManager.subscribe(...), and POST
//     the subscription to /api/push/subscriptions. We never prompt for
//     notification permission unless the caller passes
//     requestPermission: true, so an early sign-in flow can defer the
//     prompt until the user does something opt-in-coded.
//   - Receive notification-click routing requests from the SW and hand
//     them to the page via a configurable callback.
//
// All entry points are tolerant of "no service worker support" because
// older mobile WebViews (and some test environments) lack navigator
// .serviceWorker.

import {
  deletePushSubscription,
  fetchVapidPublicKey,
  registerPushSubscription
} from "./api.js";
import { getLocalDeviceMetadata } from "./local/local-store.js";

let registration: ServiceWorkerRegistration | null = null;
let registerInflight: Promise<ServiceWorkerRegistration | null> | null = null;
let openConversationListener: ((hint: string) => void) | null = null;
let messageHandlerInstalled = false;

function isSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

function ensureMessageHandler(): void {
  if (messageHandlerInstalled) return;
  if (!isSupported()) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "sudo/open-conversation" && typeof data.hint === "string") {
      openConversationListener?.(data.hint);
    }
  });
  messageHandlerInstalled = true;
}

export function setOpenConversationListener(listener: (hint: string) => void): void {
  openConversationListener = listener;
  ensureMessageHandler();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  if (registration) return registration;
  if (registerInflight) return registerInflight;
  ensureMessageHandler();
  registerInflight = (async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      registration = reg;
      return reg;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[pwa] service worker registration failed", err);
      return null;
    } finally {
      registerInflight = null;
    }
  })();
  return registerInflight;
}

export async function unregisterServiceWorker(): Promise<void> {
  if (!isSupported()) return;
  try {
    const reg = registration ?? (await navigator.serviceWorker.getRegistration("/"));
    if (reg) {
      // Close any notifications the SW currently owns before tearing
      // it down. After unregister there's no SW to receive a
      // message, so we have to do it before .unregister().
      try {
        reg.active?.postMessage({ type: "sudo/clear-notifications" });
      } catch { /* ignore */ }
      await reg.unregister();
    }
  } catch {
    /* ignore */
  } finally {
    registration = null;
    // Drop the app badge if the platform supports it.
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    if (typeof nav.clearAppBadge === "function") {
      try { await nav.clearAppBadge(); } catch { /* ignore */ }
    }
  }
}

async function postToSw(message: unknown): Promise<void> {
  if (!isSupported()) return;
  const reg = registration ?? (await navigator.serviceWorker.getRegistration("/"));
  reg?.active?.postMessage(message);
}

// Tell the SW to suppress notifications for this conversation_hint until
// further notice (or until the SW's auto-expire kicks in). Call this when
// the user opens a conversation in the foreground. Idempotent.
export function suppressConversation(hint: string): void {
  void postToSw({ type: "sudo/suppress-conversation", hint });
}

export function unsuppressConversation(hint: string): void {
  void postToSw({ type: "sudo/unsuppress-conversation", hint });
}

export function clearAllNotifications(): void {
  void postToSw({ type: "sudo/clear-notifications" });
}

// Exposed for smokes / debugging. Returns the live registration if one
// exists, without creating one.
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  return registration ?? (await navigator.serviceWorker.getRegistration("/")) ?? null;
}

// ============================================================
// Web Push subscription provisioning.
// ============================================================

function pushSupported(): boolean {
  return isSupported() && typeof window !== "undefined" && "PushManager" in window;
}

function base64UrlToArrayBuffer(input: string): ArrayBuffer {
  const padding = "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = (input + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type EnsurePushOptions = {
  ownerCanonicalId: string;
  // If true, prompt the user for Notification.permission when it's
  // currently "default". When false (the default), we only continue
  // if permission has already been granted in a prior session.
  requestPermission?: boolean;
};

// Ensure this device has a push subscription registered on the server
// for the given owner. Idempotent — the server upserts on
// (device_id, endpoint) so repeated calls don't grow the table. The
// returned promise resolves with the registered endpoint, or null
// when push isn't supported / permission wasn't granted.
export async function ensurePushSubscription(opts: EnsurePushOptions): Promise<string | null> {
  if (!pushSupported()) return null;
  if (typeof Notification === "undefined") return null;

  let permission = Notification.permission;
  if (permission === "denied") return null;
  if (permission === "default") {
    if (!opts.requestPermission) return null;
    try { permission = await Notification.requestPermission(); }
    catch { return null; }
    if (permission !== "granted") return null;
  }

  const meta = await getLocalDeviceMetadata();
  if (meta === null || typeof meta.device_id !== "string") return null;

  const reg = await registerServiceWorker();
  if (reg === null) return null;

  let vapidPublicKey: string;
  try { vapidPublicKey = await fetchVapidPublicKey(); }
  catch { return null; }

  let subscription = await reg.pushManager.getSubscription();
  if (subscription === null) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(vapidPublicKey)
      });
    } catch {
      return null;
    }
  }

  const p256dh = arrayBufferToBase64Url(subscription.getKey("p256dh"));
  const auth = arrayBufferToBase64Url(subscription.getKey("auth"));
  if (!p256dh || !auth) return null;

  try {
    await registerPushSubscription({
      owner_canonical_id: opts.ownerCanonicalId,
      device_id: meta.device_id,
      endpoint: subscription.endpoint,
      p256dh,
      auth
    });
  } catch {
    return null;
  }
  return subscription.endpoint;
}

// Tear down this device's push subscription, both at the server (so
// the row goes away immediately) and at the browser (so the SW can no
// longer deliver). Used by sign-out + reset-this-device.
export async function teardownPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const subscription = reg ? await reg.pushManager.getSubscription() : null;
    const meta = await getLocalDeviceMetadata();
    if (subscription !== null && meta !== null) {
      await deletePushSubscription({ device_id: meta.device_id, endpoint: subscription.endpoint });
    }
    if (subscription !== null) {
      try { await subscription.unsubscribe(); } catch { /* ignore */ }
    }
  } catch {
    /* best-effort */
  }
}

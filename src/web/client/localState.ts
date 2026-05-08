import type { ChatSummary } from "./types.js";
import {
  deleteSetting,
  getLocalChatsFromContacts,
  getSetting,
  putSetting,
  upsertContact
} from "./local/local-store.js";

const DEV_SESSION_TOKEN_STORAGE_KEY = "sudo.dev.sessionToken";

export async function readDevSessionToken(): Promise<string | null> {
  const value = await getSetting(DEV_SESSION_TOKEN_STORAGE_KEY);
  return typeof value === "string" ? value : null;
}

export function writeDevSessionToken(token: string): Promise<void> {
  return putSetting(DEV_SESSION_TOKEN_STORAGE_KEY, token);
}

export function clearDevSessionToken(): Promise<void> {
  return deleteSetting(DEV_SESSION_TOKEN_STORAGE_KEY);
}

export async function readLocalChats(): Promise<ChatSummary[]> {
  return getLocalChatsFromContacts();
}

export async function persistLocalChats(chats: ChatSummary[]): Promise<void> {
  await Promise.all(chats.map((chat) => upsertContact({
    canonical_id: chat.canonical ?? chat.id,
    handle: chat.handle,
    tier: "unknown",
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    fingerprint: chat.fingerprint
  })));
}

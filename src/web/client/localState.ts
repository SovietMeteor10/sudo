import {
  deleteSetting,
  getSetting,
  putSetting
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

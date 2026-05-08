import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function base64Url(value: Buffer | Uint8Array | string): string {
  const buffer = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function base64UrlToBuffer(value: string): Buffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

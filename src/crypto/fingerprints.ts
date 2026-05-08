import type { IdentityFingerprint } from "../protocol/types.js";
import { sha256Bytes, sha256Hex } from "./hash.js";

export function fingerprintPublicKey(publicKey: string): string {
  return sha256Hex(publicKey);
}

export function generateIdentityFingerprint(publicKey: string): string {
  const hash = sha256Hex(publicKey);
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

export function generateIdentityGrid(publicKey: string): IdentityFingerprint {
  const hash = sha256Bytes(publicKey);
  const colors = [
    `#${hash.toString("hex", 4, 7)}`,
    `#${hash.toString("hex", 7, 10)}`,
    `#${hash.toString("hex", 10, 13)}`,
    `#${hash.toString("hex", 13, 16)}`
  ];
  const pattern = hash.subarray(0, 4);
  const cells: IdentityFingerprint["cells"] = [];

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sourceIndex = (y * 4) + (x < 4 ? x : 7 - x);
      const byte = pattern[Math.floor(sourceIndex / 8)]!;
      const bit = (byte >> (7 - (sourceIndex % 8))) & 1;
      const colorIndex = hash[(y * 8 + x) % hash.length]! % colors.length;
      cells.push({
        x,
        y,
        on: bit === 1,
        color: bit === 1 ? colors[colorIndex]! : "#111111"
      });
    }
  }

  return {
    fingerprint: generateIdentityFingerprint(publicKey),
    grid_size: 8,
    bits: 32,
    cells
  };
}

export function compareIdentityFingerprint(
  oldFingerprint: IdentityFingerprint | string,
  newFingerprint: IdentityFingerprint | string
): { changed: boolean } {
  const oldValue = typeof oldFingerprint === "string" ? oldFingerprint : oldFingerprint.fingerprint;
  const newValue = typeof newFingerprint === "string" ? newFingerprint : newFingerprint.fingerprint;
  return { changed: oldValue !== newValue };
}

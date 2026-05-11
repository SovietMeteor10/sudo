// Browser-side mirror of generateIdentityGrid in src/crypto/fingerprints.ts.
// Mirrors the same bit/color layout so the visual fingerprint a user sees
// in their account dialog matches the one a peer sees in a lookup card.
//
// The server version uses Node Buffer; this one works from the
// fingerprintPublicKey hex string we already have in
// currentIdentityFingerprint, so callers don't have to async-hash again.

import type { IdentityFingerprint } from "../../../protocol/types.js";

export function gridFromFingerprintHex(fingerprintHex: string): IdentityFingerprint {
  const bytes = hexToBytes(fingerprintHex);
  if (bytes.length < 16) {
    throw new Error("fingerprint hex must be at least 32 chars (16 bytes)");
  }
  const colors = [
    `#${fingerprintHex.slice(8, 14)}`,
    `#${fingerprintHex.slice(14, 20)}`,
    `#${fingerprintHex.slice(20, 26)}`,
    `#${fingerprintHex.slice(26, 32)}`
  ];
  const pattern = bytes.slice(0, 4);
  const cells: IdentityFingerprint["cells"] = [];

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sourceIndex = (y * 4) + (x < 4 ? x : 7 - x);
      const byte = pattern[Math.floor(sourceIndex / 8)]!;
      const bit = (byte >> (7 - (sourceIndex % 8))) & 1;
      const colorIndex = bytes[(y * 8 + x) % bytes.length]! % colors.length;
      cells.push({
        x,
        y,
        on: bit === 1,
        color: bit === 1 ? colors[colorIndex]! : "#111111"
      });
    }
  }

  return {
    fingerprint: `${fingerprintHex.slice(0, 4)}-${fingerprintHex.slice(4, 8)}-${fingerprintHex.slice(8, 12)}-${fingerprintHex.slice(12, 16)}`,
    grid_size: 8,
    bits: 32,
    cells
  };
}

function hexToBytes(hex: string): Uint8Array {
  const length = hex.length >>> 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

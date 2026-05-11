// Minimal QR Code encoder for short URLs. Hardcoded to version 3,
// byte mode, error-correction level L. Capacity: 53 bytes (the
// `https://sudochat.xyz/?collect=ABCDEF-123456` form is ~46 bytes).
// Output: a self-contained <svg> string with no external deps.
//
// Algorithm follows ISO/IEC 18004:2015. The narrow scope (one
// version, one ECL, fixed mask 0) lets us skip dynamic version
// selection, alignment-pattern placement (v3 has none beyond the
// finders), block interleaving (v3-L is single-block), and mask
// scoring. This module exists only to render the temporary
// passcode URL as a glyph the user can scan with their phone — a
// general-purpose QR encoder is overkill.
//
// Public domain. The algorithm is the QR Code spec, the constants
// are the spec's tables, and the implementation has no external
// dependencies.

const QR_VERSION = 3; // 29x29 modules
const QR_SIZE = 17 + 4 * QR_VERSION; // 29
const DATA_CODEWORDS = 55; // version 3, EC level L
const EC_CODEWORDS = 15;   // version 3, EC level L
const TOTAL_CODEWORDS = DATA_CODEWORDS + EC_CODEWORDS; // 70
const MAX_BYTES = DATA_CODEWORDS - 2; // 53 (mode nibble + 8-bit length take 2 bytes)

export function encodeUrlToQrSvg(data: string, moduleSize: number = 6, quietZone: number = 4): string {
  const bytes = new TextEncoder().encode(data);
  if (bytes.length > MAX_BYTES) {
    throw new Error(`qr: data too long (${bytes.length} bytes; max ${MAX_BYTES})`);
  }

  const dataCodewords = encodeDataCodewords(bytes);
  const ecCodewords = reedSolomonEncode(dataCodewords, EC_CODEWORDS);
  const allCodewords = [...dataCodewords, ...ecCodewords];

  const matrix = buildMatrix(allCodewords);

  return renderSvg(matrix, moduleSize, quietZone);
}

// ----- Data encoding -----

function encodeDataCodewords(bytes: Uint8Array): number[] {
  // Bit stream: mode indicator (4 bits) + character count (8 bits
  // for byte mode in v1-v9) + data bytes + terminator + pad.
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // byte mode indicator
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  // Terminator: up to 4 zero bits, only if there's room.
  const terminatorBits = Math.min(4, DATA_CODEWORDS * 8 - bits.length);
  for (let i = 0; i < terminatorBits; i++) bits.push(0);
  // Pad to a byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes alternate between 0xEC and 0x11 until DATA_CODEWORDS.
  const padBytes = [0xEC, 0x11];
  let padIndex = 0;
  while (bits.length < DATA_CODEWORDS * 8) {
    pushBits(bits, padBytes[padIndex % 2]!, 8);
    padIndex++;
  }
  // Pack to bytes.
  const codewords: number[] = [];
  for (let i = 0; i < DATA_CODEWORDS; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!;
    codewords.push(byte);
  }
  return codewords;
}

function pushBits(bits: number[], value: number, count: number): void {
  for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

// ----- Reed-Solomon over GF(256) with primitive poly 0x11d -----

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGfTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function reedSolomonGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    g = polyMul(g, [1, GF_EXP[i]!]);
  }
  return g;
}

function polyMul(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = (out[i + j] ?? 0) ^ gfMul(a[i]!, b[j]!);
    }
  }
  return out;
}

function reedSolomonEncode(data: number[], ecCount: number): number[] {
  const generator = reedSolomonGenerator(ecCount);
  const buffer = new Array<number>(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) buffer[i] = data[i]!;
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      buffer[i + j] = buffer[i + j]! ^ gfMul(generator[j]!, factor);
    }
  }
  return buffer.slice(data.length);
}

// ----- Matrix layout -----

function buildMatrix(codewords: number[]): boolean[][] {
  // -1 = unset, 0/1 = set. We use a numeric matrix during layout
  // so we can distinguish unset cells when zigzagging data; convert
  // to boolean at the end.
  const m: number[][] = [];
  for (let r = 0; r < QR_SIZE; r++) m.push(new Array<number>(QR_SIZE).fill(-1));

  placeFinder(m, 0, 0);
  placeFinder(m, QR_SIZE - 7, 0);
  placeFinder(m, 0, QR_SIZE - 7);
  placeSeparators(m);
  placeTimingPatterns(m);
  reserveFormatBits(m);
  // v3 has no alignment patterns beyond the finders.

  placeData(m, codewords);
  applyMask(m);
  writeFormatBits(m, 0b01, 0); // ECL L = 01, mask 0

  const out: boolean[][] = [];
  for (const row of m) out.push(row.map((v) => v === 1));
  return out;
}

function placeFinder(m: number[][], top: number, left: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = top + r;
      const cc = left + c;
      if (rr < 0 || rr >= QR_SIZE || cc < 0 || cc >= QR_SIZE) continue;
      const onBorder = (r === 0 || r === 6 || c === 0 || c === 6);
      const inCenter = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      const inSeparator = (r === -1 || r === 7 || c === -1 || c === 7);
      if (inSeparator) m[rr]![cc] = 0;
      else if (onBorder || inCenter) m[rr]![cc] = 1;
      else m[rr]![cc] = 0;
    }
  }
}

function placeSeparators(_m: number[][]): void {
  // placeFinder already sets the separator ring (r/c = -1 or 7)
  // around each finder pattern, so this is a noop kept for
  // narrative clarity.
}

function placeTimingPatterns(m: number[][]): void {
  for (let i = 8; i < QR_SIZE - 8; i++) {
    if (m[6]![i] === -1) m[6]![i] = (i % 2 === 0) ? 1 : 0;
    if (m[i]![6] === -1) m[i]![6] = (i % 2 === 0) ? 1 : 0;
  }
}

function reserveFormatBits(m: number[][]): void {
  // Format-info cells around the top-left, top-right, bottom-left
  // finders. Filled with 0 placeholders; writeFormatBits replaces
  // them after data placement so they don't compete for the data
  // zigzag.
  for (let i = 0; i < 9; i++) {
    if (m[8]![i] === -1) m[8]![i] = 0;
    if (m[i]![8] === -1) m[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[QR_SIZE - 1 - i]![8] === -1) m[QR_SIZE - 1 - i]![8] = 0;
    if (m[8]![QR_SIZE - 1 - i] === -1) m[8]![QR_SIZE - 1 - i] = 0;
  }
  // Fixed dark module (bottom-left of NW finder timing area).
  m[QR_SIZE - 8]![8] = 1;
}

function placeData(m: number[][], codewords: number[]): void {
  // Walk the matrix in the QR zigzag order, two columns at a time,
  // alternating direction, filling each unset cell from the data
  // bit stream.
  let bitIndex = 0;
  let upward = true;
  for (let col = QR_SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the timing-pattern column
    for (let i = 0; i < QR_SIZE; i++) {
      const row = upward ? QR_SIZE - 1 - i : i;
      for (let cOffset = 0; cOffset < 2; cOffset++) {
        const c = col - cOffset;
        if (m[row]![c] !== -1) continue;
        const codewordIdx = bitIndex >> 3;
        const bitIdx = 7 - (bitIndex & 7);
        const bit = codewordIdx < codewords.length ? ((codewords[codewordIdx]! >> bitIdx) & 1) : 0;
        m[row]![c] = bit;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function applyMask(m: number[][]): void {
  // Mask 0: invert if (row + col) % 2 === 0. Skip function-pattern
  // cells (the ones placeData didn't touch are reserved/filled).
  // We need a parallel "is data" map; rebuild it from the layout.
  const fixed = buildFixedMask();
  for (let r = 0; r < QR_SIZE; r++) {
    for (let c = 0; c < QR_SIZE; c++) {
      if (fixed[r]![c]) continue;
      if ((r + c) % 2 === 0) m[r]![c] ^= 1;
    }
  }
}

function buildFixedMask(): boolean[][] {
  const f: boolean[][] = [];
  for (let r = 0; r < QR_SIZE; r++) f.push(new Array<boolean>(QR_SIZE).fill(false));
  // Three finder patterns + their separators (8x8 each).
  for (const [tr, tc] of [[0, 0], [0, QR_SIZE - 8], [QR_SIZE - 8, 0]] as Array<[number, number]>) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const rr = tr + r;
        const cc = tc + c;
        if (rr >= 0 && rr < QR_SIZE && cc >= 0 && cc < QR_SIZE) f[rr]![cc] = true;
      }
    }
  }
  // Timing patterns.
  for (let i = 0; i < QR_SIZE; i++) { f[6]![i] = true; f[i]![6] = true; }
  // Format-info reserved cells.
  for (let i = 0; i < 9; i++) { f[8]![i] = true; f[i]![8] = true; }
  for (let i = 0; i < 8; i++) {
    f[QR_SIZE - 1 - i]![8] = true;
    f[8]![QR_SIZE - 1 - i] = true;
  }
  return f;
}

function writeFormatBits(m: number[][], ecl: number, mask: number): void {
  // 5-bit format = (ecl << 3) | mask, BCH-encoded with generator
  // 0x537 then XOR'd with mask 0x5412.
  const format = (ecl << 3) | mask;
  let bits = format << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bits >> i) & 1) bits ^= 0x537 << (i - 10);
  }
  const encoded = ((format << 10) | bits) ^ 0x5412;
  // Place the 15 bits in their two redundant locations.
  for (let i = 0; i < 15; i++) {
    const bit = (encoded >> i) & 1;
    // First copy: under the NW finder.
    if (i < 6) m[i]![8] = bit;
    else if (i < 8) m[i + 1]![8] = bit;
    else if (i < 9) m[7]![8] = bit;
    else m[14 - i]![8] = bit;
    // Second copy: alongside the NE / SW finders.
    if (i < 8) m[8]![QR_SIZE - 1 - i] = bit;
    else m[8]![15 - i] = bit;
  }
}

function renderSvg(matrix: boolean[][], moduleSize: number, quietZone: number): string {
  const dim = (matrix.length + 2 * quietZone) * moduleSize;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r]![c]) continue;
      const x = (c + quietZone) * moduleSize;
      const y = (r + quietZone) * moduleSize;
      parts.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#000000"/>`);
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}

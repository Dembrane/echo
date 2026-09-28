/**
 * Brand QR code for the popcorn screen, byte for byte the markup the Python service's
 * `qr_svg_markup` produced, so the stage and anything that cached or compared the old
 * output see no change. It is a port of the parts of segno 1.6.6 that call reaches:
 * `segno.make(url, error="h")` saved as SVG with scale 1, border 1, one dark colour and no
 * light colour, then the viewBox rewrite and the logo overlay.
 *
 * Deliberately left out, because this call can never reach them: Micro QR codes (error
 * level H rules them out), explicit version, mode, mask and encoding arguments, ECI,
 * structured append, Hanzi mode (segno only uses it when asked by name) and the
 * multicolour SVG writer (dark and finder dark are the same colour, so segno takes the
 * two colour path). Kanji mode is kept: segno picks it on its own for text made only of
 * JIS X 0208 double byte characters, and a URL never is, but a stray call would otherwise
 * render a different code.
 */

const GRAPHITE = "#2D2D2C";
// Logo clearing as a share of the symbol width. Error level H survives 30% damage; the
// circle covers about 7% of the modules.
const LOGO_SHARE = 0.24;
const LOGO_PADDING = 1.4;
const BORDER = 1;

// Mirrors the Python lru_cache(maxsize=256): the popcorn state is polled, so the same few
// URLs are rendered over and over.
const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

export function qrSvgMarkup(url: string, logoHref = "logo.png"): string {
  const key = JSON.stringify([url, logoHref]);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const svg = render(url, logoHref);
  cache.set(key, svg);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return svg;
}

function render(url: string, logoHref: string): string {
  const matrix = encode(url);
  const size = matrix.length + 2 * BORDER;
  const path = svgPath(matrix, webColor(GRAPHITE));
  const logo = size * LOGO_SHARE;
  const c = size / 2;
  // toFixed matches Python's ".2f" here: both round the exact binary value, and they only
  // disagree on exact ties, which these sums of 0.24 * odd width and 1.4 never produce.
  const f = (n: number): string => n.toFixed(2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="100%" height="100%" role="img" shape-rendering="crispEdges">` +
    path +
    `<circle cx="${f(c)}" cy="${f(c)}" r="${f(logo / 2 + LOGO_PADDING)}" fill="#ffffff"/>` +
    `<image href="${logoHref}" x="${f(c - logo / 2)}" y="${f(c - logo / 2)}" ` +
    `width="${f(logo)}" height="${f(logo)}" preserveAspectRatio="xMidYMid meet"/>` +
    "</svg>\n"
  );
}

// Indexing helpers: the repo checks indexed access, and a miss here is a porting bug that
// must fail loudly rather than draw a wrong module.
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`qr: index ${index} out of range`);
  return value;
}

type Matrix = Uint8Array[];

function row(matrix: Matrix, index: number): Uint8Array {
  return at(matrix, index < 0 ? matrix.length + index : index);
}

// --- Data analysis (segno encoder.data_to_bytes, find_mode, make_segment) ---

type Mode = 1 | 2 | 4 | 8;
const MODE_NUMERIC: Mode = 1;
const MODE_ALPHANUMERIC: Mode = 2;
const MODE_BYTE: Mode = 4;
const MODE_KANJI: Mode = 8;
const ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/**
 * segno tries ISO-8859-1 first, then Shift JIS, then UTF-8, for the whole string at once.
 * One character outside Latin-1 therefore moves every character to Shift JIS, which is why
 * a Cyrillic or Japanese URL encodes differently from what a UTF-8 only port would give.
 */
function dataToBytes(data: string): Uint8Array {
  return latin1Bytes(data) ?? shiftJisBytes(data) ?? utf8Bytes(data);
}

function latin1Bytes(data: string): Uint8Array | null {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const unit = data.charCodeAt(i);
    if (unit > 0xff) return null;
    out[i] = unit;
  }
  return out;
}

let shiftJisTable: Map<number, number> | null = null;

function shiftJisEncoder(): Map<number, number> {
  if (shiftJisTable !== null) return shiftJisTable;
  const raw = atob(SHIFT_JIS_SLOTS_B64);
  const table = new Map<number, number>();
  // Single byte mappings that differ from ASCII: yen sign, overline, half width katakana.
  table.set(0xa5, 0x5c);
  table.set(0x203e, 0x7e);
  for (let cp = 0xff61; cp <= 0xff9f; cp++) table.set(cp, cp - 0xff61 + 0xa1);
  let slot = 0;
  for (let lead = 0x81; lead <= 0xef; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const cp = raw.charCodeAt(slot * 2) | (raw.charCodeAt(slot * 2 + 1) << 8);
      if (cp !== 0) table.set(cp, (lead << 8) | trail);
      slot++;
    }
  }
  shiftJisTable = table;
  return table;
}

function shiftJisBytes(data: string): Uint8Array | null {
  const table = shiftJisEncoder();
  const out: number[] = [];
  for (const ch of data) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const code = table.get(cp);
    if (code === undefined) return null;
    if (code > 0xff) out.push(code >> 8, code & 0xff);
    else out.push(code);
  }
  return Uint8Array.from(out);
}

function utf8Bytes(data: string): Uint8Array {
  // Python refuses to encode lone surrogates; TextEncoder would silently write U+FFFD.
  for (let i = 0; i < data.length; i++) {
    const unit = data.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = data.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new RangeError("qr: string contains a lone surrogate");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RangeError("qr: string contains a lone surrogate");
    }
  }
  return new TextEncoder().encode(data);
}

function findMode(data: Uint8Array): Mode {
  if (data.length > 0 && data.every((b) => b >= 0x30 && b <= 0x39)) return MODE_NUMERIC;
  if (data.length > 0 && data.every((b) => ALPHANUMERIC_CHARS.includes(String.fromCharCode(b)))) {
    return MODE_ALPHANUMERIC;
  }
  if (isKanji(data)) return MODE_KANJI;
  return MODE_BYTE;
}

function isKanji(data: Uint8Array): boolean {
  if (data.length === 0 || data.length % 2 !== 0) return false;
  for (let i = 0; i < data.length; i += 2) {
    const code = (at(data, i) << 8) | at(data, i + 1);
    if (!((code >= 0x8140 && code <= 0x9ffc) || (code >= 0xe040 && code <= 0xebbf))) return false;
  }
  return true;
}

function appendBits(buff: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) buff.push((value >> i) & 1);
}

interface Segment {
  bits: number[];
  charCount: number;
  mode: Mode;
}

function makeSegment(content: string): Segment {
  const data = dataToBytes(content);
  const mode = findMode(data);
  const bits: number[] = [];
  if (mode === MODE_NUMERIC) {
    for (let i = 0; i < data.length; i += 3) {
      const chunk = data.subarray(i, i + 3);
      appendBits(bits, Number(String.fromCharCode(...chunk)), chunk.length * 3 + 1);
    }
  } else if (mode === MODE_ALPHANUMERIC) {
    const toByte = (b: number): number => ALPHANUMERIC_CHARS.indexOf(String.fromCharCode(b));
    for (let i = 0; i < data.length; i += 2) {
      if (i + 1 < data.length) {
        appendBits(bits, toByte(at(data, i)) * 45 + toByte(at(data, i + 1)), 11);
      } else {
        appendBits(bits, toByte(at(data, i)), 6);
      }
    }
  } else if (mode === MODE_BYTE) {
    for (const b of data) appendBits(bits, b, 8);
  } else {
    for (let i = 0; i < data.length; i += 2) {
      const code = (at(data, i) << 8) | at(data, i + 1);
      const diff = code <= 0x9ffc ? code - 0x8140 : code - 0xc140;
      appendBits(bits, (diff >> 8) * 0xc0 + (diff & 0xff), 13);
    }
  }
  const charCount = mode === MODE_KANJI ? data.length / 2 : data.length;
  return { bits, charCount, mode };
}

// --- Version and codewords (segno encoder.find_version, _encode, make_final_message) ---

function versionRange(version: number): 0 | 1 | 2 {
  if (version < 10) return 0;
  if (version < 27) return 1;
  return 2;
}

function charCountLength(mode: Mode, version: number): number {
  return at(CHAR_COUNT_INDICATOR_LENGTH[mode], versionRange(version));
}

function findVersion(segment: Segment): number {
  for (let version = 1; version <= 40; version++) {
    const needed = 4 + charCountLength(segment.mode, version) + segment.bits.length;
    if (at(SYMBOL_CAPACITY_H, version - 1) >= needed) return version;
  }
  throw new RangeError("qr: data too large, no QR Code can handle the provided data");
}

function encode(content: string): Matrix {
  const segment = makeSegment(content);
  const version = findVersion(segment);
  const buff: number[] = [];
  appendBits(buff, segment.mode, 4);
  appendBits(buff, segment.charCount, charCountLength(segment.mode, version));
  for (const bit of segment.bits) buff.push(bit);
  const capacity = at(SYMBOL_CAPACITY_H, version - 1);
  // Terminator of up to four zero bits.
  for (let i = Math.min(capacity - buff.length, 4); i > 0; i--) buff.push(0);
  // segno pads to the byte boundary with 8 - (len % 8) zeros, so a buffer already on a
  // boundary gains a full zero byte. That byte takes the place of the first 0xEC pad
  // codeword, and the modules differ from other encoders; keeping it is the point.
  for (let i = 8 - (buff.length % 8); i > 0; i--) buff.push(0);
  const padCodewords = [0xec, 0x11];
  const padCount = Math.floor(capacity / 8) - Math.floor(buff.length / 8);
  for (let i = 0; i < padCount; i++) appendBits(buff, at(padCodewords, i % 2), 8);
  const codewords = finalMessage(version, buff);

  const size = version * 4 + 17;
  const matrix = makeMatrix(size);
  addFinderPatterns(matrix);
  addAlignmentPatterns(matrix);
  addCodewords(matrix, codewords);
  const [mask, masked] = bestMask(matrix);
  addFormatInfo(masked, mask);
  addVersionInfo(masked, version);
  return masked;
}

function finalMessage(version: number, buff: number[]): number[] {
  // Bits to bytes, the last byte zero filled. Any bytes past the capacity (the extra zero
  // byte when the data filled the symbol exactly) are never read by the block split.
  const bytes: number[] = [];
  for (let i = 0; i < buff.length; i += 8) {
    let value = 0;
    for (let k = 0; k < 8; k++) value = (value << 1) | (buff[i + k] ?? 0);
    bytes.push(value);
  }
  const dataBlocks: number[][] = [];
  const errorBlocks: number[][] = [];
  let offset = 0;
  for (const [numBlocks, numTotal, numData] of at(ECC_H, version - 1)) {
    const numErrorWords = numTotal - numData;
    const gen = GEN_POLY[numErrorWords];
    if (gen === undefined) throw new RangeError(`qr: no generator for ${numErrorWords}`);
    for (let b = 0; b < numBlocks; b++) {
      const block = bytes.slice(offset, offset + numData);
      offset += numData;
      dataBlocks.push(block);
      const errorBlock = [...block, ...new Array<number>(numErrorWords).fill(0)];
      for (let k = 0; k < block.length; k++) {
        const coef = at(errorBlock, k);
        if (coef !== 0) {
          const lcoef = at(GALOIS_LOG, coef);
          for (let n = 0; n < numErrorWords; n++) {
            errorBlock[k + n + 1] = at(errorBlock, k + n + 1) ^ at(GALOIS_EXP, lcoef + at(gen, n));
          }
        }
      }
      errorBlocks.push(errorBlock.slice(block.length));
    }
  }
  const out: number[] = [];
  for (const blocks of [dataBlocks, errorBlocks]) {
    const longest = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < longest; i++) {
      for (const block of blocks) {
        const value = block[i];
        if (value !== undefined) appendBits(out, value, 8);
      }
    }
  }
  let remainder = 0;
  if (version >= 2 && version <= 6) remainder = 7;
  else if ((version >= 14 && version <= 20) || (version >= 28 && version <= 34)) remainder = 3;
  else if (version >= 21 && version <= 27) remainder = 4;
  for (let i = 0; i < remainder; i++) out.push(0);
  return out;
}

// --- Matrix (segno encoder.make_matrix and the pattern writers) ---

// 0 and 1 are light and dark modules; 2 marks a module not yet written, which is how
// segno tells data modules from function patterns.
function makeMatrix(size: number): Matrix {
  const matrix: Matrix = Array.from({ length: size }, () => new Uint8Array(size).fill(2));
  if (size > 41) {
    for (let i = 0; i < 6; i++) {
      const r = at(matrix, i);
      r[size - 11] = 0;
      r[size - 10] = 0;
      r[size - 9] = 0;
      row(matrix, -11)[i] = 0;
      row(matrix, -10)[i] = 0;
      row(matrix, -9)[i] = 0;
    }
  }
  const rowEight = at(matrix, 8);
  for (let i = 0; i < 9; i++) {
    at(matrix, i)[8] = 0;
    rowEight[i] = 0;
    row(matrix, -i)[8] = 0;
    rowEight[i === 0 ? 0 : size - i] = 0;
  }
  const col = at(matrix, 6);
  let bit = 1;
  for (let i = 8; i < size - 8; i++) {
    at(matrix, i)[6] = bit;
    col[i] = bit;
    bit ^= 1;
  }
  return matrix;
}

const FINDER_PATTERN: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 0, 1, 1, 1, 0, 1, 0],
  [0, 1, 0, 1, 1, 1, 0, 1, 0],
  [0, 1, 0, 1, 1, 1, 0, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
];

function addFinderPatterns(matrix: Matrix): void {
  const corners: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, matrix.length - 8],
    [-8, 0],
  ];
  for (const [i, j] of corners) {
    const offset = i === 0 ? 1 : 0;
    const sepOffset = j !== 0 ? 0 : 1;
    for (let r = 0; r < 8; r++) {
      const target = row(matrix, i + r);
      const source = at(FINDER_PATTERN, offset + r);
      for (let k = 0; k < 8; k++) target[j + k] = at(source, sepOffset + k);
    }
  }
}

function addAlignmentPatterns(matrix: Matrix): void {
  const version = (matrix.length - 17) / 4;
  if (version < 2) return;
  const positions = at(ALIGNMENT_POS, version - 2);
  const minPos = at(positions, 0);
  const maxPos = at(positions, positions.length - 1);
  for (const x of positions) {
    for (const y of positions) {
      if (
        (x === minPos && y === minPos) ||
        (x === minPos && y === maxPos) ||
        (x === maxPos && y === minPos)
      ) {
        continue;
      }
      for (let r = 0; r < 5; r++) {
        const target = at(matrix, x - 2 + r);
        for (let k = 0; k < 5; k++) {
          const edge = r === 0 || r === 4 || k === 0 || k === 4;
          target[y - 2 + k] = edge || (r === 2 && k === 2) ? 1 : 0;
        }
      }
    }
  }
}

function addCodewords(matrix: Matrix, codewords: number[]): void {
  const size = matrix.length;
  let idx = 0;
  for (let start = size - 1; start > 0; start -= 2) {
    const right = start <= 6 ? start - 1 : start;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let z = 0; z < 2; z++) {
        const j = right - z;
        const upwards = ((right & 2) === 0) !== j < 6;
        const r = at(matrix, upwards ? size - 1 - vertical : vertical);
        if (r[j] === 2 && idx < codewords.length) {
          r[j] = at(codewords, idx);
          idx++;
        }
      }
    }
  }
  if (idx !== codewords.length) {
    throw new Error(`qr: added ${idx} of ${codewords.length} codewords`);
  }
}

// --- Masking (segno encoder.find_and_apply_best_mask, mask_scores) ---

const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => ((i + j) & 1) === 0,
  (i) => (i & 1) === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => ((Math.floor(i / 2) + Math.floor(j / 3)) & 1) === 0,
  (i, j) => ((i * j) & 1) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) & 1) + ((i * j) % 3)) & 1) === 0,
  (i, j) => ((((i + j) & 1) + ((i * j) % 3)) & 1) === 0,
];

function bestMask(matrix: Matrix): [number, Matrix] {
  const size = matrix.length;
  const functionMatrix = makeMatrix(size);
  addFinderPatterns(functionMatrix);
  addAlignmentPatterns(functionMatrix);
  row(functionMatrix, -8)[8] = 1;
  let bestScore = Number.MAX_SAFE_INTEGER;
  let bestPattern = 0;
  let best: Matrix = matrix;
  MASKS.forEach((pattern, maskNumber) => {
    const m = matrix.map((r) => r.slice());
    for (let i = 0; i < size; i++) {
      const r = at(m, i);
      const f = at(functionMatrix, i);
      for (let j = 0; j < size; j++) {
        if (at(f, j) > 1 && pattern(i, j)) r[j] = at(r, j) ^ 1;
      }
    }
    const score = maskScore(m);
    if (score < bestScore) {
      bestScore = score;
      bestPattern = maskNumber;
      best = m;
    }
  });
  return [bestPattern, best];
}

const N3_PATTERN = [1, 0, 1, 1, 1, 0, 1];

function findPattern(seq: Uint8Array, start: number): number {
  for (let idx = start; idx + N3_PATTERN.length <= seq.length; idx++) {
    let found = true;
    for (let k = 0; k < N3_PATTERN.length; k++) {
      if (seq[idx + k] !== N3_PATTERN[k]) {
        found = false;
        break;
      }
    }
    if (found) return idx;
  }
  return -1;
}

function anyDark(seq: Uint8Array, from: number, to: number): boolean {
  for (let k = Math.max(from, 0); k < Math.min(to, seq.length); k++) {
    if (seq[k] !== 0) return true;
  }
  return false;
}

// segno's N3 rule: a finder like run counts when it touches either edge or has four light
// modules on at least one side. After a hit it resumes past the run, after a miss at the
// run's centre, which is what makes its scores (and so the chosen mask) its own.
function n3Occurrences(seq: Uint8Array, qrSize: number): number {
  let count = 0;
  let idx = findPattern(seq, 0);
  while (idx !== -1) {
    let offset = idx + 7;
    if (
      idx === 0 ||
      idx === qrSize - 7 ||
      !anyDark(seq, Math.max(idx - 4, 0), Math.min(idx, qrSize)) ||
      !anyDark(seq, Math.max(offset, 0), Math.min(offset + 4, qrSize))
    ) {
      count += 40;
    } else {
      offset = idx + 4;
    }
    idx = findPattern(seq, offset);
  }
  return count;
}

function maskScore(matrix: Matrix): number {
  const qrSize = matrix.length;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let dark = 0;
  let lastRow: Uint8Array | null = null;
  const column = new Uint8Array(qrSize);
  for (let i = 0; i < qrSize; i++) {
    const r = at(matrix, i);
    let rowPrev = -1;
    let colPrev = -1;
    let rowRun = 0;
    let colRun = 0;
    for (let j = 0; j < qrSize; j++) {
      const rowBit = at(r, j);
      const colBit = at(at(matrix, j), i);
      column[j] = colBit;
      dark += rowBit;
      if (rowBit === rowPrev) {
        rowRun++;
      } else {
        if (rowRun >= 5) n1 += rowRun - 2;
        rowRun = 1;
      }
      if (colBit === colPrev) {
        colRun++;
      } else {
        if (colRun >= 5) n1 += colRun - 2;
        colRun = 1;
      }
      if (
        lastRow !== null &&
        j > 0 &&
        rowBit === rowPrev &&
        rowPrev === at(lastRow, j) &&
        at(lastRow, j) === at(lastRow, j - 1)
      ) {
        n2 += 3;
      }
      rowPrev = rowBit;
      colPrev = colBit;
    }
    lastRow = r;
    n3 += n3Occurrences(r, qrSize);
    n3 += n3Occurrences(column, qrSize);
    if (rowRun >= 5) n1 += rowRun - 2;
    if (colRun >= 5) n1 += colRun - 2;
  }
  const percent = dark / qrSize ** 2;
  const n4 = 10 * Math.trunc(Math.abs(percent * 100 - 50) / 5);
  return n1 + n2 + n3 + n4;
}

// --- Format and version information ---

function addFormatInfo(matrix: Matrix, mask: number): void {
  // 0x10 selects error level H in segno's format table index.
  const formatInfo = at(FORMAT_INFO, mask + 0x10);
  const size = matrix.length;
  const rowEight = at(matrix, 8);
  let vOffset = 0;
  let hOffset = 0;
  for (let i = 0; i < 8; i++) {
    const vBit = (formatInfo >> i) & 1;
    const hBit = (formatInfo >> (14 - i)) & 1;
    if (i === 6) {
      vOffset += 1;
      hOffset = 1;
    }
    at(matrix, i + vOffset)[8] = vBit;
    rowEight[i + hOffset] = hBit;
    rowEight[size - 1 - i] = vBit;
    at(matrix, size - 1 - i)[8] = hBit;
  }
  at(matrix, size - 8)[8] = 1;
}

function addVersionInfo(matrix: Matrix, version: number): void {
  if (version < 7) return;
  const info = at(VERSION_INFO, version - 7);
  const size = matrix.length;
  for (let i = 0; i < 6; i++) {
    const bits = [0, 1, 2].map((k) => (info >> (i * 3 + k)) & 1);
    const r = at(matrix, i);
    for (let k = 0; k < 3; k++) {
      at(matrix, size - 11 + k)[i] = at(bits, k);
      r[size - 11 + k] = at(bits, k);
    }
  }
}

// --- SVG (segno writers.write_svg two colour path, utils.matrix_to_lines) ---

/**
 * One path of horizontal strokes, one per run of dark modules, drawn at the module's
 * vertical centre. The first move is absolute ("M1 1.5"), the rest are relative to the end
 * of the previous run ("m-53 1"), exactly as segno writes them.
 */
function svgPath(matrix: Matrix, color: string): string {
  const parts: string[] = [];
  let lastX = 0;
  let lastY = 0;
  const emit = (x1: number, x2: number, y: number): void => {
    const dy = y - lastY;
    parts.push(`${parts.length > 0 ? "m" : "M"}${x1 - lastX} ${dy}h${x2 - x1}`);
    lastX = x2;
    lastY = y;
  };
  // Mirrors matrix_to_lines: last_bit starts dark and only resets after a row that ends
  // dark, which can emit a zero length run; ported as is so the output stays identical.
  let y = BORDER + 0.5 - 1;
  let lastBit = 1;
  for (const r of matrix) {
    let x1 = BORDER;
    let x2 = BORDER;
    y += 1;
    for (const bit of r) {
      if (lastBit !== bit && !bit) {
        emit(x1, x2, y);
        x1 = x2;
      }
      x2 += 1;
      if (!bit) x1 += 1;
      lastBit = bit;
    }
    if (lastBit) {
      emit(x1, x2, y);
      lastBit = 0;
    }
  }
  return `<path stroke="${color}" d="${parts.join("")}"/>`;
}

/**
 * segno's _color_to_webcolor for hex input: lowercase, black and white as "#000" and
 * "#fff", "tan" and "red" when shorter, and #rrggbb folded to #rgb where it can be.
 */
function webColor(hex: string): string {
  let digits = hex.startsWith("#") ? hex.slice(1) : hex;
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) throw new RangeError(`qr: unsupported colour ${hex}`);
  const hx = `#${digits.toLowerCase()}`;
  if (hx === "#000000") return "#000";
  if (hx === "#ffffff") return "#fff";
  if (hx === "#d2b48c") return "tan";
  if (hx === "#ff0000") return "red";
  if (hx[1] === hx[2] && hx[3] === hx[4] && hx[5] === hx[6]) return `#${hx[1]}${hx[3]}${hx[5]}`;
  return hx;
}

// Tables below are dumped from segno 1.6.6 (segno/consts.py), error level H only, since the
// brand code is always H. Regenerate from segno rather than editing by hand.

/** Data capacity in bits per version (index 0 is version 1). */
const SYMBOL_CAPACITY_H: readonly number[] = [
  72, 128, 208, 288, 368, 480, 528, 688, 800, 976, 1120, 1264, 1440, 1576, 1784, 2024, 2264, 2504,
  2728, 3080, 3248, 3536, 3712, 4112, 4304, 4768, 5024, 5288, 5608, 5960, 6344, 6760, 7208, 7688,
  7888, 8432, 8768, 9136, 9776, 10208,
];

/** Character count indicator width per mode, for versions 1-9, 10-26 and 27-40. */
const CHAR_COUNT_INDICATOR_LENGTH: Readonly<Record<Mode, readonly [number, number, number]>> = {
  1: [10, 12, 14],
  2: [9, 11, 13],
  4: [8, 16, 16],
  8: [8, 10, 12],
};

/** Error correction blocks per version as [numBlocks, numTotal, numData]. */
const ECC_H: readonly (readonly (readonly [number, number, number])[])[] = [
  [[1, 26, 9]],
  [[1, 44, 16]],
  [[2, 35, 13]],
  [[4, 25, 9]],
  [
    [2, 33, 11],
    [2, 34, 12],
  ],
  [[4, 43, 15]],
  [
    [4, 39, 13],
    [1, 40, 14],
  ],
  [
    [4, 40, 14],
    [2, 41, 15],
  ],
  [
    [4, 36, 12],
    [4, 37, 13],
  ],
  [
    [6, 43, 15],
    [2, 44, 16],
  ],
  [
    [3, 36, 12],
    [8, 37, 13],
  ],
  [
    [7, 42, 14],
    [4, 43, 15],
  ],
  [
    [12, 33, 11],
    [4, 34, 12],
  ],
  [
    [11, 36, 12],
    [5, 37, 13],
  ],
  [
    [11, 36, 12],
    [7, 37, 13],
  ],
  [
    [3, 45, 15],
    [13, 46, 16],
  ],
  [
    [2, 42, 14],
    [17, 43, 15],
  ],
  [
    [2, 42, 14],
    [19, 43, 15],
  ],
  [
    [9, 39, 13],
    [16, 40, 14],
  ],
  [
    [15, 43, 15],
    [10, 44, 16],
  ],
  [
    [19, 46, 16],
    [6, 47, 17],
  ],
  [[34, 37, 13]],
  [
    [16, 45, 15],
    [14, 46, 16],
  ],
  [
    [30, 46, 16],
    [2, 47, 17],
  ],
  [
    [22, 45, 15],
    [13, 46, 16],
  ],
  [
    [33, 46, 16],
    [4, 47, 17],
  ],
  [
    [12, 45, 15],
    [28, 46, 16],
  ],
  [
    [11, 45, 15],
    [31, 46, 16],
  ],
  [
    [19, 45, 15],
    [26, 46, 16],
  ],
  [
    [23, 45, 15],
    [25, 46, 16],
  ],
  [
    [23, 45, 15],
    [28, 46, 16],
  ],
  [
    [19, 45, 15],
    [35, 46, 16],
  ],
  [
    [11, 45, 15],
    [46, 46, 16],
  ],
  [
    [59, 46, 16],
    [1, 47, 17],
  ],
  [
    [22, 45, 15],
    [41, 46, 16],
  ],
  [
    [2, 45, 15],
    [64, 46, 16],
  ],
  [
    [24, 45, 15],
    [46, 46, 16],
  ],
  [
    [42, 45, 15],
    [32, 46, 16],
  ],
  [
    [10, 45, 15],
    [67, 46, 16],
  ],
  [
    [20, 45, 15],
    [61, 46, 16],
  ],
];

/** Format information words indexed by (error level bits << 3) + mask. */
const FORMAT_INFO: readonly number[] = [
  21522, 20773, 24188, 23371, 17913, 16590, 20375, 19104, 30660, 29427, 32170, 30877, 26159, 25368,
  27713, 26998, 5769, 5054, 7399, 6608, 1890, 597, 3340, 2107, 13663, 12392, 16177, 14854, 9396,
  8579, 11994, 11245,
];

/** Version information words for versions 7 to 40. */
const VERSION_INFO: readonly number[] = [
  31892, 34236, 39577, 42195, 48118, 51042, 55367, 58893, 63784, 68472, 70749, 76311, 79154, 84390,
  87683, 92361, 96236, 102084, 102881, 110507, 110734, 117786, 119615, 126325, 127568, 133589,
  136944, 141498, 145311, 150283, 152622, 158308, 161089, 167017,
];

/** Alignment pattern centre coordinates for versions 2 to 40. */
const ALIGNMENT_POS: readonly (readonly number[])[] = [
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

/** Reed-Solomon generator polynomials (as GF(256) logs) keyed by error codeword count. */
const GEN_POLY: Readonly<Record<number, readonly number[]>> = {
  16: [120, 104, 107, 109, 102, 161, 76, 3, 91, 191, 147, 169, 182, 194, 225, 120],
  17: [43, 139, 206, 78, 43, 239, 123, 206, 214, 147, 24, 99, 150, 39, 243, 163, 136],
  22: [
    210, 171, 247, 242, 93, 230, 14, 109, 221, 53, 200, 74, 8, 172, 98, 80, 219, 134, 160, 105, 165,
    231,
  ],
  24: [
    229, 121, 135, 48, 211, 117, 251, 126, 159, 180, 169, 152, 192, 226, 228, 218, 111, 0, 117, 232,
    87, 96, 227, 21,
  ],
  26: [
    173, 125, 158, 2, 103, 182, 118, 17, 145, 201, 111, 28, 165, 53, 161, 21, 245, 142, 13, 102, 48,
    227, 153, 145, 218, 70,
  ],
  28: [
    168, 223, 200, 104, 224, 234, 108, 180, 110, 190, 195, 147, 205, 27, 232, 201, 21, 43, 245, 87,
    42, 195, 212, 119, 242, 37, 9, 123,
  ],
  30: [
    41, 173, 145, 152, 216, 31, 179, 182, 50, 48, 110, 86, 239, 96, 222, 125, 42, 173, 226, 193,
    224, 130, 156, 37, 251, 216, 238, 40, 192, 180,
  ],
};

const GALOIS_LOG: readonly number[] = [
  0, 0, 1, 25, 2, 50, 26, 198, 3, 223, 51, 238, 27, 104, 199, 75, 4, 100, 224, 14, 52, 141, 239,
  129, 28, 193, 105, 248, 200, 8, 76, 113, 5, 138, 101, 47, 225, 36, 15, 33, 53, 147, 142, 218, 240,
  18, 130, 69, 29, 181, 194, 125, 106, 39, 249, 185, 201, 154, 9, 120, 77, 228, 114, 166, 6, 191,
  139, 98, 102, 221, 48, 253, 226, 152, 37, 179, 16, 145, 34, 136, 54, 208, 148, 206, 143, 150, 219,
  189, 241, 210, 19, 92, 131, 56, 70, 64, 30, 66, 182, 163, 195, 72, 126, 110, 107, 58, 40, 84, 250,
  133, 186, 61, 202, 94, 155, 159, 10, 21, 121, 43, 78, 212, 229, 172, 115, 243, 167, 87, 7, 112,
  192, 247, 140, 128, 99, 13, 103, 74, 222, 237, 49, 197, 254, 24, 227, 165, 153, 119, 38, 184, 180,
  124, 17, 68, 146, 217, 35, 32, 137, 46, 55, 63, 209, 91, 149, 188, 207, 205, 144, 135, 151, 178,
  220, 252, 190, 97, 242, 86, 211, 171, 20, 42, 93, 158, 132, 60, 57, 83, 71, 109, 65, 162, 31, 45,
  67, 216, 183, 123, 164, 118, 196, 23, 73, 236, 127, 12, 111, 246, 108, 161, 59, 82, 41, 157, 85,
  170, 251, 96, 134, 177, 187, 204, 62, 90, 203, 89, 95, 176, 156, 169, 160, 81, 11, 245, 22, 235,
  122, 117, 44, 215, 79, 174, 213, 233, 230, 231, 173, 232, 116, 214, 244, 234, 168, 80, 88, 175,
];

const GALOIS_EXP: readonly number[] = [
  1, 2, 4, 8, 16, 32, 64, 128, 29, 58, 116, 232, 205, 135, 19, 38, 76, 152, 45, 90, 180, 117, 234,
  201, 143, 3, 6, 12, 24, 48, 96, 192, 157, 39, 78, 156, 37, 74, 148, 53, 106, 212, 181, 119, 238,
  193, 159, 35, 70, 140, 5, 10, 20, 40, 80, 160, 93, 186, 105, 210, 185, 111, 222, 161, 95, 190, 97,
  194, 153, 47, 94, 188, 101, 202, 137, 15, 30, 60, 120, 240, 253, 231, 211, 187, 107, 214, 177,
  127, 254, 225, 223, 163, 91, 182, 113, 226, 217, 175, 67, 134, 17, 34, 68, 136, 13, 26, 52, 104,
  208, 189, 103, 206, 129, 31, 62, 124, 248, 237, 199, 147, 59, 118, 236, 197, 151, 51, 102, 204,
  133, 23, 46, 92, 184, 109, 218, 169, 79, 158, 33, 66, 132, 21, 42, 84, 168, 77, 154, 41, 82, 164,
  85, 170, 73, 146, 57, 114, 228, 213, 183, 115, 230, 209, 191, 99, 198, 145, 63, 126, 252, 229,
  215, 179, 123, 246, 241, 255, 227, 219, 171, 75, 150, 49, 98, 196, 149, 55, 110, 220, 165, 87,
  174, 65, 130, 25, 50, 100, 200, 141, 7, 14, 28, 56, 112, 224, 221, 167, 83, 166, 81, 162, 89, 178,
  121, 242, 249, 239, 195, 155, 43, 86, 172, 69, 138, 9, 18, 36, 72, 144, 61, 122, 244, 245, 247,
  243, 251, 235, 203, 139, 11, 22, 44, 88, 176, 125, 250, 233, 207, 131, 27, 54, 108, 216, 173, 71,
  142, 1, 2, 4, 8, 16, 32, 64, 128, 29, 58, 116, 232, 205, 135, 19, 38, 76, 152, 45, 90, 180, 117,
  234, 201, 143, 3, 6, 12, 24, 48, 96, 192, 157, 39, 78, 156, 37, 74, 148, 53, 106, 212, 181, 119,
  238, 193, 159, 35, 70, 140, 5, 10, 20, 40, 80, 160, 93, 186, 105, 210, 185, 111, 222, 161, 95,
  190, 97, 194, 153, 47, 94, 188, 101, 202, 137, 15, 30, 60, 120, 240, 253, 231, 211, 187, 107, 214,
  177, 127, 254, 225, 223, 163, 91, 182, 113, 226, 217, 175, 67, 134, 17, 34, 68, 136, 13, 26, 52,
  104, 208, 189, 103, 206, 129, 31, 62, 124, 248, 237, 199, 147, 59, 118, 236, 197, 151, 51, 102,
  204, 133, 23, 46, 92, 184, 109, 218, 169, 79, 158, 33, 66, 132, 21, 42, 84, 168, 77, 154, 41, 82,
  164, 85, 170, 73, 146, 57, 114, 228, 213, 183, 115, 230, 209, 191, 99, 198, 145, 63, 126, 252,
  229, 215, 179, 123, 246, 241, 255, 227, 219, 171, 75, 150, 49, 98, 196, 149, 55, 110, 220, 165,
  87, 174, 65, 130, 25, 50, 100, 200, 141, 7, 14, 28, 56, 112, 224, 221, 167, 83, 166, 81, 162, 89,
  178, 121, 242, 249, 239, 195, 155, 43, 86, 172, 69, 138, 9, 18, 36, 72, 144, 61, 122, 244, 245,
  247, 243, 251, 235, 203, 139, 11, 22, 44, 88, 176, 125, 250, 233, 207, 131, 27, 54, 108, 216, 173,
  71, 142,
];

// Python's shift_jis codec (JIS X 0208) as little endian uint16 code points, one per
// double byte slot: lead bytes 0x81-0x9F then 0xE0-0xEF, trail bytes 0x40-0xFC without
// 0x7F, 0 where the slot is unmapped. WHATWG TextDecoder("shift_jis") is not a substitute:
// it is Windows-31J, which adds about 2300 characters and maps six differently.
const SHIFT_JIS_SLOTS_B64 =
  "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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnE4WVQNaP5bAVBthKGP2WSKQdYQcg1B6qmDhYyVu7WVmhKaC9ZuTaCdXoWVxYptb0Fl7hvSYYn2+fY6bFmKffLeIiVu1Xgljl2ZIaMeVjZdPZ+VOCk9NT51PSVDyVjdZ1FkBWglc32APYXBhE2YFabpwT3Vwdft5rX3vfcOADoRjiAKLVZB6kDtTlU6lTt9XsoDBkO94AE7xWKJuOJAyeiiDi4IvnEFRcFO9VOFU4Fb7WRVf8pjrbeSALYVilnCWoJb7lwtU81OHW89wvX/Cj+iWb1Ncnbp6EU6TePyBJm4YVgRVHWsahTuc5VmpU2Zt3HSPlUJWkU5LkPKWT4MMmeFTtlUwW3FfIGbzZgRoOGzzbCltW3TIdk56NJjxgluIYIrtkrJtq3XKdsWZpmABi4qNspWOaa1ThlESVzBYRFm0W/ZeKGCpY/Rjv2wUb45wFHFZcdVxP3MBfnaC0YKXhWCQW5IbnWlYvGVabCV1+VEuWWVZgF/cX7xi+mUqaidrtGuLc8F/VoksnQ6dxJ6hXJZse4MEUUtctmHGgXZoYXJZTvpPeFNpYCluT3rzlwtOFlPuTlVPPU+hT3NPoFLvUwlWD1nBWrZb4VvReYdmnGe2Z0xrs2xrcMJzjXm+eTx6h3uxgtuCBIN3g++D04Nmh7KKKVaojOaPTpAel4qGxE/oXBFiWXI7deWBvYL+hsCMxZYTmdWZy04aT+OJ3lZKWMpY+17rXypglGBiYNBhEmLQYjllQZtmZrBod21wcEx1hnZ1faWC+YeLlY6WnYzxUb5SFlmzVLNbFl1oYYJpr22NeMuEV4hyiqeTuJpsbaiZ2YajV/9nzoYOkoNSh1YEVNNe4WK5ZDxoOGi7a3JzunhrepqJ0olrjQOP7ZCjlZSWaZdmW7NcfWlNmE6Ym2Mgeytqf2q2aA2cX29yUp1VcGDsYjttB27RbluEEIlEjxROOZz2UxtpOmqElypoXFHDerKE3JGMk1tWKJ0iaAWDMYSlfAhSxYLmdH5Og0+gUdJbClLYUudS+12aVSpY5lmMW5hb21tyXnleo2AfYWNhvmHbY2Jl0WdTaPpoPmtTa1dsIm+Xb0VvsHQYdeN2C3f/eqF7IXzpfTZ/8H+dgGaCnoOzicyKq4yEkFGUk5WRlaKVZZbTlyiZGII4TitUuFzMXalzTHY8d6lc638LjcGWEZhUmFiYAU8OT3FTnFVoVvpXR1kJW8RbkFwMXn5ezF/uYzpn12XiZR9ny2jEaF9qMF7FaxdsfWx/dUh5Y1sAegB9vV+PiRiKtIx3jcyOHY/imA6aPJuATn1QAFGTWZxbL2KAYuxkOmugcpF1R3mpf/uHvIpwi6xjyoOglwlUA1SrVVRoWGpwiid4dWfNnnRTolsagVCGBpAYTkVOx04RT8pTOFSuWxNfJWBRZT1nQmxybONseHADdHZ6rnoIexp9/nxmfedlW3K7U0Vc6F3SYuBiGWMgblqGMYrdjfiSAW+meVqbqE6rTqxOm0+gT9FQR1H2enFR9lFUUyFTf1PrU6xVg1jhXDdfSl8vYFBgbWAfY1llS2rBbMJy7XLvd/iABYEIgk6F95Dhk/+XV5lamvBO3VEtXIFmbWlAXPJmdWmJc1BogXzFUORSR1f+XSaTpGUjaz1rNHSBeb15S3vKfbmCzIN/iF+JOYvRj9GRH1SAkl1ONlDlUzpT13KWc+l35oKvjsaZyJnSmXdRGmFehrBVenp2UNNbR5CFljJO22rnkVFcSFyYY596k2x0l2GPqnqKcYiWgnwXaHB+UWhsk/JSG1SrhROKpH/NjuGQZlOIiEF5wk++UBFSRFFTVS1X6nOLV1FZYl+EX3VgdmFnYalhsmM6ZGxlb2ZCaBNuZnU9evt8TH2ZfUt+a38Og0qDzYYIimOKZov9jhqYj524gs6P6JuHUh9ig2TAb5mWQWiRUCBremxUb3R6UH1AiCOKCGf2TjlQJlBlUHxROFJjUqdVD1cFWMxa+l6yYfhh82JyYxxpKWp9cqxyLnMUeG94eX0Md6mAi4kZi+KM0o5jkHWTepZVmBOaeJ5DUZ9Ts1N7XiZfG26QboRz/nNDfTeCAIr6ilCWTk4LUORTfFT6VtFZZFvxXateJ184YkVlr2dWbtByyny0iKGA4YDwg06Gh4rojTeSx5ZnmBOflE6STg1PSFNJVD5UL1qMX6Ffn2CnaI5qWnSBeJ6KpIp3i5CRXk7Jm6ROfE+vTxlQFlBJUWxRn1K5Uv5SmlPjUxFUDlSJVVFXold9WVRbXVuPW+Vd5133XXheg16aXrdeGF9SYExhl2LYYqdjO2UCZkNm9GZtZyFol2jLaV9sKm1pbS9unW4ydYd2bHg/euB8BX0YfV59sX0VgAOAr4CxgFSBj4EqglKDTIhhiBuLooz8jMqQdZFxkj94/JKklU2WBZiZmdiaO51bUqtS91MIVNVY92Lgb2qMX4+5nktRO1JKVP1WQHp3kWCd0p5EcwlvcIERdf1f2mComttyvI9kawOYyk7wVmRXvlhaWmhgx2EPZgZmOWixaPdt1XU6fW6CQpubTlBPyVMGVW9d5l3uXftnmWxzdAJ4UIqWk9+IUFenXitjtVCsUI1RAGfJVF5Yu1mwW2lfTWKhYz1oc2sIbn1wx5GAchV4JnhteY5lMH3cg8GICY+blmRSKFdQZ2p/oYy0UUJXKpY6WIpptICyVA5d/FeVePqdXE9KUotUPmQoZhRn9WeEelZ7In0vk1xorZs5exlTilE3Ut9b9mKuZOZkLWe6a6mF0ZaQdtabTGMGk6ubv3ZSZglOmFDCU3Fc6GCSZGNlX2jmccpzI3WXe4J+lYaDi9uMeJEQmaxlq2aLa9VO1E46T39POlL4U/JT41XbVutYy1nJWf9ZUFtNXAJeK17XXx1gB2MvZVxbr2W9ZehlnWdia3trD2xFc0l5wXn4fBl9K32igAKB84GWiV6KaYpmioyK7orHjNyMzJb8mG9ri048T41PUFFXW/pbSGEBY0JmIWvLbrtsPnK9dNR1wXg6eQyAM4DqgZSEno9QbH+eD19Yiyud+nr4jo1b65YDTvFT91cxWclapFuJYH9uBm++deqMn1sAheB7clD0Z52CYVxKhR5+DoKZUQRcaGNmjZxlbnE+eRd9BYAdi8qObpDHhqqQH1D6UjpcU2d8cDVyTJHIkSuT5YLCWzFf+WA7TtZTiFtLYjFnimvpcuBzLnprgaONUpGWmRJR11NqVP9biGM5aqx9AJfaVs5TaFSXWzFc3l3uTwFh/mIybcB5y3lCfU1+0n/tgR+CkIRGiHKJkIt0ji+PMZBLkWyRxpackcBOT09FUUFTk18OYtRnQWwLbmNzJn7NkYOS1FMZWb9b0W1deS5+m3x+WJ9x+lFTiPCPyk/7XCVmrHfjehyC/5nGUapf7GVvaYlr822WbmRv/nYUfeFddZCHkQaY5lEdUkBikWbZZhputl7SfXJ/+GavhfeF+IqpUtlTc1mPXpBfVWDkkmSWt1AfUd1SIFNHU+xT6FRGVTFVF1ZoWb5ZPFq1WwZcD1wRXBpchF6KXuBecF9/YoRi22KMY3djB2YMZi1mdmZ+Z6JoH2o1arxsiG0JblhuPHEmcWdxx3UBd114AXllefB54HoRe6d8OX2WgNaDi4RJhV2I84gfijyKVIpzimGM3oykkWaSfpMYlJyWmJcKTghOHk5XTpdRcFLOVzRYzFgiWzhexWD+ZGFnVmdEbbZyc3VjeriEcou4kSCTMVb0V/6Y7WINaZZr7XFUfneAcoLmid+YVYexjztcOE/hT7VPB1UgWt1b6VvDX05hL2OwZUtm7mibaXht8W0zdbl1H3deeeZ5M33jga+CqoWqiTqKq46bjzKQ3ZEHl7pOwU4DUnVY7FgLXBp1PVxOgQqKxY9jlm2XJXvPigiYYpHzVqhTF5A5VIJXJV6oYzRsinBhd4t84H9wiEKQVJEQkxiTj5ZedMSaB11pXXBlomeojduWbmNJZxlpxYMXmMCW/oiEb3pk+FsWTixwXXUvZsRRNlLiUtNZgV8nYBBiP2V0ZR9mdGbyaBZoY2sFbnJyH3Xbdr58VoDwWP2If4mgipOKy4odkJKRUpdZl4llDnoGgbuWLV7cYBpipWUUZpBn83dNek18Pn4KgayMZI3hjV+OqXgHUtlipWNCZJhiLYqDesB7rIrqlnZ9DIJJh9lOSFFDU2BTo1sCXBZc3V0mYkdisGQTaDRoyWxFbRdt02dcb05xfXHLZX96rXvafUp+qH96gRuCOYKmhW6Kzoz1jXiQd5CtkpGSg5Wum01ShFU4bzZxaFGFeVV+s4HOfExWUVioXKpj/mb9Zlpp2XKPdY51DnlWed95l3wgfUR9B4Y0ijuWYZAgn+dQdVLMU+JTCVCqVe5YT1k9cotbZFwdU+Ng82BcY4NjP2O7Y81k6WX5ZuNdzWn9aRVv5XGJTul1+HaTet98z32cfWGASYNYg2yEvIT7hcWIcI0BkG2Ql5MclxKaz1CXWI5h04E1hQiNIJDDT3RQR1JzU29gSWNfZyxus40fkNdPXlzKjM9lmn1SU5aIdlHDY1hba1sKXA1kUWdckNZOGlkqWXBsUYo+VRVYpVnwYFNiwWc1glVpQJbEmSiaU08GWP5bEICxXC9ehV8gYEthNGL/ZvBs3m7OgH+B1IKLiLiMAJAukIqW257bm+NO8FMnWSx7jZFMmPmd3W4ncFNTRFWFW1hinmLTYqJs728idBeKOJTBb/6KOIPnUfiG6lPpU0ZPVJCwj2pZMYH9Xep6v4/aaDeM+HJInD1qsIo5TlhTBlZmV8ViomPmZU5r4W1bbq1w7Xfveqp7u309gMaAy4aViluT41bHWD5frWWWZoBqtWs3dceKJFDldzBXG19lYHpmYGz0dRp6bn/0gRiHRZCzmcl7XHX5elF7xIQQkOl5kno2g+FaQHctTvJOmVvgX71iPGbxZ+hsa4Z3iDuKTpHzktCZF2omcCpz54JXhK+MAU5GUctRi1X1WxZeM16BXhRfNV9rX7Rf8mERY6JmHWdub1JyOnU6d3SAOYF4gXaHv4rcioWN842akneVApjlnMVSV2P0dhVniGzNc8OMrpNzliVtnFgOacxp/Y+ak9t1GpBaWAJotGP7aUNPLG/YZ7uPJoW0fVSTP2lwb2pX91gsWyx9KnIKVOORtJ2tTk5PXFB1UENSnoxIVCRYmlsdXpVerV73Xh9fjGC1Yjpj0GOvaEBsh3iOeQt64H1HggKK5opEjhOQuJAtkdiRDp/lbFhk4mR1ZfRuhHYbe2mQ0ZO6bvJUuV+kZE2P7Y9EknhRa1gpWVVcl177bY9+HHW8jOKOW5i5cB1Pv2uxbzB1+5ZOURBUNVhXWKxZYFySX5dlXGchbnt234PtjBSQ/ZBNkyV4OniqUqZeH1d0WRJgElBaUaxRzVEAUhBVVFhYWFdZlVv2XItdvGCVYi1kcWdDaLxo32jXdthtb26bbW9wyHFTX9h1d3lJe1R7UnvWfHF9MFJjhGmF5IUOigSLRowPjgOQD5AZlHaWLZgwmtiVzVDVUgxUAlgOXKdhnmQebbN35Xr0gASEU5CFkuBcB50/U5dfs1+cbXlyY3e/eeR70mvscq2KA2hhavhRgXo0aUpc9pzrgsVbSZEecHhWb1zHYGZljGxajEGQE5hRVMdmDZJIWaOQhVFNTupRmYUOi1hwemNLk2JptJkEfnd1V1Ngad+O45ZdbIxOPFwQX+mPAlPRjImAeYb/XuVlc05lUYJZP1zul/tOilnNX42K4W+weWJ551txhCtzsXF0XvVfe2OaZMNxmHxDTvxeS07cV6JWqWDDbw19/YAzgb+Bso+XiaSG9F2KYq1kh4l3Z+JsPm02dDR4Rlp1f62CrJnzT8Ne3WKSY1dlb2fDdkxyzIC6gCmPTZENUPlXklqFaHNpZHH9creM8ljgjGqWGZB/h+R553cphC9PZVJaU81iz2fKbH12lHuVfDaChIXrj91mIG8Gcht+q4PBmaae/VGxe3J4uHuHgEh76GphXoyAUXVgdWtRYpKMbnp2l5HqmhBPcH+cYk97pZXpnHpWWVjkhryWNE8kUkpTzVPbUwZeLGSRZX9nPmxObEhyr3Ltc1R1QX4sgumFqYzEe8aRaXESmO+YPWNpZmp15HbQeEOF7oYqU1FTJlSDWYdefF+yYElieWKrYpBl1GvMbLJ1rnaReNh5y313f6WAq4i5iruMf5Bel9uYC2o4fJlQPlyuX4dn2Gs1dAl3jn87n8pnF3o5U4t17ZpmX52B8YOYgDxfxV9idUZ7PJBnaOtZm1oQfX52LIv1T2pfGWo3bAJv4nRoeWiIVYp5jN9ez2PFddJ514Iok/KSnITthi2cwVRsX4xlXG0VcKeM04w7mE9l9nQNTthO4FcrWWZazFuoUQNenF4WYHZid2WnZW5mbm02ciZ7UIGagZmCXIugjOaMdI0clkSWrk+rZGZrHoJhhGqF6JABXFNpqJh6hFeFD09vUqlfRV4NZ495eYEHiYaJ9W0XX1ViuGzPTmlykpsGUjtUdFazWKRhbmIacW5ZiXzefBt98JaHZV6AGU51T3VRQFhjXnNeCl/EZyZOPYWJlVuWc3wBmPtQwVhWdqd4JVKldxGFhntPUAlZR3LHe+h9uo/Uj02Qv0/JUilaAV+tl91PF4LqkgNXVWNpayt13IgUj0J631KTWFVhCmKuZs1rP3zpgyNQ+E8FU0ZUMVhJWZ1b8FzvXCldll6xYmdjPmW5ZQtn1WzhbPlwMngrft6As4IMhOyEAocSiSqKSoymkNKS/ZjznGydT06hTo1QVlJKV6hZPV7YX9lfP2K0Zhtn0GfSaJJRIX2qgKiBAIuMjL+MfpIyliBULJgXU9VQXFOoWLJkNGdncmZ3RnrmkcNSoWyGawBYTF5UWSxn+3/hUcZ2aWToeFSbu57LV7lZJ2aaZ85r6VTZaVVenIGVZ6qb/mdSnF1opk7jT8hTuWIrZ6tsxI+tT21+v54HTmJhgG4rbxOFc1QqZ0Wb812Ve6xcxlsch0pu0YQUegiBmVmNfBFsIHfZUiJZIXFfctt3J5dhnQtpf1oYWqVRDVR9VA5m33b3j5iS9JzqWV1yxW5NUclov33sfWKXup54ZCFqAoOEWV9b22sbc/J2sn0XgJmEMlEoZ9me7nZiZ/9SBZkkXDtifnywjE9VtmALfYCVAVNfTrZRHFk6cjaAzpElX+J3hFN5XwR9rIUzio2OVpfzZ66FU5QJYQhhuWxSdu2KOI8vVVFPKlHHUstTpVt9XqBggmHWYwln2mdnboxtNnM3czF1UHnViJiKSpCRkPWQxJaNhxVZiE5ZTw5OiYo/jxCYrVB8XpZZuVu4Xtpj+mPBZNxmSmnYaQtttm6UcSh1r3qKfwCASYTJhIGJIYsKjmWQfZYKmX5hkWIya4NsdG3Mf/x/wG2Ff7qH+IhlZ7GDPJj3lhttYX09hGqRcU51U1BdBGvrb82FLYaniSlSD1RlXE5nqGgGdIN04nXPiOGIzJHilniWi1+Hc8t6ToSgY2V1iVJBbZxuCXRZdWt4knyGltx6jZ+2T25hxWVchoZOrk7aUCFOzFHuW5llgWi8bR9zQnatdxx653xvgtKKfJDPkXWWGJibUtF9K1CYU5dny23QcTN06IEqj6OWV5yfnmB0QViZbS99XpjkTjZPi0+3UbFSul0cYLJzPHnTgjSSt5b2lgqXl55in6ZmdGsXUqNSyHDCiMleS2CQYSNvSXE+fPR9b4DuhCOQLJNCVG+b02qJcMKM740yl7RSQVrKXgRfF2d8aZRpam0Pb2Jy/HLtewGAfoBLh86QbVGTnoR5i4Ayk9aKLVCMVHGKamvEjAeB0WCgZ/KdmU6YThCca4rBhWiFAGl+bpd4VYEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxfEE4VTipOMU42TjxOP05CTlZOWE6CToVOa4yKThKCDV+OTp5On06gTqJOsE6zTrZOzk7NTsROxk7CTtdO3k7tTt9O904JT1pPME9bT11PV09HT3ZPiE+PT5hPe09pT3BPkU9vT4ZPlk8YUdRP30/OT9hP20/RT9pP0E/kT+VPGlAoUBRQKlAlUAVQHE/2TyFQKVAsUP5P708RUAZQQ1BHUANnVVBQUEhQWlBWUGxQeFCAUJpQhVC0ULJQyVDKULNQwlDWUN5Q5VDtUONQ7lD5UPVQCVEBUQJRFlEVURRRGlEhUTpRN1E8UTtRP1FAUVJRTFFUUWJR+HppUWpRblGAUYJR2FaMUYlRj1GRUZNRlVGWUaRRplGiUalRqlGrUbNRsVGyUbBRtVG9UcVRyVHbUeBRVYbpUe1R8FH1Uf5RBFILUhRSDlInUipSLlIzUjlST1JEUktSTFJeUlRSalJ0UmlSc1J/Un1SjVKUUpJScVKIUpFSqI+nj6xSrVK8UrVSwVLNUtdS3lLjUuZS7ZjgUvNS9VL4UvlSBlMIUzh1DVMQUw9TFVMaUyNTL1MxUzNTOFNAU0ZTRVMXTklTTVPWUV5TaVNuUxhZe1N3U4JTllOgU6ZTpVOuU7BTtlPDUxJ82ZbfU/xm7nHuU+hT7VP6UwFUPVRAVCxULVQ8VC5UNlQpVB1UTlSPVHVUjlRfVHFUd1RwVJJUe1SAVHZUhFSQVIZUx1SiVLhUpVSsVMRUyFSoVKtUwlSkVL5UvFTYVOVU5lQPVRRV/VTuVO1U+lTiVDlVQFVjVUxVLlVcVUVVVlVXVThVM1VdVZlVgFWvVIpVn1V7VX5VmFWeVa5VfFWDValVh1WoVdpVxVXfVcRV3FXkVdRVFFb3VRZW/lX9VRtW+VVOVlBW33E0VjZWMlY4VmtWZFYvVmxWalaGVoBWilagVpRWj1alVq5Wtla0VsJWvFbBVsNWwFbIVs5W0VbTVtdW7lb5VgBX/1YEVwlXCFcLVw1XE1cYVxZXx1UcVyZXN1c4V05XO1dAV09XaVfAV4hXYVd/V4lXk1egV7NXpFeqV7BXw1fGV9RX0lfTVwpY1lfjVwtYGVgdWHJYIVhiWEtYcFjAa1JYPVh5WIVYuVifWKtYuljeWLtYuFiuWMVY01jRWNdY2VjYWOVY3FjkWN9Y71j6WPlY+1j8WP1YAlkKWRBZG1mmaCVZLFktWTJZOFk+WdJ6VVlQWU5ZWllYWWJZYFlnWWxZaVl4WYFZnVleT6tPo1myWcZZ6FncWY1Z2VnaWSVaH1oRWhxaCVoaWkBabFpJWjVaNlpiWmpamlq8Wr5ay1rCWr1a41rXWuZa6VrWWvpa+1oMWwtbFlsyW9BaKls2Wz5bQ1tFW0BbUVtVW1pbW1tlW2lbcFtzW3VbeFuIZXpbgFuDW6ZbuFvDW8dbyVvUW9Bb5FvmW+Jb3lvlW+tb8Fv2W/NbBVwHXAhcDVwTXCBcIlwoXDhcOVxBXEZcTlxTXFBcT1xxW2xcblxiTnZceVyMXJFclFybWatcu1y2XLxct1zFXL5cx1zZXOlc/Vz6XO1cjF3qXAtdFV0XXVxdH10bXRFdFF0iXRpdGV0YXUxdUl1OXUtdbF1zXXZdh12EXYJdol2dXaxdrl29XZBdt128XcldzV3TXdJd1l3bXetd8l31XQteGl4ZXhFeG142XjdeRF5DXkBeTl5XXlReX15iXmReR151XnZeel68nn9eoF7BXsJeyF7QXs9e1l7jXt1e2l7bXuJe4V7oXule7F7xXvNe8F70Xvhe/l4DXwlfXV9cXwtfEV8WXylfLV84X0FfSF9MX05fL19RX1ZfV19ZX2FfbV9zX3dfg1+CX39fil+IX5Ffh1+eX5lfmF+gX6hfrV+8X9Zf+1/kX/hf8V/dX7Ng/18hYGBgGWAQYClgDmAxYBtgFWArYCZgD2A6YFpgQWBqYHdgX2BKYEZgTWBjYENgZGBCYGxga2BZYIFgjWDnYINgmmCEYJtglmCXYJJgp2CLYOFguGDgYNNgtGDwX71gxmC1YNhgTWEVYQZh9mD3YABh9GD6YANhIWH7YPFgDWEOYUdhPmEoYSdhSmE/YTxhLGE0YT1hQmFEYXNhd2FYYVlhWmFrYXRhb2FlYXFhX2FdYVNhdWGZYZZhh2GsYZRhmmGKYZFhq2GuYcxhymHJYfdhyGHDYcZhumHLYXl/zWHmYeNh9mH6YfRh/2H9Yfxh/mEAYghiCWINYgxiFGIbYh5iIWIqYi5iMGIyYjNiQWJOYl5iY2JbYmBiaGJ8YoJiiWJ+YpJik2KWYtRig2KUYtdi0WK7Ys9i/2LGYtRkyGLcYsxiymLCYsdim2LJYgxj7mLxYidjAmMIY+9i9WJQYz5jTWMcZE9jlmOOY4Bjq2N2Y6Njj2OJY59jtWNrY2ljvmPpY8BjxmPjY8lj0mP2Y8RjFmQ0ZAZkE2QmZDZkHWUXZChkD2RnZG9kdmROZCpllWSTZKVkqWSIZLxk2mTSZMVkx2S7ZNhkwmTxZOdkCYLgZOFkrGLjZO9kLGX2ZPRk8mT6ZABl/WQYZRxlBWUkZSNlK2U0ZTVlN2U2ZThlS3VIZVZlVWVNZVhlXmVdZXJleGWCZYNlioubZZ9lq2W3ZcNlxmXBZcRlzGXSZdtl2WXgZeFl8WVyZwpmA2b7ZXNnNWY2ZjRmHGZPZkRmSWZBZl5mXWZkZmdmaGZfZmJmcGaDZohmjmaJZoRmmGadZsFmuWbJZr5mvGbEZrhm1mbaZuBmP2bmZulm8Gb1ZvdmD2cWZx5nJmcnZziXLmc/ZzZnQWc4ZzdnRmdeZ2BnWWdjZ2RniWdwZ6lnfGdqZ4xni2emZ6FnhWe3Z+9ntGfsZ7Nn6We4Z+Rn3mfdZ+Jn7me5Z85nxmfnZ5xqHmhGaCloQGhNaDJoTmizaCtoWWhjaHdof2ifaI9orWiUaJ1om2iDaK5quWh0aLVooGi6aA9pjWh+aAFpymgIadhoImkmaeFoDGnNaNRo52jVaDZpEmkEaddo42glaflo4GjvaChpKmkaaSNpIWnGaHlpd2lcaXhpa2lUaX5pbmk5aXRpPWlZaTBpYWleaV1pgWlqabJprmnQab9pwWnTab5pzmnoW8pp3Wm7acNpp2kuapFpoGmcaZVptGneaehpAmobav9pCmv5afJp52kFarFpHmrtaRRq62kKahJqwWojahNqRGoManJqNmp4akdqYmpZamZqSGo4aiJqkGqNaqBqhGqiaqNql2oXhrtqw2rCarhqs2qsat5q0Wrfaqpq2mrqavtqBWsWhvpqEmsWazGbH2s4azdr3HY5a+6YR2tDa0lrUGtZa1RrW2tfa2FreGt5a39rgGuEa4NrjWuYa5Vrnmuka6prq2uva7JrsWuza7drvGvGa8tr02vfa+xr62vza+9rvp4IbBNsFGwbbCRsI2xebFVsYmxqbIJsjWyabIFsm2x+bGhsc2ySbJBsxGzxbNNsvWzXbMVs3WyubLFsvmy6bNts72zZbOpsH21NiDZtK209bThtGW01bTNtEm0MbWNtk21kbVpteW1ZbY5tlW3kb4Vt+W0VbgputW3HbeZtuG3Gbext3m3Mbeht0m3Fbfpt2W3kbdVt6m3ubS1ubm4ubhlucm5fbj5uI25rbitudm5Nbh9uQ246bk5uJG7/bh1uOG6CbqpumG7Jbrdu0269bq9uxG6ybtRu1W6PbqVuwm6fbkFvEW9McOxu+G7+bj9v8m4xb+9uMm/Mbj5vE2/3boZvem94b4FvgG9vb1tv829tb4JvfG9Yb45vkW/Cb2Zvs2+jb6FvpG+5b8Zvqm/fb9Vv7G/Ub9hv8W/ub9tvCXALcPpvEXABcA9w/m8bcBpwdG8dcBhwH3AwcD5wMnBRcGNwmXCScK9w8XCscLhws3CucN9wy3DdcNlwCXH9cBxxGXFlcVVxiHFmcWJxTHFWcWxxj3H7cYRxlXGocaxx13G5cb5x0nHJcdRxznHgcexx53H1cfxx+XH/cQ1yEHIbcihyLXIscjByMnI7cjxyP3JAckZyS3JYcnRyfnKCcoFyh3KScpZyonKncrlysnLDcsZyxHLOctJy4nLgcuFy+XL3cg9QF3MKcxxzFnMdczRzL3MpcyVzPnNOc09z2J5Xc2pzaHNwc3hzdXN7c3pzyHOzc85zu3PAc+Vz7nPec6J0BXRvdCV0+HMydDp0VXQ/dF90WXRBdFx0aXRwdGN0anR2dH50i3SedKd0ynTPdNR08XPgdON053TpdO508nTwdPF0+HT3dAR1A3UFdQx1DnUNdRV1E3UedSZ1LHU8dUR1TXVKdUl1W3VGdVp1aXVkdWd1a3VtdXh1dnWGdYd1dHWKdYl1gnWUdZp1nXWldaN1wnWzdcN1tXW9dbh1vHWxdc11ynXSddl143Xedf51/3X8dQF28HX6dfJ183ULdg12CXYfdid2IHYhdiJ2JHY0djB2O3ZHdkh2RnZcdlh2YXZidmh2aXZqdmd2bHZwdnJ2dnZ4dnx2gHaDdoh2i3aOdpZ2k3aZdpp2sHa0drh2uXa6dsJ2zXbWdtJ23nbhduV253bqdi+G+3YIdwd3BHcpdyR3HncldyZ3G3c3dzh3R3dad2h3a3dbd2V3f3d+d3l3jneLd5F3oHeed7B3tne5d793vHe9d7t3x3fNd9d32nfcd+N37nf8dwx4EngmeSB4KnlFeI54dHiGeHx4mniMeKN4tXiqeK940XjGeMt41Hi+eLx4xXjKeOx453jaeP149HgHeRJ5EXkZeSx5K3lAeWB5V3lfeVp5VXlTeXp5f3mKeZ15p3lLn6p5rnmzebl5unnJedV553nseeF543kIeg16GHoZeiB6H3qAeTF6O3o+ejd6Q3pXekl6YXpieml6nZ9wenl6fXqIepd6lXqYepZ6qXrIerB6tnrFesR6v3qDkMd6ynrNes961XrTetl62nrdeuF64nrmeu168HoCew97CnsGezN7GHsZex57NXsoezZ7UHt6ewR7TXsLe0x7RXt1e2V7dHtne3B7cXtse257nXuYe597jXuce5p7i3uSe497XXuZe8t7wXvMe897tHvGe9176XsRfBR85nvle2B8AHwHfBN883v3exd8DXz2eyN8J3wqfB98N3wrfD18THxDfFR8T3xAfFB8WHxffGR8VnxlfGx8dXyDfJB8pHytfKJ8q3yhfKh8s3yyfLF8rny5fL18wHzFfMJ82HzSfNx84nw7m+988nz0fPZ8+nwGfQJ9HH0VfQp9RX1LfS59Mn0/fTV9Rn1zfVZ9Tn1yfWh9bn1PfWN9k32JfVt9j319fZt9un2ufaN9tX3Hfb19q309fqJ9r33cfbh9n32wfdh93X3kfd59+33yfeF9BX4KfiN+IX4SfjF+H34Jfgt+In5GfmZ+O341fjl+Q343fjJ+On5nfl1+Vn5efll+Wn55fmp+aX58fnt+g37VfX1+ro9/foh+iX6MfpJ+kH6TfpR+ln6Ofpt+nH44fzp/RX9Mf01/Tn9Qf1F/VX9Uf1h/X39gf2h/aX9nf3h/gn+Gf4N/iH+Hf4x/lH+ef51/mn+jf69/sn+5f65/tn+4f3GLxX/Gf8p/1X/Uf+F/5n/pf/N/+X/cmAaABIALgBKAGIAZgByAIYAogD+AO4BKgEaAUoBYgFqAX4BigGiAc4BygHCAdoB5gH2Af4CEgIaAhYCbgJOAmoCtgJBRrIDbgOWA2YDdgMSA2oDWgAmB74DxgBuBKYEjgS+BS4GLlkaBPoFTgVGB/IBxgW6BZYFmgXSBg4GIgYqBgIGCgaCBlYGkgaOBX4GTgamBsIG1gb6BuIG9gcCBwoG6gcmBzYHRgdmB2IHIgdqB34HggeeB+oH7gf6BAYICggWCB4IKgg2CEIIWgimCK4I4gjOCQIJZgliCXYJagl+CZIJigmiCaoJrgi6CcYJ3gniCfoKNgpKCq4KfgruCrILhguOC34LSgvSC84L6gpODA4P7gvmC3oIGg9yCCYPZgjWDNIMWgzKDMYNAgzmDUINFgy+DK4MXgxiDhYOag6qDn4Oig5aDI4OOg4eDioN8g7WDc4N1g6CDiYOog/SDE4Trg86D/YMDhNiDC4TBg/eDB4Tgg/KDDYQihCCEvYM4hAaF+4NthCqEPIRahYSEd4RrhK2EboSChGmERoQshG+EeYQ1hMqEYoS5hL+En4TZhM2Eu4TahNCEwYTGhNaEoYQhhf+E9IQXhRiFLIUfhRWFFIX8hECFY4VYhUiFQYUChkuFVYWAhaSFiIWRhYqFqIVthZSFm4XqhYeFnIV3hX6FkIXJhbqFz4W5hdCF1YXdheWF3IX5hQqGE4YLhv6F+oUGhiKGGoYwhj+GTYZVTlSGX4ZnhnGGk4ajhqmGqoaLhoyGtoavhsSGxoawhsmGI4irhtSG3obphuyG34bbhu+GEocGhwiHAIcDh/uGEYcJhw2H+YYKhzSHP4c3hzuHJYcphxqHYIdfh3iHTIdOh3SHV4doh26HWYdTh2OHaocFiKKHn4eCh6+Hy4e9h8CH0IfWlquHxIezh8eHxoe7h++H8ofghw+IDYj+h/aH94cOiNKHEYgWiBWIIoghiDGINog5iCeIO4hEiEKIUohZiF6IYohriIGIfoieiHWIfYi1iHKIgoiXiJKIroiZiKKIjYikiLCIv4ixiMOIxIjUiNiI2YjdiPmIAon8iPSI6IjyiASJDIkKiROJQ4keiSWJKokriUGJRIk7iTaJOIlMiR2JYIleiWaJZIltiWqJb4l0iXeJfomDiYiJiomTiZiJoYmpiaaJrImvibKJuom9ib+JwInaidyJ3YnnifSJ+IkDihaKEIoMihuKHYolijaKQYpbilKKRopIinyKbYpsimKKhYqCioSKqIqhipGKpYqmipqKo4rEis2KworaiuuK84rniuSK8YoUi+CK4or3it6K24oMiweLGovhihaLEIsXiyCLM4urlyaLK4s+iyiLQYtMi0+LTotJi1aLW4tai2uLX4tsi2+LdIt9i4CLjIuOi5KLk4uWi5mLmos6jEGMP4xIjEyMToxQjFWMYoxsjHiMeoyCjImMhYyKjI2MjoyUjHyMmIwdYq2Mqoy9jLKMs4yujLaMyIzBjOSM44zajP2M+oz7jASNBY0KjQeND40NjRCNTp8Tjc2MFI0WjWeNbY1xjXONgY2ZjcKNvo26jc+N2o3WjcyN243LjeqN643fjeON/I0IjgmO/40djh6OEI4fjkKONY4wjjSOSo5HjkmOTI5QjkiOWY5kjmCOKo5jjlWOdo5yjnyOgY6HjoWOhI6LjoqOk46RjpSOmY6qjqGOrI6wjsaOsY6+jsWOyI7LjtuO4478jvuO647+jgqPBY8VjxKPGY8TjxyPH48bjwyPJo8zjzuPOY9Fj0KPPo9Mj0mPRo9Oj1ePXI9ij2OPZI+cj5+Po4+tj6+Pt4/aj+WP4o/qj++Ph5D0jwWQ+Y/6jxGQFZAhkA2QHpAWkAuQJ5A2kDWQOZD4j0+QUJBRkFKQDpBJkD6QVpBYkF6QaJBvkHaQqJZykIKQfZCBkICQipCJkI+QqJCvkLGQtZDikOSQSGLbkAKREpEZkTKRMJFKkVaRWJFjkWWRaZFzkXKRi5GJkYKRopGrka+RqpG1kbSRupHAkcGRyZHLkdCR1pHfkeGR25H8kfWR9pEekv+RFJIskhWSEZJekleSRZJJkmSSSJKVkj+SS5JQkpySlpKTkpuSWpLPkrmSt5Lpkg+T+pJEky6TGZMikxqTI5M6kzWTO5Nck2CTfJNuk1aTsJOsk62TlJO5k9aT15Pok+WT2JPDk92T0JPIk+STGpQUlBOUA5QHlBCUNpQrlDWUIZQ6lEGUUpRElFuUYJRilF6UapQpknCUdZR3lH2UWpR8lH6UgZR/lIKVh5WKlZSVlpWYlZmVoJWolaeVrZW8lbuVuZW+lcqV9m/Dlc2VzJXVldSV1pXcleGV5ZXilSGWKJYuli+WQpZMlk+WS5Z3llyWXpZdll+WZpZylmyWjZaYlpWWl5aqlqeWsZaylrCWtJa2lriWuZbOlsuWyZbNlk2J3JYNl9WW+ZYElwaXCJcTlw6XEZcPlxaXGZcklyqXMJc5lz2XPpdEl0aXSJdCl0mXXJdgl2SXZpdol9JSa5dxl3mXhZd8l4GXepeGl4uXj5eQl5yXqJeml6OXs5e0l8OXxpfIl8uX3Jftl0+f8pffevaX9ZcPmAyYOJgkmCGYN5g9mEaYT5hLmGuYb5hwmHGYdJhzmKqYr5ixmLaYxJjDmMaY6ZjrmAOZCZkSmRSZGJkhmR2ZHpkkmSCZLJkumT2ZPplCmUmZRZlQmUuZUZlSmUyZVZmXmZiZpZmtma6ZvJnfmduZ3ZnYmdGZ7ZnumfGZ8pn7mfiZAZoPmgWa4pkZmiuaN5pFmkKaQJpDmj6aVZpNmluaV5pfmmKaZZpkmmmaa5pqmq2asJq8msCaz5rRmtOa1Jremt+a4prjmuaa75rrmu6a9Jrxmvea+5oGmxibGpsfmyKbI5slmyebKJspmyqbLpsvmzKbRJtDm0+bTZtOm1GbWJt0m5Obg5uRm5abl5ufm6CbqJu0m8Cbypu5m8abz5vRm9Kb45vim+Sb1Jvhmzqc8pvxm/CbFZwUnAmcE5wMnAacCJwSnAqcBJwunBucJZwknCGcMJxHnDKcRpw+nFqcYJxnnHaceJznnOyc8JwJnQid65wDnQadKp0mna+dI50fnUSdFZ0SnUGdP50+nUadSJ1dnV6dZJ1RnVCdWZ1ynYmdh52rnW+dep2anaSdqZ2yncSdwZ27nbidup3Gnc+dwp3ZndOd+J3mne2d7539nRqeG54ennWeeZ59noGeiJ6Lnoyekp6VnpGenZ6lnqmeuJ6qnq2eYZfMns6ez57QntSe3J7ent2e4J7lnuie7570nvae9575nvue/J79ngefCJ+3dhWfIZ8snz6fSp9Sn1SfY59fn2CfYZ9mn2efbJ9qn3efcp92n5WfnJ+gny9Yx2lZkGR03FGZcQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

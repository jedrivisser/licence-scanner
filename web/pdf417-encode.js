// PDF417 encoder for the South African driving licence barcode: turns the
// 720 raw payload bytes back into the exact symbol printed on the card, so
// it can be shown on a screen for a licence scanner to read.
//
// "Exact" matters - a scanner built for these cards expects the card's own
// layout - so this reproduces it codeword for codeword (validated against a
// real card's decoded grid and pdf417gen). The error-correction and
// row-indicator code is ported from pdf417-py (pdf417gen/error_correction.py,
// encoding.py; MIT, https://github.com/ihabunek/pdf417-py - see licences.txt):
//   - byte compaction with latch 924 (byte count is a multiple of 6),
//     6 bytes -> 5 base-900 codewords;
//   - length descriptor + 18 padding codewords (900) -> 620 data words;
//   - 128 error-correction codewords (security level 6) over GF(929),
//     generator prod(x - 3^i), i = 1..128;
//   - 34 rows x 22 columns, row indicators per cluster, start/stop;
//   - rows printed bottom-up: the card's symbol is vertically mirrored
//     (row 0 at the bottom - see pdf417-edge.js).
(function (root) {
  "use strict";

  const CODES = typeof PDF417_CODES !== "undefined" ? PDF417_CODES : require("./pdf417-codes.js");

  const COLS = 22;
  const ROWS = 34;
  const SECURITY_LEVEL = 6;
  const EC_COUNT = 128;
  const PAYLOAD_LENGTH = 720;
  const BYTE_LATCH_ALT = 924;
  const PADDING = 900;
  const START = 0x1fea8; // 17 modules
  const STOP = 0x3fa29; // 18 modules
  const MODULES = 17 * (COLS + 4) + 1; // 443 per row
  const MOD = 929;

  // generator polynomial coefficients, lowest degree first, without the
  // leading 1 (same as pdf417gen's ERROR_CORRECTION_FACTORS[6])
  const FACTORS = (() => {
    let g = [1];
    let r = 1;
    for (let i = 1; i <= EC_COUNT; i++) {
      r = (r * 3) % MOD;
      const n = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        n[j] = (n[j] - r * g[j] + MOD * MOD) % MOD;
        n[j + 1] = (n[j + 1] + g[j]) % MOD;
      }
      g = n;
    }
    return g.slice(0, EC_COUNT);
  })();

  // 6 bytes -> 5 base-900 codewords (48-bit values: exact in a double)
  function compactBytes(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 6) {
      let v = 0;
      for (let k = 0; k < 6; k++) v = v * 256 + bytes[i + k];
      const group = [];
      for (let k = 0; k < 5; k++) {
        group.unshift(v % 900);
        v = Math.floor(v / 900);
      }
      out.push(...group);
    }
    return out;
  }

  function errorCorrection(words) {
    const ec = new Array(EC_COUNT).fill(0);
    for (const w of words) {
      const t = (w + ec[EC_COUNT - 1]) % MOD;
      for (let x = EC_COUNT - 1; x >= 0; x--) {
        const prev = x > 0 ? ec[x - 1] : 0;
        ec[x] = (prev + MOD - ((t * FACTORS[x]) % MOD)) % MOD;
      }
    }
    return ec.reverse().map((x) => (x > 0 ? MOD - x : x));
  }

  // All 748 codewords in reading order (row by row, row 0 first).
  function codewords(bytes) {
    if (!bytes || bytes.length !== PAYLOAD_LENGTH) throw new Error(`expected ${PAYLOAD_LENGTH} bytes`);
    const data = [BYTE_LATCH_ALT, ...compactBytes(bytes)];
    const total = data.length + EC_COUNT + 1;
    const mod = total % COLS;
    const padding = mod > 0 ? new Array(COLS - mod).fill(PADDING) : [];
    const extended = [data.length + padding.length + 1, ...data, ...padding];
    const all = [...extended, ...errorCorrection(extended)];
    if (all.length !== ROWS * COLS) throw new Error(`unexpected symbol size ${all.length}`);
    return all;
  }

  function rowIndicators(r) {
    const base = 30 * Math.floor(r / 3);
    const a = Math.floor((ROWS - 1) / 3);
    const b = SECURITY_LEVEL * 3 + ((ROWS - 1) % 3);
    const c = COLS - 1;
    const [left, right] = [
      [a, c],
      [b, a],
      [c, b],
    ][r % 3];
    return [base + left, base + right];
  }

  // Module matrix as rows of 0/1 (1 = bar), top to bottom as printed on
  // the card (mirrored: row 0 at the bottom). Each entry is one symbol row
  // (443 modules); draw it rowHeight modules tall.
  function encodeMatrix(bytes, { mirrored = true } = {}) {
    const cw = codewords(bytes);
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      const cluster = r % 3;
      const [li, ri] = rowIndicators(r);
      const words = [START, CODES[cluster][li], ...cw.slice(r * COLS, (r + 1) * COLS).map((v) => CODES[cluster][v]), CODES[cluster][ri]];
      const bits = new Uint8Array(MODULES);
      let o = 0;
      for (const w of words) for (let b = 16; b >= 0; b--) bits[o++] = (w >> b) & 1;
      for (let b = 17; b >= 0; b--) bits[o++] = (STOP >> b) & 1;
      rows.push(bits);
    }
    if (mirrored) rows.reverse();
    return rows;
  }

  const api = { COLS, ROWS, MODULES, PAYLOAD_LENGTH, codewords, encodeMatrix };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PDF417Encode = api;
})(typeof self !== "undefined" ? self : this);

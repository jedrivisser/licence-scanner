// The licence photo: a Summus "WI" wavelet image, decoded in the browser.
//
// A JavaScript port of python/wi.py from
// github.com/FrancoisSt/sa-driving-licence-barcode (MIT, (c) 2026 Francois
// Stander), which implements that repository's
// spec/wi-codec.md (a clean-room description of the codec, after Donald
// Jansen's reconstruction). Section numbers below are the spec's.
//
// Licence profile only (format 4, 200 wide x 250 high, 8-bit greyscale):
//   WI.decode(bytes) -> Uint8Array(50000), upright, row by row from the top-left
// Errors throw a WiError whose .code is "E1" to "E5" (section 12).
//
// Arithmetic: the codec works in signed 32-bit wrap-around. Every product
// below fits a double exactly, so `| 0` after it is the same wrap.
(function (root) {
  "use strict";

  const H = 250; // rows of the codec raster
  const W = 200; // columns
  const PIXELS = H * W;
  const MIN_SIZE = 13;
  const MAX_SIZE = 674;
  const LEVELS = 5;
  const HEADER_SIZE = 12;
  const B0 = 0, B1 = 1, B2 = 2; // the detail bands of section 5

  class WiError extends Error {
    constructor(code) {
      super(`${code}: ${WiError.MESSAGES[code]}`);
      this.code = code;
    }
  }
  WiError.MESSAGES = {
    E1: "not the licence WI profile",
    E2: "end of data",
    E3: "skip count above 5",
    E4: "escape width above 10",
    E5: "run count not exhausted after the map",
  };

  // x div 2^k rounding toward zero (section 0), unlike >> (toward -infinity)
  const truncDiv = (x, k) => Math.trunc(x / (1 << k));

  // ---------------------------------------------------------- section 3: bits
  class BitReader {
    constructor(data, start) {
      this.data = data;
      this.fetched = start;
      this.byte = 0;
      this.left = 0;
    }
    bit() {
      if (this.left === 0) {
        if (this.fetched >= this.data.length) throw new WiError("E2");
        this.byte = this.data[this.fetched++];
        this.left = 8;
      }
      this.left--;
      return (this.byte >> this.left) & 1;
    }
    // unsigned n-bit value, n <= 31 here; multiply rather than shift to stay unsigned
    bits(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + this.bit();
      return v;
    }
  }

  // --------------------------------------------- section 4: adaptive Huffman
  // FGK with a large-value leaf N and an escape leaf N + 1.
  class AdaptiveHuffman {
    constructor(n, presets) {
      this.n = n;
      const size = 2 * n + 3;
      this.parent = new Int32Array(size).fill(-1);
      this.leaf = new Uint8Array(size);
      this.payload = new Int32Array(size); // a leaf's symbol, or an internal node's first child
      this.weight = new Int32Array(size);
      this.nodeOf = new Int32Array(n + 2).fill(-1);
      this.payload[0] = 1;
      this.weight[0] = 2;
      this.parent[1] = 0; this.leaf[1] = 1; this.payload[1] = n; this.weight[1] = 1;
      this.parent[2] = 0; this.leaf[2] = 1; this.payload[2] = n + 1; this.weight[2] = 1;
      this.nodeOf[n] = 1;
      this.nodeOf[n + 1] = 2;
      this.next = 3;
      for (let s = 0; s < presets; s++) {
        this.add(s);
        this.update(s);
      }
    }
    // 4.3: split the last node, a leaf, into itself and a new zero-weight leaf for s
    add(s) {
      if (this.nodeOf[s] !== -1) return;
      const d = this.next;
      this.leaf[d] = this.leaf[d - 1];
      this.payload[d] = this.payload[d - 1];
      this.weight[d] = this.weight[d - 1];
      this.parent[d] = d - 1;
      this.nodeOf[this.payload[d]] = d;
      this.leaf[d - 1] = 0;
      this.payload[d - 1] = d;
      this.leaf[d + 1] = 1;
      this.payload[d + 1] = s;
      this.weight[d + 1] = 0;
      this.parent[d + 1] = d - 1;
      this.nodeOf[s] = d + 1;
      this.next = d + 2;
    }
    // 4.4: increment leaf to root, swapping each node to the front of its weight class
    update(s) {
      const w = this.weight;
      let i = this.nodeOf[s];
      while (i !== -1) {
        w[i]++;
        let j = i;
        while (j > 0 && w[j - 1] < w[i]) j--;
        if (j !== i) {
          this.swap(i, j);
          i = j;
        }
        i = this.parent[i];
      }
    }
    // 4.5: exchange nodes i and j's contents; parents stay with the node numbers
    swap(i, j) {
      for (const [x, y] of [[i, j], [j, i]]) {
        if (this.leaf[x]) this.nodeOf[this.payload[x]] = y;
        else {
          this.parent[this.payload[x]] = y;
          this.parent[this.payload[x] + 1] = y;
        }
      }
      for (const a of [this.leaf, this.payload, this.weight]) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
    }
    // 4.6: one symbol, 0 to N
    decode(reader, escapeBits) {
      let i = 0;
      while (!this.leaf[i]) i = this.payload[i] + reader.bit();
      let s = this.payload[i];
      if (s === this.n + 1) {
        s = reader.bits(escapeBits);
        this.add(s);
      }
      this.update(s);
      return s;
    }
  }

  // 4.7: a run length; symbols 255 and 256 each start an extension hi * 256 + lo
  function readRun(model, reader) {
    let extensions = 0;
    let s = model.decode(reader, 8);
    while (s >= 255) {
      extensions++;
      s = model.decode(reader, 8);
    }
    let value = s;
    for (let k = 0; k < extensions; k++) value = (value * 256 + model.decode(reader, 8)) | 0;
    return value;
  }

  // ------------------------------------------------------ section 5: geometry
  const size = (n, level) => Math.floor((n - 2) / (1 << level)) + 2;
  const low = (n) => (n >> 1) + 1;
  const high = (n) => n - low(n);
  function bandRect(band, level) {
    const n = size(H, level), m = size(W, level);
    if (band === B0) return [0, low(n), low(m), m];
    if (band === B1) return [low(n), n, 0, low(m)];
    return [low(n), n, low(m), m];
  }

  // ------------------------------------------- section 8: significance map
  const NOT_SIGNIFICANT = 1, SIGNIFICANT = 2, HAS_DESCENDANT = 4;

  // 8.1: quadrant order and orientation; T/Bt rows, Lf/Rt columns
  const QUADRANTS = [
    [["T", "Rt", 3], ["Bt", "Rt", 0], ["Bt", "Lf", 0], ["T", "Lf", 2]],
    [["Bt", "Lf", 2], ["T", "Lf", 1], ["T", "Rt", 1], ["Bt", "Rt", 3]],
    [["Bt", "Lf", 1], ["Bt", "Rt", 2], ["T", "Rt", 2], ["T", "Lf", 0]],
    [["T", "Rt", 0], ["T", "Lf", 3], ["Bt", "Lf", 3], ["Bt", "Rt", 1]],
  ];

  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const rangeDown = (a, b) => range(a, b).reverse();

  // 8.1's table: a small rectangle's cells in orientation o's back-and-forth order
  function serpentine(r0, r1, c0, c1, o) {
    const cells = [];
    if (o === 0 || o === 1) {
      let forward = o === 0;
      for (const c of o === 0 ? rangeDown(c0, c1) : range(c0, c1)) {
        for (const r of forward ? range(r0, r1) : rangeDown(r0, r1)) cells.push([r, c]);
        forward = !forward;
      }
    } else {
      let forward = o === 2;
      for (const r of o === 2 ? rangeDown(r0, r1) : range(r0, r1)) {
        for (const c of forward ? range(c0, c1) : rangeDown(c0, c1)) cells.push([r, c]);
        forward = !forward;
      }
    }
    return cells;
  }

  // 8.2: the coarser position of a high-pass row or column x of a dimension n
  function parentIndex(x, n) {
    if (n % 4 === 0 || n % 4 === 1) return (x + 1) >> 1;
    if (n % 4 === 2) return (x + 2) >> 1;
    return x === n - 1 ? (x + 1) >> 1 : (x + 2) >> 1;
  }

  class MapDecoder {
    constructor(reader, m) {
      this.reader = reader;
      this.m = m;
      this.model = new AdaptiveHuffman(256, 64);
      this.remaining = 0; // R: 1-cells to pass before the next significant one
      this.level = 0;
      this.band = B0;
    }
    run(skip) {
      this.remaining = readRun(this.model, this.reader);
      for (let level = skip; level < LEVELS; level++) {
        this.level = level;
        const order = (level - skip) % 2 === 0 ? [[B0, 3], [B2, 0], [B1, 0]] : [[B1, 1], [B2, 2], [B0, 2]];
        for (const [band, o] of order) {
          this.band = band;
          const [r0, r1, c0, c1] = bandRect(band, level);
          this.visit(r0, r1, c0, c1, o);
        }
      }
      if (this.remaining !== 0) throw new WiError("E5");
    }
    countUnmarked(r0, r1, c0, c1) {
      let n = 0;
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (this.m[r * W + c] === NOT_SIGNIFICANT) n++;
      return n;
    }
    visit(r0, r1, c0, c1, o) {
      const count = this.countUnmarked(r0, r1, c0, c1);
      if (this.remaining >= count) {
        // signed: a negative R never skips
        this.remaining -= count;
        return;
      }
      if (r1 - r0 > 2 && c1 - c0 > 2) {
        const rm = r0 + ((r1 - r0) >> 1), cm = c0 + ((c1 - c0) >> 1);
        const rows = { T: [r0, rm], Bt: [rm, r1] };
        const cols = { Lf: [c0, cm], Rt: [cm, c1] };
        for (const [rn, cn, q] of QUADRANTS[o]) this.visit(rows[rn][0], rows[rn][1], cols[cn][0], cols[cn][1], q);
        return;
      }
      for (const [r, c] of serpentine(r0, r1, c0, c1, o)) this.cell(r, c);
    }
    cell(r, c) {
      if (this.m[r * W + c] !== NOT_SIGNIFICANT) return;
      if (this.remaining !== 0) {
        this.remaining = (this.remaining - 1) | 0;
        return;
      }
      this.m[r * W + c] = SIGNIFICANT;
      this.markAncestors(r, c);
      this.remaining = readRun(this.model, this.reader);
    }
    // 8.2: mark the same band's ancestors, one level coarser each time, up to level 4
    markAncestors(r, c) {
      const rowsHigh = this.band === B1 || this.band === B2;
      const colsHigh = this.band === B0 || this.band === B2;
      for (let p = this.level; p < LEVELS - 1; p++) {
        r = rowsHigh ? parentIndex(r, size(H, p)) : r >> 1;
        c = colsHigh ? parentIndex(c, size(W, p)) : c >> 1;
        if (this.m[r * W + c] === HAS_DESCENDANT) return;
        this.m[r * W + c] = HAS_DESCENDANT;
      }
    }
  }

  // --------------------------------------------- section 9: reconstruction
  // 9.1: replace the level region by the bilinear upsampling of the coarser image
  function upsample(x, level) {
    const n = size(H, level), m = size(W, level);
    const a = low(n), b = low(m);
    const sources = (p, length, lastLow) => {
      if (length % 2 === 0 && p === length - 1) return [lastLow];
      if (p % 2 === 0) return [p >> 1];
      return [(p - 1) >> 1, (p + 1) >> 1];
    };
    const rowSrc = range(0, n).map((p) => sources(p, n, a - 1));
    const colSrc = range(0, m).map((q) => sources(q, m, b - 1));
    const exceptionRowB = n % 2 === 1 ? n - 1 : n - 2;
    const y = new Int32Array(n * m);
    for (let p = 0; p < n; p++) {
      const rs = rowSrc[p];
      for (let q = 0; q < m; q++) {
        const cs = colSrc[q];
        let s = 0;
        for (const i of rs) for (const j of cs) s += x[i * W + j] + 1;
        s |= 0;
        const k = { 1: 1, 2: 2, 4: 3 }[rs.length * cs.length];
        const truncating = (n % 2 === 0 && p === n - 1) || (m % 2 === 0 && q === m - 1 && p === exceptionRowB);
        y[p * m + q] = truncating ? truncDiv(s, k) : s >> k;
      }
    }
    for (let p = 0; p < n; p++) x.set(y.subarray(p * m, (p + 1) * m), p * W);
  }

  // 9.3: K_L(i; n) as [position, weight] pairs; the first matching row wins
  function lowKernel(i, n) {
    if (i === 0) return [[0, 2], [1, 1]];
    if (i === (n - 1) >> 1) return [[2 * i - 1, 1], [2 * i, 2]];
    if (i === low(n) - 1) return [[n - 1, 2]];
    return [[2 * i - 1, 1], [2 * i, 2], [2 * i + 1, 1]];
  }

  // 9.3: K_H(t; n), centred on position 2t + 1
  function highKernel(t, n) {
    const p = 2 * t + 1;
    if (t === 0) return [[0, -2], [1, 6], [2, -2], [3, -1]];
    if (t === high(n) - 1) return [[p - 2, -1], [p - 1, -2], [p, 6], [p + 1, -2]];
    return [[p - 2, -1], [p - 1, -2], [p, 6], [p + 1, -2], [p + 2, -1]];
  }

  // 9.2 and 9.3: read the level's detail values, add each one's basis function
  function addDetails(reader, x, sig, level, q, coefficients) {
    const escapeBits = reader.bits(5);
    if (escapeBits > 10) throw new WiError("E4");
    const model = new AdaptiveHuffman(2048, 3);
    const n = size(H, level), m = size(W, level);
    for (const band of [B0, B1, B2]) {
      const [r0, r1, c0, c1] = bandRect(band, level);
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const mark = sig[r * W + c];
          if (mark === NOT_SIGNIFICANT) continue;
          const negative = reader.bit();
          let k = model.decode(reader, escapeBits);
          if (mark === SIGNIFICANT) k++;
          let v = k * q + (q >> 1);
          if (negative) v = -v;
          if (coefficients) coefficients.push(v);
          let rows, cols, scale;
          if (band === B0) [rows, cols, scale] = [lowKernel(r, n), highKernel(c - low(m), m), 2];
          else if (band === B1) [rows, cols, scale] = [highKernel(r - low(n), n), lowKernel(c, m), 2];
          else [rows, cols, scale] = [highKernel(r - low(n), n), highKernel(c - low(m), m), 1];
          for (const [yy, alpha] of rows) {
            const base = yy * W;
            for (const [xx, beta] of cols) x[base + xx] = (x[base + xx] + scale * v * alpha * beta) | 0;
          }
        }
      }
    }
    return escapeBits;
  }

  // 9.4: 5-point sharpening of the level-1 image (126 x 101), borders kept
  function sharpen(x) {
    const n1 = size(H, 1), m1 = size(W, 1);
    const s = Int32Array.from(x);
    for (let r = 1; r < n1 - 1; r++) {
      for (let c = 1; c < m1 - 1; c++) {
        const i = r * W + c;
        s[i] = ((12 * x[i] - x[i - 1] - x[i + 1] - x[i - W] - x[i + W]) | 0) >> 3;
      }
    }
    x.set(s);
  }

  // ---------------------------------------------- section 2 and the decoder
  const PREFIX = [0x57, 0x49, 0x04, 0x00, 0xfa, 0x00, 0xc8];
  const SUFFIX = [0x28, 0x40, 0x00];

  // section 2: exactly the licence profile, or E1; returns Q
  function checkHeader(wi) {
    if (wi.length < MIN_SIZE || wi.length > MAX_SIZE) throw new WiError("E1");
    const ok =
      PREFIX.every((b, i) => wi[i] === b) &&
      (wi[7] === 0x42 || wi[7] === 0x43) &&
      !(wi[8] & 1) &&
      SUFFIX.every((b, i) => wi[9 + i] === b);
    if (!ok) throw new WiError("E1");
    return ((wi[7] & 1) << 7) | (wi[8] >> 1);
  }

  // int32 region, little-endian row-major (section 14's checkpoint form)
  function regionBytes(x, rows, cols) {
    const out = new Int32Array(rows * cols);
    for (let r = 0; r < rows; r++) out.set(x.subarray(r * W, r * W + cols), r * cols);
    return new Uint8Array(out.buffer); // little-endian on every platform a browser runs on
  }

  // The whole decoder. `trace`, an object, receives section 14's checkpoints (tests only).
  function decodeNativeOrder(wi, trace) {
    wi = wi instanceof Uint8Array ? wi : Uint8Array.from(wi);
    const q = checkHeader(wi);
    const reader = new BitReader(wi, HEADER_SIZE);
    const x = new Int32Array(PIXELS);

    // section 6: the LL band, 9 x 8, step 64 Q with mid-point reconstruction
    const llBits = reader.bits(5);
    const offset = reader.bits(llBits) & 0xff;
    for (let r = 0; r < size(H, LEVELS); r++) {
      for (let c = 0; c < size(W, LEVELS); c++) {
        const v = reader.bits(llBits) - offset;
        x[r * W + c] = (v >= 0 ? (2 * v + 1) * 32 * q : (2 * v - 1) * 32 * q) | 0;
      }
    }

    // section 7: the skip count, unary
    let skip = 0;
    while (reader.bit()) skip++;
    if (skip > LEVELS) throw new WiError("E3");

    // section 8: the significance map
    const sig = new Uint8Array(PIXELS).fill(NOT_SIGNIFICANT);
    new MapDecoder(reader, sig).run(skip);
    if (trace) Object.assign(trace, { q, ll_bits: llBits, skip, C1_ll: regionBytes(x, 9, 8), C2_map: sig.slice(), levels: [] });

    // section 9: level 4 down to level 0
    for (let level = LEVELS - 1; level >= 0; level--) {
      const n = size(H, level), m = size(W, level);
      if (level === 0) {
        sharpen(x);
        if (trace) trace.C6_sharpened = regionBytes(x, size(H, 1), size(W, 1));
      }
      upsample(x, level);
      const record = { level, C3_upsampled: trace ? regionBytes(x, n, m) : null };
      const coefficients = trace ? [] : null;
      record.escape_bits = level >= skip ? addDetails(reader, x, sig, level, q, coefficients) : null;
      if (trace) {
        record.C4_coefficients = new Uint8Array(Int32Array.from(coefficients).buffer);
        record.C4_coefficient_count = coefficients.length;
        record.C5_reconstructed = regionBytes(x, n, m);
        trace.levels.push(record);
      }
    }

    // section 10: X is 32 x the sample; round, clamp, keep the (upside-down) codec order
    const raster = new Uint8Array(PIXELS);
    for (let i = 0; i < PIXELS; i++) {
      const t = (x[i] + 16) | 0;
      raster[i] = t >= 8192 ? 255 : t < 0 ? 0 : t >> 5;
    }
    if (trace) {
      trace.bytes_consumed = reader.fetched;
      trace.C7_raster = raster.slice();
      trace.C8_portrait = raster.slice().reverse();
    }
    return raster;
  }

  // WI bytes -> the upright 200 x 250 portrait (C8): the codec raster turned 180 degrees
  const decode = (wi) => decodeNativeOrder(wi).reverse();

  const api = { WIDTH: W, HEIGHT: H, WiError, decode, decodeNativeOrder };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WI = api;
})(typeof self !== "undefined" ? self : this);

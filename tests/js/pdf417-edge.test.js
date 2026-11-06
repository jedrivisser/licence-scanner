// node --test tests/js/*.test.js
//
// Real-card frames can't be committed (PII); the synthetic fixture
// (built by tests/js/make_fixture.py) reproduces what made real frames hard:
// mirrored row order, a bent module grid, blur, uneven light, noise, at
// ~3.1 px/module (real frames from the default ~1920px stream run ~2-4).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const E = require("../../web/pdf417-edge.js");

function loadFixture() {
  const f = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "synthetic.json.gz"))));
  const gray = Buffer.from(f.gray_b64, "base64");
  return {
    img: { data: Float32Array.from(gray), width: f.width, height: f.height },
    expected: Buffer.from(f.expected_b64, "base64"),
  };
}

test("decodes a degraded, mirrored synthetic symbol to the exact payload", () => {
  const { img, expected } = loadFixture();
  const r = E.decodeFrame(img, new Map());
  assert.ok(r.detected, "symbol detected");
  assert.strictEqual(r.stats.orientation, "mirrored");
  assert.ok(r.bytes, "decoded");
  assert.ok(Buffer.from(r.bytes).equals(expected), "payload matches");
});

test("votes accumulate across frames: two half-readable frames decode together", () => {
  const { img, expected } = loadFixture();
  // Wipe out (flat grey) the right half in one copy and the left half in
  // the other - neither decodes alone, together they cover every column.
  const half = (keepLeft) => {
    const d = Float32Array.from(img.data);
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const inSymbolMiddle = x > 470 && x < 1030;
        if (inSymbolMiddle && (keepLeft ? x > 750 : x <= 750)) d[y * img.width + x] = 128;
      }
    return { data: d, width: img.width, height: img.height };
  };
  const votes = new Map();
  const a = E.decodeFrame(half(true), votes);
  assert.strictEqual(a.bytes, null, "left half alone must not decode");
  const b = E.decodeFrame(half(false), votes);
  assert.ok(b.bytes, "accumulated votes decode");
  assert.strictEqual(b.source, "accumulated");
  assert.ok(Buffer.from(b.bytes).equals(expected));
});

test("Reed-Solomon corrects within its safety margin and refuses at or beyond the budget", () => {
  const { img } = loadFixture();
  const votes = new Map();
  E.decodeFrame(img, votes);
  // a clean codeword stream from a fully-voted grid, corrected first
  const grid = E.votesToGrid(votes);
  const flat = grid.flat().map((c) => (c === null ? 0 : c));
  const erasures = grid.flat().flatMap((c, i) => (c === null ? [i] : []));
  const clean = E.rsDecode(flat, 128, erasures);
  assert.ok(clean);

  const corrupt = (nErr, nEras, seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const cw = clean.slice();
    const idx = new Set();
    while (idx.size < nErr + nEras) idx.add(Math.floor(rnd() * cw.length));
    const all = [...idx];
    for (const i of all.slice(0, nErr)) cw[i] = (cw[i] + 1 + Math.floor(rnd() * 927)) % 929;
    const er = all.slice(nErr);
    for (const i of er) cw[i] = 0;
    return { cw, er };
  };
  // within 2*errors + erasures <= 120 (128 minus the safety margin)
  for (const [nErr, nEras] of [
    [60, 0],
    [0, 120],
    [28, 64],
  ]) {
    const { cw, er } = corrupt(nErr, nEras, nErr * 1000 + nEras);
    assert.deepStrictEqual(E.rsDecode(cw, 128, er), clean, `${nErr} errors + ${nEras} erasures`);
  }
  // at or beyond the budget: refused (null), never a different answer
  for (const [nErr, nEras] of [
    [64, 0],
    [70, 0],
    [0, 127],
    [30, 68],
  ]) {
    const { cw, er } = corrupt(nErr, nEras, nErr * 1000 + nEras + 1);
    assert.strictEqual(E.rsDecode(cw, 128, er), null, `${nErr} errors + ${nEras} erasures`);
  }
});

test("decodeGrid never returns wrong bytes near the erasure limit", () => {
  // Accumulated votes typically pass through ~127 empty cells plus a few
  // misreads just before a real decode - the regime where an exactly
  // determined correction used to be accepted as a wrong success.
  const { img, expected } = loadFixture();
  const votes = new Map();
  E.decodeFrame(img, votes);
  const g0 = E.votesToGrid(votes).flat();
  const clean = E.rsDecode(g0.map((c) => (c === null ? 0 : c)), 128, g0.flatMap((c, i) => (c === null ? [i] : [])));
  let s = 99;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let refused = 0;
  for (const [nErr, nEras] of [
    [1, 127],
    [2, 126],
    [2, 125],
    [3, 124],
    [5, 120],
  ])
    for (let t = 0; t < 40; t++) {
      const cw = clean.slice();
      const idx = new Set();
      while (idx.size < nErr + nEras) idx.add(2 + Math.floor(rnd() * (cw.length - 2)));
      const all = [...idx];
      for (const i of all.slice(0, nErr)) cw[i] = (cw[i] + 1 + Math.floor(rnd() * 927)) % 929;
      const erased = new Set(all.slice(nErr));
      const grid = [];
      for (let r = 0; r < E.ROWS; r++) grid.push(cw.slice(r * E.COLS, (r + 1) * E.COLS).map((v, c) => (erased.has(r * E.COLS + c) ? null : v)));
      const bytes = E.decodeGrid(grid);
      if (bytes === null) refused++;
      else assert.ok(Buffer.from(bytes).equals(expected), `${nErr} errors + ${nEras} erasures decoded to wrong bytes`);
    }
  assert.ok(refused > 0);
});

test("no symbol -> not detected, no exception", () => {
  const w = 800;
  const h = 300;
  const data = new Float32Array(w * h).fill(180);
  const r = E.decodeFrame({ data, width: w, height: h }, new Map());
  assert.strictEqual(r.detected, false);
  assert.strictEqual(r.bytes, null);
});

test("decodes the symbol held upside down (frame rotated 180 degrees)", () => {
  const { img, expected } = loadFixture();
  const rotated = { data: img.data.slice().reverse(), width: img.width, height: img.height };
  const r = E.decodeFrame(rotated, new Map());
  assert.ok(r.rotated180, "found via the 180-degree retry");
  assert.ok(r.bytes && Buffer.from(r.bytes).equals(expected));
});

const Enc = require("../../web/pdf417-encode.js");

function renderMatrix(rows, px = 3, rowHeight = 3, quiet = 4) {
  const w = (Enc.MODULES + 2 * quiet) * px;
  const h = (rows.length * rowHeight + 2 * quiet) * px;
  const data = new Float32Array(w * h).fill(255);
  rows.forEach((bits, r) => {
    for (let m = 0; m < bits.length; m++) {
      if (!bits[m]) continue;
      for (let y = (quiet + r * rowHeight) * px; y < (quiet + (r + 1) * rowHeight) * px; y++)
        for (let x = (quiet + m) * px; x < (quiet + m + 1) * px; x++) data[y * w + x] = 0;
    }
  });
  return { data, width: w, height: h };
}

test("encoder reproduces the fixture symbol's codewords exactly (pdf417gen-built)", () => {
  const { img, expected } = loadFixture();
  const votes = new Map();
  E.decodeFrame(img, votes);
  const grid = E.votesToGrid(votes).flat();
  const read = E.rsDecode(grid.map((c) => (c === null ? 0 : c)), 128, grid.flatMap((c, i) => (c === null ? [i] : [])));
  assert.deepStrictEqual(Enc.codewords(expected), read);
});

test("encoded symbol decodes back to the same bytes, mirrored like the card", () => {
  const { expected } = loadFixture();
  const r = E.decodeFrame(renderMatrix(Enc.encodeMatrix(expected)), new Map());
  assert.ok(r.bytes && Buffer.from(r.bytes).equals(expected));
  assert.strictEqual(r.stats.orientation, "mirrored");
  assert.strictEqual(r.cellsFilled, 748);
});

test("reads a perfectly sharp rendering at exactly 2 px/module (barcode on a screen)", () => {
  const { expected } = loadFixture();
  const r = E.decodeFrame(renderMatrix(Enc.encodeMatrix(expected), 2), new Map());
  assert.ok(r.bytes && Buffer.from(r.bytes).equals(expected));
});

// The scanner's "hold the card flat" hint relies on endSharpness: it must
// call evenly focused ends even (despite uneven light) and name the end
// that really is soft.
test("endSharpness: even ends score alike, a blurred end is named", () => {
  const { img } = loadFixture();
  const even = E.decodeFrame(img, new Map()).endSharpness;
  assert.ok(even.ratio > 0.8, `even ratio ${even.ratio}`);
  assert.strictEqual(even.softer, "neither");
  for (const side of ["left", "right"]) {
    const d = Float32Array.from(img.data);
    const W = img.width;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < W; x++) {
        if (side === "right" ? x < W * 0.55 : x > W * 0.45) continue;
        let s = 0;
        for (let dx = -5; dx <= 5; dx++) s += img.data[y * W + Math.min(W - 1, Math.max(0, x + dx))];
        d[y * W + x] = s / 11;
      }
    const r = E.decodeFrame({ data: d, width: W, height: img.height }, new Map());
    assert.ok(r.detected, `${side}: detected`);
    assert.strictEqual(r.endSharpness.softer, side);
    assert.ok(r.endSharpness.ratio < 0.5, `${side}: ratio ${r.endSharpness.ratio}`);
    assert.strictEqual(r.inferred, side === "left" ? "start" : "stop", "the blurred end's pattern is the one inferred");
  }
});

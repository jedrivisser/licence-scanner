// Edge-based PDF417 reader for the South African driving licence barcode.
//
// Why not zxing: zxing-cpp black/white-thresholds the whole image and then
// samples modules, which on real photos of this (very dense, vertically
// mirrored, little error-correction slack) symbol never got past
// ChecksumError. This reader
// works from bar edges instead of a thresholded image, and uses
// erasure-aware error correction:
//
//   detect    start/stop patterns found from edges on horizontal scan lines;
//             left/right symbol edges fitted as lines; top/bottom from the
//             wide solid bar of each pattern (survives blur and glare that
//             kill the thin elements).
//   dewarp    perspective-rectify the symbol to MODULES x ROWS*3 modules.
//   edges     sub-pixel gradient edges per scan line, keeping only real
//             bars/spaces (intensity swing vs local contrast) - no global
//             threshold, so uneven lighting doesn't matter.
//   codewords edge-to-similar-edge distances (t-values), the measurement
//             PDF417 was designed around: bar growth from blur/ink spread
//             cancels out. Positions are *chained* codeword to codeword
//             (from both ends), because real cards/lenses bend the module
//             grid by several modules across the symbol.
//   rows      from the row indicators (this symbol has row 0 at the
//             bottom - it is mirrored), fitted against y.
//   votes     every scan line votes per (row, column); votes accumulate
//             across frames, so a region blurred in one frame is filled in
//             by another.
//   RS        Reed-Solomon over GF(929) with erasures, then byte
//             decompaction.
//
// Fixed symbol structure (all SA licences): 22 data columns, 34 rows,
// security level 6 (128 EC codewords), 720 payload bytes in byte
// compaction. The latch is 924 - PDF417's alternate byte latch, used when
// the byte count is an exact multiple of 6 - not the general 901 (using
// 901 silently breaks the whole RS block). Row indicators on real cards
// confirm rows/columns/EC level. Validated against real card frames and
// tests/js/.
(function (root) {
  "use strict";

  const CODES = typeof PDF417_CODES !== "undefined" ? PDF417_CODES : require("./pdf417-codes.js");

  const COLS = 22;
  const ROWS = 34;
  const MODULES = 17 * (COLS + 4) + 1; // 443: start + LRI + data + RRI + stop
  // quiet zone kept on each side of the rectified symbol, so the start and
  // stop patterns' outer edges aren't on the image border (where no
  // gradient peak can be found)
  const MARGIN = 3;
  const EC_COUNT = 128;
  const RAW_PAYLOAD_LENGTH = 720;
  const BYTE_COMPACTION_LATCH = 924;
  const DATA_WORD_COUNT = 1 + (RAW_PAYLOAD_LENGTH / 6) * 5; // latch + 600
  const START_W = [8, 1, 1, 1, 1, 1, 1, 3];
  const STOP_W = [7, 1, 1, 3, 1, 1, 1, 2, 1];

  // ------------------------------------------------------------ lookup
  // T_LOOKUP[cluster] : Map(tKey -> value), tKey = 6 t-values (each 2..9)
  // packed base 8.
  function tKey(t) {
    let k = 0;
    for (let i = 0; i < 6; i++) k = k * 8 + (t[i] - 2);
    return k;
  }
  const T_LOOKUP = CODES.map((cluster) => {
    const m = new Map();
    cluster.forEach((pattern, value) => {
      const w = [];
      let cur = (pattern >> 16) & 1;
      let n = 0;
      for (let b = 16; b >= 0; b--) {
        const bit = (pattern >> b) & 1;
        if (bit === cur) n++;
        else {
          w.push(n);
          cur = bit;
          n = 1;
        }
      }
      w.push(n);
      const t = [];
      for (let i = 0; i < 6; i++) t.push(w[i] + w[i + 1]);
      m.set(tKey(t), value);
    });
    return m;
  });

  // ------------------------------------------------------------ helpers
  function median(arr) {
    const s = Array.from(arr).sort((a, b) => a - b);
    const n = s.length;
    if (!n) return NaN;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function percentile(arr, p) {
    // numpy's default (linear interpolation)
    const s = Array.from(arr).sort((a, b) => a - b);
    if (!s.length) return NaN;
    const idx = (p / 100) * (s.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  // Centered rolling max/min with edge padding (matches the reference's
  // np.pad(mode="edge") + sliding_window_view), via monotonic deques.
  function rollingExtreme(a, win, isMax) {
    const n = a.length;
    const half = win >> 1;
    const out = new Float32Array(n);
    const get = (i) => a[Math.min(n - 1, Math.max(0, i))];
    const dq = []; // indices into the virtual padded array
    let head = 0;
    const better = isMax ? (x, y) => x >= y : (x, y) => x <= y;
    // padded index j corresponds to source index j - half
    for (let j = 0; j < n + win - 1; j++) {
      const v = get(j - half);
      while (dq.length > head && better(v, get(dq[dq.length - 1] - half))) dq.pop();
      dq.push(j);
      const start = j - win + 1;
      if (start >= 0) {
        while (dq[head] < start) head++;
        out[start] = get(dq[head] - half);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ edges
  // Returns {pos: Float64Array, pol: Int8Array}; pol +1 = light->dark
  // (leading edge of a bar), -1 = dark->light.
  // minSwing: a bar/space must differ from its neighbours by this fraction
  // of local contrast to count. Swept over every saved real frame: 0.22
  // merged away genuine thin elements at ~2.4 px/module (they swing only
  // ~0.15); 0.16 decodes the most frames; at 0.12 and below noise inside
  // wide bars starts faking elements.
  function extractEdges(profile, minSwing = 0.16, contrastWin = 201) {
    const n = profile.length;
    const g = new Float32Array(n);
    if (n < 3) return { pos: new Float64Array(0), pol: new Int8Array(0) };
    g[0] = profile[1] - profile[0];
    g[n - 1] = profile[n - 1] - profile[n - 2];
    for (let i = 1; i < n - 1; i++) g[i] = (profile[i + 1] - profile[i - 1]) / 2;
    const a = new Float32Array(n);
    let amax = 0;
    for (let i = 0; i < n; i++) {
      a[i] = Math.abs(g[i]);
      if (a[i] > amax) amax = a[i];
    }
    if (amax <= 0) return { pos: new Float64Array(0), pol: new Int8Array(0) };

    let ii = [];
    let pol = [];
    const mag = [];
    // A neighbour only competes if its gradient has the same sign: where a
    // bar exactly 2 px wide meets a space (a perfectly sharp image - e.g. a
    // barcode shown on a screen), the falling and rising edges sit side by
    // side with equal |g| and would otherwise suppress each other.
    const sameSignMag = (i, j) => (g[j] > 0 === g[i] > 0 ? a[j] : 0);
    for (let i = 1; i < n - 1; i++) {
      if (!(a[i] >= sameSignMag(i, i - 1) && a[i] > sameSignMag(i, i + 1) && a[i] > 0.5)) continue;
      const p = g[i] > 0 ? -1 : 1;
      if (pol.length && pol[pol.length - 1] === p) {
        if (a[i] > mag[mag.length - 1]) {
          ii[ii.length - 1] = i;
          mag[mag.length - 1] = a[i];
        }
        continue;
      }
      ii.push(i);
      pol.push(p);
      mag.push(a[i]);
    }
    if (ii.length < 3) return { pos: new Float64Array(0), pol: new Int8Array(0) };

    const cmax = rollingExtreme(profile, contrastWin, true);
    const cmin = rollingExtreme(profile, contrastWin, false);
    // Segment k lies between edge k and k+1 (a bar if pol[k] === +1).
    let ext = [];
    for (let k = 0; k < ii.length - 1; k++) {
      let e = pol[k] === 1 ? Infinity : -Infinity;
      for (let x = ii[k]; x <= ii[k + 1]; x++) e = pol[k] === 1 ? Math.min(e, profile[x]) : Math.max(e, profile[x]);
      ext.push(e);
    }
    let cvals = ii.map((i) => Math.max(cmax[i] - cmin[i], 1));

    const strength = (k) => {
      const m = ext.length;
      let best = null;
      for (const j of [k - 1, k + 1]) {
        if (j < 0 || j >= m) continue;
        if (best === null) best = ext[j];
        else best = pol[k] === 1 ? Math.max(best, ext[j]) : Math.min(best, ext[j]);
      }
      if (best === null) return 1e9;
      const s = pol[k] === 1 ? best - ext[k] : ext[k] - best;
      return s / cvals[k];
    };

    // Merge away the weakest segment until every one is a real element.
    while (ext.length >= 3) {
      let k = 0;
      let kStr = Infinity;
      for (let j = 0; j < ext.length; j++) {
        const s = strength(j);
        if (s < kStr) {
          kStr = s;
          k = j;
        }
      }
      if (kStr >= minSwing) break;
      const m = ext.length;
      if (k === 0) {
        ii.shift();
        pol.shift();
        cvals.shift();
        ext.shift();
      } else if (k === m - 1) {
        ii.pop();
        pol.pop();
        cvals.pop();
        ext.pop();
      } else {
        const merged = pol[k - 1] === 1 ? Math.min(ext[k - 1], ext[k + 1]) : Math.max(ext[k - 1], ext[k + 1]);
        ii.splice(k, 2);
        pol.splice(k, 2);
        cvals.splice(k, 2);
        ext.splice(k - 1, 3, merged);
      }
    }

    const pos = new Float64Array(ii.length);
    for (let q = 0; q < ii.length; q++) {
      const i = ii[q];
      if (i > 0 && i < n - 1) {
        const y0 = sameSignMag(i, i - 1);
        const y1 = a[i];
        const y2 = sameSignMag(i, i + 1);
        const den = y0 - 2 * y1 + y2;
        pos[q] = i + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0);
      } else pos[q] = i;
    }
    return { pos, pol: Int8Array.from(pol) };
  }

  // ------------------------------------------------------------ image
  function toGray(imageData) {
    const { data, width, height } = imageData;
    const out = new Float32Array(width * height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      // ITU-R 601 luma, same as PIL's convert("L")
      out[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    }
    return { data: out, width, height };
  }

  function bilinear(img, x, y) {
    const { data, width: w, height: h } = img;
    x = Math.min(Math.max(x, 0), w - 1.001);
    y = Math.min(Math.max(y, 0), h - 1.001);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    return (
      data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy
    );
  }

  function rowProfile(img, y) {
    // mean of rows y-1..y+1 (clamped at the top, like gray[max(0,y-1):y+2])
    const { data, width: w, height: h } = img;
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    const out = new Float32Array(w);
    for (let yy = y0; yy <= y1; yy++) {
      const off = yy * w;
      for (let x = 0; x < w; x++) out[x] += data[off + x];
    }
    const cnt = y1 - y0 + 1;
    for (let x = 0; x < w; x++) out[x] /= cnt;
    return out;
  }

  // ------------------------------------------------------------ detect
  function matchPattern(pos, i, ref, tol) {
    let s = 0;
    for (let k = 0; k < ref.length; k++) s += pos[i + k + 1] - pos[i + k];
    let refSum = 0;
    for (const r of ref) refSum += r;
    const m = s / refSum;
    for (let k = 0; k < ref.length; k++) {
      if (Math.abs((pos[i + k + 1] - pos[i + k]) / m - ref[k]) > tol) return null;
    }
    return m;
  }

  function lstsqLine(ys, xs, keep) {
    let n = 0;
    let sy = 0;
    let sx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < ys.length; i++) {
      if (!keep[i]) continue;
      n++;
      sy += ys[i];
      sx += xs[i];
      syy += ys[i] * ys[i];
      sxy += ys[i] * xs[i];
    }
    const den = n * syy - sy * sy;
    if (n < 2 || den === 0) return [0, n ? sx / n : 0];
    const a = (n * sxy - sy * sx) / den;
    return [a, (sx - a * sy) / n];
  }

  // least-squares x = a*y + b, refitted without points further off than
  // 2.5x the median residual (but never closer than minLimit)
  function robustLine(ys, xs, { iterations = 4, minLimit = 3 } = {}) {
    let keep = ys.map(() => true);
    let a = 0;
    let b = 0;
    for (let it = 0; it < iterations; it++) {
      [a, b] = lstsqLine(ys, xs, keep);
      const r = ys.map((y, i) => Math.abs(xs[i] - (a * y + b)));
      const lim = Math.max(minLimit, 2.5 * median(r.filter((_, i) => keep[i])));
      keep = r.map((v) => v < lim);
    }
    return { a, b, keep };
  }

  function barExtent(img, a, b, y0, y1) {
    const h = img.height;
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      const x = a * y + b;
      prof[y] = (bilinear(img, x, y) + bilinear(img, x - 2, y) + bilinear(img, x + 2, y)) / 3;
    }
    const yi0 = Math.floor(y0);
    const yi1 = Math.floor(y1);
    const dark = median(prof.subarray(yi0, yi1 + 1));
    const span = yi1 - yi0;
    const around = [
      ...prof.subarray(Math.max(0, yi0 - (span >> 1)), yi0),
      ...prof.subarray(yi1 + 1, yi1 + 1 + (span >> 1)),
    ];
    const bright = around.length ? percentile(around, 90) : dark + 100;
    const thr = (dark + bright) / 2;
    const walk = (y, step) => {
      let miss = 0;
      let last = y;
      while (y + step >= 0 && y + step < h) {
        y += step;
        if (prof[y] < thr) {
          last = y;
          miss = 0;
        } else if (++miss >= 4) break;
      }
      return last;
    };
    return [walk(yi0, -1), walk(yi1, 1)];
  }

  // When only one side's pattern reads (a card tilted toward the camera has
  // one end out of focus - the common real-world miss), find the other
  // side's *outer* boundary instead: the last bar edge before the quiet
  // zone, roughly MODULES modules away. Blur smears a pattern's thin
  // elements but not where the symbol ends. Returns entries shaped like
  // the pattern hits ([y, xLeft, xRight, module], unknown x = NaN).
  function inferOuterSide(rowEdges, anchors, side, w) {
    const out = [];
    for (const [y, xl, xr, m] of anchors) {
      const re = rowEdges.get(y);
      if (!re) continue;
      const { pos, pol } = re;
      const quiet = 8 * m;
      if (side === "right") {
        const lo = xl + 0.8 * MODULES * m;
        const hi = Math.min(w - 2, xl + 1.25 * MODULES * m);
        for (let i = 0; i < pos.length; i++) {
          if (pos[i] < lo || pos[i] > hi || pol[i] !== -1) continue;
          const next = i + 1 < pos.length ? pos[i + 1] : w; // image end counts only if the gap is real
          if (next - pos[i] >= quiet && pos[i] + quiet <= w) {
            out.push([y, NaN, pos[i], m]);
            break;
          }
        }
      } else {
        const lo = Math.max(1, xr - 1.25 * MODULES * m);
        const hi = xr - 0.8 * MODULES * m;
        for (let i = pos.length - 1; i >= 0; i--) {
          if (pos[i] < lo || pos[i] > hi || pol[i] !== 1) continue;
          const prev = i > 0 ? pos[i - 1] : 0;
          if (pos[i] - prev >= quiet && pos[i] - quiet >= 0) {
            out.push([y, pos[i], NaN, m]);
            break;
          }
        }
      }
    }
    return out;
  }

  // Returns {quad: {tl, tr, br, bl} as [x, y], module, inferred} or null.
  function detect(img, step = 8, tol = 0.7) {
    const { width: w, height: h } = img;
    let starts = []; // [y, xLeft, xEnd, module]
    let stops = [];
    const rowEdges = new Map();
    for (let y = 0; y < h; y += step) {
      const { pos, pol } = extractEdges(rowProfile(img, y));
      rowEdges.set(y, { pos, pol });
      const n = pos.length;
      for (let i = 0; i < n - 8; i++) {
        if (pol[i] !== 1) continue;
        const m = matchPattern(pos, i, START_W, tol);
        if (m !== null && m > 1.2) starts.push([y, pos[i], pos[i + 8], m]);
      }
      for (let i = 0; i < n - 9; i++) {
        if (pol[i] !== 1) continue;
        const m = matchPattern(pos, i, STOP_W, tol);
        if (m !== null && m > 1.2) stops.push([y, pos[i], pos[i + 9], m]);
      }
    }
    const nearMedian = (arr, k) => {
      if (!arr.length) return arr;
      const med = median(arr.map((s) => s[k]));
      return arr.filter((s) => Math.abs(s[k] - med) < 0.1 * w);
    };
    starts = nearMedian(starts, 1);
    stops = nearMedian(stops, 2);
    // how many scan lines matched each pattern, before any inference
    const patternHits = { start: starts.length, stop: stops.length };
    let inferred = null;
    if (starts.length >= 5 && stops.length < 5) {
      stops = nearMedian(inferOuterSide(rowEdges, starts, "right", w), 2);
      inferred = "stop";
    } else if (stops.length >= 5 && starts.length < 5) {
      starts = nearMedian(inferOuterSide(rowEdges, stops, "left", w), 1);
      inferred = "start";
    }
    if (starts.length < 5 || stops.length < 5) return null;
    const L = robustLine(starts.map((s) => s[0]), starts.map((s) => s[1]));
    const R = robustLine(stops.map((s) => s[0]), stops.map((s) => s[2]));
    starts = starts.filter((_, i) => L.keep[i]);
    stops = stops.filter((_, i) => R.keep[i]);
    if (!starts.length || !stops.length) return null;
    let ytopL = Math.min(...starts.map((s) => s[0]));
    let ybotL = Math.max(...starts.map((s) => s[0]));
    let ytopR = Math.min(...stops.map((s) => s[0]));
    let ybotR = Math.max(...stops.map((s) => s[0]));
    const mod = median([...starts.map((s) => s[3]), ...stops.map((s) => s[3])]);
    [ytopL, ybotL] = barExtent(img, L.a, L.b + 4.0 * mod, ytopL, ybotL);
    [ytopR, ybotR] = barExtent(img, R.a, R.b - 14.5 * mod, ytopR, ybotR);
    // Sanity: perspective changes the two sides' heights a little, not by
    // 2x; and the width must be ~MODULES modules. A quad failing this came
    // from stray pattern matches, and decoding it only produces misplaced
    // (confidently wrong) votes.
    const hL = ybotL - ytopL;
    const hR = ybotR - ytopR;
    const wMid = R.a * ((ytopR + ybotR) / 2) + R.b - (L.a * ((ytopL + ybotL) / 2) + L.b);
    if (hL <= 0 || hR <= 0 || Math.max(hL, hR) / Math.min(hL, hR) > 1.5) return null;
    if (wMid / MODULES < 0.6 * mod || wMid / MODULES > 1.6 * mod) return null;
    // left/right edges near-parallel: real frames (incl. strong
    // perspective) measured up to 0.18 difference in dx/dy, a bogus
    // inferred edge 0.48
    if (Math.abs(L.a - R.a) > 0.3) return null;
    return {
      quad: {
        tl: [L.a * ytopL + L.b, ytopL],
        bl: [L.a * ybotL + L.b, ybotL],
        tr: [R.a * ytopR + R.b, ytopR],
        br: [R.a * ybotR + R.b, ybotR],
      },
      module: mod,
      inferred,
      patternHits,
    };
  }

  // Diagnostics: focus at each end of the detected symbol. Brenner measure
  // (mean squared 2-pixel difference along the rows) over the outer 15% of
  // the symbol's length at each end, middle half of its height, divided by
  // that patch's contrast squared so uneven light doesn't count as blur.
  // Comparable between the two ends of one frame; ratio near 1 = evenly
  // focused, well below 1 = one end really is softer.
  function endSharpness(img, quad) {
    const { tl, tr, bl, br } = quad;
    const at = (u, v) => [
      tl[0] + (tr[0] - tl[0]) * u + (bl[0] + (br[0] - bl[0]) * u - (tl[0] + (tr[0] - tl[0]) * u)) * v,
      tl[1] + (tr[1] - tl[1]) * u + (bl[1] + (br[1] - bl[1]) * u - (tl[1] + (tr[1] - tl[1]) * u)) * v,
    ];
    const lengthPx = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const patch = (u0, u1) => {
      const vals = [];
      let sum = 0;
      let n = 0;
      const nu = Math.max(8, Math.round((u1 - u0) * lengthPx));
      for (let iv = 0; iv <= 12; iv++) {
        const v = 0.25 + (0.5 * iv) / 12;
        for (let iu = 0; iu <= nu; iu++) {
          const [x, y] = at(u0 + ((u1 - u0) * iu) / nu, v);
          const a = bilinear(img, x, y);
          const d = bilinear(img, x + 2, y) - a;
          vals.push(a);
          sum += d * d;
          n++;
        }
      }
      const contrast = Math.max(1, percentile(vals, 95) - percentile(vals, 5));
      return { brenner: Math.round(sum / n), contrast: Math.round(contrast), focus: +((sum / n) / (contrast * contrast)).toFixed(4) };
    };
    const left = patch(0.0, 0.15);
    const right = patch(0.85, 1.0);
    const ratio = +(Math.min(left.focus, right.focus) / Math.max(left.focus, right.focus, 1e-9)).toFixed(2);
    return { left, right, ratio, softer: ratio > 0.8 ? "neither" : left.focus < right.focus ? "left" : "right" };
  }

  // ------------------------------------------------------------ dewarp
  // Homography mapping rectified (u, v) -> image (x, y), from 4 point
  // pairs, with h33 = 1 (Gaussian elimination on the 8x8 system).
  function homography(src, dst) {
    const A = [];
    const bv = [];
    for (let k = 0; k < 4; k++) {
      const [x, y] = src[k];
      const [u, v] = dst[k];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      bv.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      bv.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      [bv[c], bv[piv]] = [bv[piv], bv[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        bv[r] -= f * bv[c];
      }
    }
    const hv = bv.map((v, i) => v / A[i][i]);
    return [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1];
  }

  function dewarp(img, quad, ppm = 4.0) {
    const W = Math.round((MODULES + 2 * MARGIN) * ppm);
    const m = MARGIN * ppm;
    const sw = MODULES * ppm; // the symbol's own width within W
    const H = Math.round(ROWS * 3 * ppm);
    const Hm = homography(
      [
        [m, 0],
        [m + sw, 0],
        [m + sw, H],
        [m, H],
      ],
      [quad.tl, quad.tr, quad.br, quad.bl]
    );
    const out = new Float32Array(W * H);
    for (let v = 0; v < H; v++) {
      const vv = v + 0.5;
      for (let u = 0; u < W; u++) {
        const uu = u + 0.5;
        const z = Hm[6] * uu + Hm[7] * vv + Hm[8];
        out[v * W + u] = bilinear(img, (Hm[0] * uu + Hm[1] * vv + Hm[2]) / z, (Hm[3] * uu + Hm[4] * vv + Hm[5]) / z);
      }
    }
    return { data: out, width: W, height: H };
  }

  // ------------------------------------------------------------ codewords
  // 9 edges (bar lead ... next codeword's bar lead) -> [cluster, value] | null
  function decodeCodeword(e) {
    const p = (e[8] - e[0]) / 17;
    if (p <= 0) return null;
    const t = [];
    for (let i = 0; i < 6; i++) {
      const v = Math.round((e[i + 2] - e[i]) / p);
      if (v < 2 || v > 9) return null;
      t.push(v);
    }
    const key = tKey(t);
    const wr = [];
    for (let i = 0; i < 8; i++) wr.push(Math.round((e[i + 1] - e[i]) / p));
    const k = ((((wr[0] - wr[2] + wr[4] - wr[6] + 9) % 9) + 9) % 9);
    if (k === 0 || k === 3 || k === 6) {
      const v = T_LOOKUP[k / 3].get(key);
      if (v !== undefined) return [k / 3, v];
    }
    // width rounding can misjudge the cluster; the t-tuple is the more
    // robust measurement - accept it if valid in exactly one cluster
    const hits = [];
    for (let c = 0; c < 3; c++) {
      const v = T_LOOKUP[c].get(key);
      if (v !== undefined) hits.push([c, v]);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  function nearestLead(pos, pol, x, maxDist) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < pos.length; i++) {
      if (pol[i] !== 1) continue;
      const d = Math.abs(pos[i] - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return bd <= maxDist ? best : -1;
  }

  // Row indicators carry fixed per-cluster remainders (value % 30): left =
  // rows/3, EC level + rows%3, columns-1; right = columns-1, rows/3, EC
  // level + rows%3 - for clusters 0, 3, 6. A chain that reads its end slot
  // as anything else is misaligned.
  const LRI_REM = [Math.floor((ROWS - 1) / 3), 6 * 3 + ((ROWS - 1) % 3), COLS - 1];
  const RRI_REM = [COLS - 1, Math.floor((ROWS - 1) / 3), 6 * 3 + ((ROWS - 1) % 3)];
  const validRI = (cv, rems) => !!cv && cv[1] % 30 === rems[cv[0]] && Math.floor(cv[1] / 30) <= Math.floor((ROWS - 1) / 3);

  // Index of the bar-leading edge where a start/stop pattern begins, found
  // by its width signature near the expected position (not just "nearest
  // edge" - a bent module grid can put a codeword's bar nearer than the
  // pattern's own first bar, which then misaligns a whole chain). -1 if no
  // matching pattern within maxDist.
  function findPattern(pos, pol, ref, x, maxDist, tol = 0.8) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i + ref.length < pos.length; i++) {
      if (pol[i] !== 1) continue;
      const d = Math.abs(pos[i] - x);
      if (d > maxDist || d >= bd) continue;
      if (matchPattern(pos, i, ref, tol) !== null) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // One rectified scan line -> Map(slot -> [cluster, value]); slot 0 =
  // left row indicator, 1..22 = data, 23 = right row indicator.
  function decodeScanline(prof, ppm) {
    const { pos, pol } = extractEdges(prof);
    const n = pos.length;
    const out = new Map();
    if (n < 20) return out;
    // anchors: LRI starts where the start pattern ends (8 edges on); RRI
    // ends where the stop pattern begins
    const m = MARGIN * ppm;
    const sIdx = findPattern(pos, pol, START_W, m, 4 * ppm);
    const tIdx = findPattern(pos, pol, STOP_W, m + (MODULES - 18) * ppm, 4 * ppm);

    // Lock: a chain starts locked (anchored on the start/stop pattern) and
    // stays locked while codewords keep decoding back to back. After a
    // miss, positions are only *predicted*, and a lone valid-looking
    // codeword there can be a misaligned misread (a confident wrong value
    // costs Reed-Solomon double an erasure) - so a hit while unlocked is
    // held as pending and only kept once the next codeword decodes starting
    // exactly where it ended (re-lock).
    // After a miss, advance by the *predicted* 17 modules rather than
    // snapping to whatever edge was nearby, so drift can't build up to a
    // whole codeword over a run of misses.
    // One chain across the line: rightwards from the start pattern (dir 1,
    // slots 0..COLS+1) or leftwards from the stop pattern (dir -1).
    const chain = (x, locked, dir) => {
      const found = new Map();
      let p = ppm;
      let pending = null;
      for (let k = 0; k < COLS + 2; k++) {
        const slot = dir > 0 ? k : COLS + 1 - k;
        const i = nearestLead(pos, pol, x, 2 * p);
        // the codeword's 9 edges, starting (dir 1) or ending (dir -1) at i
        const e =
          dir > 0
            ? i >= 0 && i + 8 < n && pol[i + 8] === 1 ? pos.subarray(i, i + 9) : null
            : i >= 8 && pol[i - 8] === 1 ? pos.subarray(i - 8, i + 1) : null;
        const width = e ? e[8] - e[0] : 0;
        const r = e && Math.abs(width - 17 * p) < 2.5 * p ? decodeCodeword(e) : null;
        if (r) {
          if (locked) found.set(slot, r);
          else if (pending) {
            found.set(pending[0], pending[1]);
            found.set(slot, r);
            locked = true;
            pending = null;
          } else pending = [slot, r];
          p = 0.7 * p + (0.3 * width) / 17;
          x = dir > 0 ? e[8] : e[0];
        } else {
          x += dir * 17 * p;
          locked = false;
          pending = null;
        }
      }
      return found;
    };
    const fwd = chain(sIdx >= 0 && sIdx + 8 < n ? pos[sIdx + 8] : m + 17 * ppm, sIdx >= 0, 1);
    const bwd = chain(tIdx >= 0 ? pos[tIdx] : m + (MODULES - 18) * ppm, tIdx >= 0, -1);

    // A chain counts only if its position is known: anchored on the
    // start/stop pattern, or confirmed by reading a valid row indicator in
    // its end slot - and never if that slot reads as something else.
    // Unanchored chains otherwise settle into a self-consistent but
    // shifted position (seen on real frames: whole lines 1-4 columns off).
    if (fwd.has(0) ? !validRI(fwd.get(0), LRI_REM) : sIdx < 0) fwd.clear();
    if (bwd.has(COLS + 1) ? !validRI(bwd.get(COLS + 1), RRI_REM) : tIdx < 0) bwd.clear();
    for (const slot of new Set([...fwd.keys(), ...bwd.keys()])) {
      const a = fwd.get(slot);
      const b = bwd.get(slot);
      if (a && b && (a[0] !== b[0] || a[1] !== b[1])) continue;
      out.set(slot, a || b);
    }
    return out;
  }

  // ------------------------------------------------------------ symbol
  // votes: Map(row * COLS + col -> Map(value -> count)), accumulated across
  // calls/frames. Returns stats.
  function readSymbol(rect, ppm, votes) {
    const h = rect.height;
    const stats = { lines: 0, ambiguousCluster: 0, unplaced: 0, orientation: null };
    const lines = [];
    for (let y = 1; y < h - 1; y++) {
      const cw = decodeScanline(rowProfile(rect, y), ppm);
      if (!cw.size) continue;
      const cc = [0, 0, 0];
      for (const [c] of cw.values()) cc[c]++;
      let cl = 0;
      for (let c = 1; c < 3; c++) if (cc[c] > cc[cl]) cl = c;
      if (cc[cl] < Math.max(3, 0.6 * cw.size)) {
        stats.ambiguousCluster++;
        continue;
      }
      const lri = cw.has(0) && cw.get(0)[0] === cl ? cw.get(0)[1] : null;
      const rri = cw.has(COLS + 1) && cw.get(COLS + 1)[0] === cl ? cw.get(COLS + 1)[1] : null;
      let rInd = null;
      const groups = [lri, rri].filter((v) => v !== null).map((v) => Math.floor(v / 30));
      if (groups.length) {
        // left indicator wins if the two disagree
        rInd = 3 * groups[0] + cl;
      }
      lines.push({ y, cl, rInd, cw });
    }

    const known = lines.filter((l) => l.rInd !== null && l.rInd >= 0 && l.rInd < ROWS);
    if (known.length < 4) return stats;
    const ys = known.map((l) => l.y);
    const rs = known.map((l) => l.rInd);
    const { a, b } = robustLine(ys, rs, { iterations: 3, minLimit: 1 });
    stats.orientation = a < 0 ? "mirrored" : "normal";
    for (const { y, cl, rInd, cw } of lines) {
      const est = a * y + b;
      let r;
      if (rInd !== null && Math.abs(rInd - est) <= 1.5) r = rInd;
      else {
        r = -1;
        let bd = Infinity;
        for (let rr = cl; rr < ROWS; rr += 3) {
          if (Math.abs(rr - est) < bd) {
            bd = Math.abs(rr - est);
            r = rr;
          }
        }
        if (bd > 1.0) {
          stats.unplaced++;
          continue;
        }
      }
      stats.lines++;
      for (const [slot, [ci, v]] of cw) {
        if (ci !== cl || slot === 0 || slot === COLS + 1) continue;
        const key = r * COLS + (slot - 1);
        let cnt = votes.get(key);
        if (!cnt) votes.set(key, (cnt = new Map()));
        cnt.set(v, (cnt.get(v) || 0) + 1);
      }
    }
    return stats;
  }

  // Top vote per cell; ties and empty cells -> null (an erasure).
  function votesToGrid(votes) {
    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const cnt = votes.get(r * COLS + c);
        if (!cnt) {
          row.push(null);
          continue;
        }
        let v1 = null;
        let n1 = 0;
        let n2 = 0;
        for (const [v, n] of cnt) {
          if (n > n1) {
            n2 = n1;
            n1 = n;
            v1 = v;
          } else if (n > n2) n2 = n;
        }
        row.push(n1 - n2 >= 1 ? v1 : null);
      }
      grid.push(row);
    }
    return grid;
  }

  // ------------------------------------------------------------ RS(929)
  // Errors-and-erasures decoding: known erasure locator folded into the
  // syndromes, Berlekamp-Massey for the unknown errors, Chien search +
  // Forney. Field parameters (generator 3, first consecutive root exponent
  // 1) were found empirically - the pair that makes every syndrome of a
  // pdf417gen-encoded codeword zero - and corrects exactly up to the
  // 2*errors + erasures <= 128 bound (tests/js/).
  const MOD = 929;
  const GEN = 3;
  const md = (x) => ((x % MOD) + MOD) % MOD;
  function powMod(b, e) {
    let r = 1;
    b = md(b);
    while (e > 0) {
      if (e & 1) r = (r * b) % MOD;
      b = (b * b) % MOD;
      e >>= 1;
    }
    return r;
  }
  const inv = (x) => powMod(x, MOD - 2);

  function polyEval(poly, x) {
    let v = 0;
    for (const c of poly) v = (v * x + c) % MOD;
    return v;
  }
  function syndromes(cw, ec) {
    const s = [];
    for (let i = 1; i <= ec; i++) s.push(polyEval(cw, powMod(GEN, i)));
    return s;
  }
  function polyMul(a, b) {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] = (r[i + j] + a[i] * b[j]) % MOD;
    return r;
  }
  function berlekampMassey(S) {
    const n = S.length;
    let C = [1, ...new Array(n).fill(0)];
    let B = [1, ...new Array(n).fill(0)];
    let L = 0;
    let m = 1;
    let bb = 1;
    for (let i = 0; i < n; i++) {
      let delta = S[i];
      for (let j = 1; j <= L; j++) delta = (delta + C[j] * S[i - j]) % MOD;
      if (delta === 0) m++;
      else if (2 * L <= i) {
        const T = C.slice();
        const coef = (delta * inv(bb)) % MOD;
        for (let j = 0; j < B.length; j++) if (m + j < C.length) C[m + j] = md(C[m + j] - coef * B[j]);
        L = i + 1 - L;
        B = T;
        bb = delta;
        m = 1;
      } else {
        const coef = (delta * inv(bb)) % MOD;
        for (let j = 0; j < B.length; j++) if (m + j < C.length) C[m + j] = md(C[m + j] - coef * B[j]);
        m++;
      }
    }
    return [C.slice(0, L + 1), L];
  }
  function chienSearch(lam, n) {
    const errs = [];
    for (let j = 0; j < n; j++) {
      const x = inv(powMod(GEN, j));
      let v = 0;
      let pw = 1;
      for (const c of lam) {
        v = (v + c * pw) % MOD;
        pw = (pw * x) % MOD;
      }
      if (v === 0) errs.push(j);
    }
    return errs;
  }
  function forney(S, lam, positions) {
    const omega = polyMul(S, lam).slice(0, S.length);
    const lamD = lam.map((c, i) => (i * c) % MOD).slice(1);
    const mags = new Map();
    for (const j of positions) {
      const xi = inv(powMod(GEN, j));
      let ov = 0;
      let pw = 1;
      for (const c of omega) {
        ov = (ov + c * pw) % MOD;
        pw = (pw * xi) % MOD;
      }
      let dv = 0;
      pw = 1;
      for (const c of lamD) {
        dv = (dv + c * pw) % MOD;
        pw = (pw * xi) % MOD;
      }
      if (dv === 0) return null;
      mags.set(j, md(-ov * inv(dv)));
    }
    return mags;
  }
  // Returns corrected codewords, or null if uncorrectable.
  // A correction must leave RS_MARGIN syndromes unused, as checks. At the
  // exact budget (2*errors + erasures = ec) the equations are exactly
  // determined, so a wrong correction always looks consistent: with ~127
  // erasures and 1-2 misreads (a normal accumulated-vote state just before
  // a real decode) it returned wrong bytes as success most of the time.
  // Each spare syndrome makes a false acceptance ~929x less likely.
  const RS_MARGIN = 8;

  function rsDecode(cw, ec, erasurePositions = []) {
    const n = cw.length;
    const eFromEnd = erasurePositions.map((i) => n - 1 - i);
    const S = syndromes(cw, ec);
    if (!eFromEnd.length && S.every((v) => v === 0)) return cw.slice();
    if (eFromEnd.length > ec - RS_MARGIN) return null;
    let gamma = [1];
    for (const j of eFromEnd) gamma = polyMul(gamma, [1, md(-powMod(GEN, j))]);
    const modified = polyMul(gamma, S).slice(eFromEnd.length, ec);
    const [sigma, numErr] = berlekampMassey(modified);
    if (eFromEnd.length + 2 * numErr > ec - RS_MARGIN) return null;
    const lam = polyMul(gamma, sigma);
    const total = eFromEnd.length + numErr;
    const positions = chienSearch(lam, n);
    if (positions.length !== total) return null;
    const mags = forney(S, lam, positions);
    if (!mags) return null;
    const out = cw.slice();
    for (const [j, mag] of mags) out[n - 1 - j] = md(out[n - 1 - j] - mag);
    if (!syndromes(out, ec).every((v) => v === 0)) return null;
    return out;
  }

  // ------------------------------------------------------------ payload
  // Grid (ROWS x COLS, null = erasure) -> Uint8Array(720) | null.
  function decodeGrid(grid) {
    const cw = [];
    const erasures = [];
    for (const row of grid)
      for (const c of row) {
        if (c === null) erasures.push(cw.length);
        cw.push(c === null ? 0 : c);
      }
    if (cw.length !== ROWS * COLS) return null;
    const corrected = rsDecode(cw, EC_COUNT, erasures);
    if (!corrected) return null;
    const expectedLength = ROWS * COLS - EC_COUNT; // length descriptor counts itself + data + padding
    if (corrected[0] !== expectedLength) return null;
    const msg = corrected.slice(1, 1 + DATA_WORD_COUNT);
    if (msg[0] !== BYTE_COMPACTION_LATCH) return null;
    // Structure checks a miscorrection rarely passes: the padding codewords
    // are always 900, byte-compaction codewords always < 900, and each
    // 5-codeword group encodes exactly 6 bytes (< 256^6).
    for (let i = 1 + DATA_WORD_COUNT; i < expectedLength; i++) if (corrected[i] !== 900) return null;
    for (let i = 1; i < msg.length; i++) if (msg[i] >= 900) return null;
    const out = new Uint8Array(RAW_PAYLOAD_LENGTH);
    let o = 0;
    for (let i = 1; i < msg.length; i += 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 900 + msg[i + k]; // < 900^5 < 2^53
      if (v >= 2 ** 48) return null;
      for (let k = 5; k >= 0; k--) {
        out[o + k] = v % 256;
        v = Math.floor(v / 256);
      }
      o += 6;
    }
    return o === RAW_PAYLOAD_LENGTH ? out : null;
  }

  // ------------------------------------------------------------ frame API
  // One frame (ImageData, or {data: Float32Array gray, width, height})
  // through the whole pipeline, voting into `votes` (pass the same Map
  // for every frame of a scan session). Returns {bytes, detected, stats}.
  function decodeFrame(frame, votes = new Map(), ppm = 4.0) {
    const t0 = Date.now();
    let img = frame.data instanceof Float32Array ? frame : toGray(frame);
    let det = detect(img);
    let rotated180 = false;
    if (!det) {
      // card held the other way round: the detector expects the start
      // pattern on the left, so try the frame turned 180 degrees
      const flipped = { data: img.data.slice().reverse(), width: img.width, height: img.height };
      det = detect(flipped);
      if (det) {
        img = flipped;
        rotated180 = true;
      }
    }
    if (!det) return { bytes: null, detected: false, votes, ms: Date.now() - t0 };
    const rect = dewarp(img, det.quad, ppm);
    const frameVotes = new Map();
    const stats = readSymbol(rect, ppm, frameVotes);
    // merge this frame's votes into the session's
    for (const [k, cnt] of frameVotes) {
      let tgt = votes.get(k);
      if (!tgt) votes.set(k, (tgt = new Map()));
      for (const [v, n] of cnt) tgt.set(v, (tgt.get(v) || 0) + n);
    }
    // this frame alone first (a clean frame shouldn't be outvoted by
    // earlier blurry ones), then everything accumulated so far
    let bytes = decodeGrid(votesToGrid(frameVotes));
    let source = "frame";
    if (!bytes) {
      bytes = decodeGrid(votesToGrid(votes));
      source = "accumulated";
    }
    let filled = 0;
    for (const row of votesToGrid(frameVotes)) for (const c of row) if (c !== null) filled++;
    return {
      bytes,
      source: bytes ? source : null,
      detected: true,
      quad: det.quad,
      rotated180,
      // symbol length along the scan direction, as a fraction of the
      // frame width - lets the UI tell the user to back off when the
      // barcode overflows the viewfinder
      widthFraction: (Math.max(det.quad.tr[0], det.quad.br[0]) - Math.min(det.quad.tl[0], det.quad.bl[0])) / img.width,
      inferred: det.inferred,
      patternHits: det.patternHits,
      endSharpness: endSharpness(img, det.quad),
      modulePx: det.module,
      cellsFilled: filled,
      stats,
      votes,
      ms: Date.now() - t0,
    };
  }

  const api = {
    COLS,
    ROWS,
    MODULES,
    extractEdges,
    toGray,
    detect,
    dewarp,
    decodeScanline,
    readSymbol,
    votesToGrid,
    rsDecode,
    decodeGrid,
    decodeFrame,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PDF417Edge = api;
})(typeof self !== "undefined" ? self : this);

// node --test tests/js/*.test.js
//
// web/scan-hints.js: which live hint a decoded-but-unread frame gets. The
// cases are real decoder outputs (a MacBook webcam session, the synthetic
// fixture scaled and blurred), trimmed to the fields the rules read.
const test = require("node:test");
const assert = require("node:assert");

const ScanHints = require("../../web/scan-hints.js");

const BOX = { boxFraction: 1 / 1.24 };
const hint = (r) => ScanHints.forResult({ detected: true, widthFraction: 0.75, ...r }, BOX)[0];
const ends = (ratio, softer) => ({ ratio, softer });

test("barcode overflowing the box: further back, before anything else", () => {
  assert.strictEqual(hint({ widthFraction: 0.95, modulePx: 1.8, inferred: "start", endSharpness: ends(0.2, "left") }), "Move a little further back");
});

test("too small with both ends equally sharp: closer, not 'hold flat' (webcam, 1.73 px/module)", () => {
  assert.strictEqual(hint({ modulePx: 1.73, inferred: "start", endSharpness: ends(0.89, "neither") }), "Move a little closer");
  // only mildly softer at that size: still a size problem
  assert.strictEqual(hint({ modulePx: 1.73, inferred: "start", endSharpness: ends(0.64, "left") }), "Move a little closer");
});

test("box filled by a tilted card, just under 2.2 px/module, one end clearly soft: hold flat, not closer", () => {
  assert.strictEqual(hint({ modulePx: 2.15, inferred: "stop", endSharpness: ends(0.2, "right") }), "Hold the card flat");
});

test("big enough and the unmatched end softer: hold flat (webcam, 2.3 px/module)", () => {
  assert.strictEqual(hint({ modulePx: 2.31, inferred: "start", endSharpness: ends(0.57, "left") }), "Hold the card flat");
});

test("the softer end is the one whose pattern did match: not a focus problem", () => {
  assert.strictEqual(hint({ modulePx: 2.31, inferred: "start", endSharpness: ends(0.4, "right") }), "Hold steady…");
  assert.strictEqual(hint({ modulePx: 2.0, inferred: "stop", endSharpness: ends(0.3, "left") }), "Move a little closer");
});

test("both patterns found, or no sharpness measured: size, then steady", () => {
  assert.strictEqual(hint({ modulePx: 2.6, inferred: null, endSharpness: ends(0.3, "left") }), "Hold steady…");
  assert.strictEqual(hint({ modulePx: 2.6, inferred: "start", endSharpness: null }), "Hold steady…");
  assert.strictEqual(hint({ modulePx: 2.0, inferred: null, endSharpness: null }), "Move a little closer");
});

// The scanner's live hint for one decoded-but-unread frame, from what the
// decoder saw (pdf417-edge.js decodeFrame / pdf417-worker.js). Pure, so
// tests/js/scan-hints.test.js can check the order of the rules.
//
//   ScanHints.forResult(r, { boxFraction }) -> [hint, subhint]
//
// boxFraction: the viewfinder box's share of the decoded crop's length.
(function (root) {
  "use strict";

  const MIN_MODULE_PX = 2.2; // below this the reader struggles: "closer"
  const CLEARLY_SOFT = 0.5; // end-sharpness ratio that outranks "closer"
  const SOFT = 0.7; // end-sharpness ratio that counts as one soft end

  // Is the end whose pattern didn't match (r.inferred) measurably softer?
  // Left/right are in the decoder's frame, where left is the start pattern.
  function unmatchedEndSoft(r, ratioBelow) {
    const s = r.endSharpness;
    if (!r.inferred || !s) return false;
    return s.ratio < ratioBelow && s.softer === (r.inferred === "start" ? "left" : "right");
  }

  function forResult(r, { boxFraction }) {
    if (r.widthFraction && r.widthFraction > boxFraction * 1.1) {
      return ["Move a little further back", "The whole barcode must fit inside the box"];
    }
    // A clearly soft end first: a box filled by a tilted card can measure
    // just under MIN_MODULE_PX (from its far, sharp end), and "closer" would
    // only make the near end softer and flip to "further back".
    if (unmatchedEndSoft(r, CLEARLY_SOFT)) return holdFlat();
    // Then size: below ~2.2 px/module the start pattern's run of thin bars
    // blurs into grey, so only one end's pattern matches even with the card
    // perfectly flat - and both ends measure about equally sharp.
    if (r.modulePx && r.modulePx < MIN_MODULE_PX) return ["Move a little closer", "Make the barcode fill the box"];
    if (unmatchedEndSoft(r, SOFT)) return holdFlat();
    return ["Hold steady…", "Reading the barcode"];
  }

  const holdFlat = () => ["Hold the card flat", "One end of the barcode is out of focus – face it straight at the camera"];

  const api = { forResult, MIN_MODULE_PX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScanHints = api;
})(typeof self !== "undefined" ? self : this);

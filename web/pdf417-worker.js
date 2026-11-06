// Runs the edge-based PDF417 decoder (pdf417-edge.js) off the main thread,
// so a few hundred ms of decoding per frame never stalls the camera
// preview. Holds the scan session's accumulated codeword votes: every
// frame votes into them, so regions blurred in one frame get filled in by
// another. Messages:
//   {type: "reset"}                       start a new scan session
//   {type: "frame", id, imageData}        decode one frame
// Replies {id, bytes (Uint8Array|null), ...diagnostics} per frame.
importScripts("pdf417-codes.js", "pdf417-edge.js");

let votes = new Map();

function filledCells(v) {
  let n = 0;
  for (const row of PDF417Edge.votesToGrid(v)) for (const c of row) if (c !== null) n++;
  return n;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "reset") {
    votes = new Map();
    return;
  }
  if (m.type !== "frame") return;
  try {
    const r = PDF417Edge.decodeFrame(m.imageData, votes);
    self.postMessage({
      id: m.id,
      bytes: r.bytes,
      source: r.source,
      detected: r.detected,
      quad: r.quad || null,
      rotated180: !!r.rotated180,
      widthFraction: r.widthFraction ?? null,
      inferred: r.inferred ?? null,
      patternHits: r.patternHits || null,
      endSharpness: r.endSharpness || null,
      modulePx: r.modulePx ?? null,
      cellsFilled: r.cellsFilled ?? 0,
      accumulatedCells: filledCells(votes),
      stats: r.stats || null,
      ms: r.ms,
    });
  } catch (err) {
    self.postMessage({ id: m.id, bytes: null, detected: false, error: String((err && err.stack) || err) });
  }
};

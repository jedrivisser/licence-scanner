// Licence barcode wallet: scan your licence once, then the app opens
// straight to its barcode, full screen. It's a convenience, not a licence:
// the page says so before the first scan. The raw 720 barcode bytes are kept
// in this browser's storage only (the bin button removes them); the symbol is
// re-encoded on the fly (pdf417-encode.js) exactly as printed on the card,
// and decoded on the device (sadl.js) for the caption. Works offline.
(() => {
  const STORE_KEY = "sadl-show-licence";
  const QUIET = 4; // modules of white around the symbol
  // modules per row, as printed on the card: 34 rows x 3 = 102 modules high
  // by 443 wide, the card's ~4.3:1 (taller rows looked unlike a licence)
  const ROW_HEIGHT = 3;

  const empty = document.getElementById("empty");
  const display = document.getElementById("display");
  const canvas = document.getElementById("barcode");
  const caption = document.getElementById("caption");
  const scanBtn = document.getElementById("scan-btn");
  const rescanBtn = document.getElementById("rescan-btn");
  const copyBtn = document.getElementById("copy-btn");
  const removeBtn = document.getElementById("remove-btn");
  const statusEl = document.getElementById("status");

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js").catch(() => {});

  // ------------------------------------------------------------ storage
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!v || !v.b64) return null;
      const bin = atob(v.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length !== PDF417Encode.PAYLOAD_LENGTH) return null; // not ours: start over
      return { bytes, licence: licenceOf(bytes) };
    } catch (err) {
      return null;
    }
  }
  function save(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    localStorage.setItem(STORE_KEY, JSON.stringify({ b64: btoa(bin), savedAt: new Date().toISOString() }));
    // ask the browser not to evict it under storage pressure
    navigator.storage?.persist?.().catch(() => {});
  }

  function licenceOf(bytes) {
    try {
      return SADL.decode(bytes);
    } catch (err) {
      return null;
    }
  }

  // ------------------------------------------------------------ render
  let current = null;
  let matrix = null;

  function render() {
    if (!matrix) return;
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const portrait = vh > vw;
    // keep clear of the buttons and caption (CSS px), then use the rest
    const longAvail = ((portrait ? vh : vw) - 2 * 64) * dpr;
    const shortAvail = ((portrait ? vw : vh) - 2 * 24) * dpr;
    const W = matrix[0].length + 2 * QUIET; // modules along the rows
    const H = matrix.length * ROW_HEIGHT + 2 * QUIET; // modules across
    // whole device pixels per module: crisp edges, no resampling blur
    const m = Math.max(1, Math.floor(Math.min(longAvail / W, shortAvail / H)));
    const cw = (portrait ? H : W) * m;
    const ch = (portrait ? W : H) * m;
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${cw / dpr}px`;
    canvas.style.height = `${ch / dpr}px`;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#000";
    matrix.forEach((bits, r) => {
      const y0 = QUIET + r * ROW_HEIGHT;
      // runs of bars per row: fewer, larger rects
      for (let x = 0; x < bits.length; ) {
        if (!bits[x]) {
          x++;
          continue;
        }
        let x1 = x;
        while (x1 < bits.length && bits[x1]) x1++;
        const sx = QUIET + x;
        const len = x1 - x;
        if (portrait) {
          // rotated 90 degrees clockwise: symbol x runs down, rows run right-to-left
          ctx.fillRect((H - y0 - ROW_HEIGHT) * m, sx * m, ROW_HEIGHT * m, len * m);
        } else {
          ctx.fillRect(sx * m, y0 * m, len * m, ROW_HEIGHT * m);
        }
        x = x1;
      }
    });
  }

  function captionText(l) {
    if (!l) return "";
    const name = [l.initials, l.surname].filter(Boolean).join(" ");
    const validity = SADL.checkToday(l, SADL.localDate()).includes("expired") ? `EXPIRED ${l.valid_to}` : l.valid_to && `valid to ${l.valid_to}`;
    return [name, l.licence_number, validity].filter(Boolean).join(" · ");
  }

  function show() {
    current = load();
    if (!current) {
      matrix = null;
      display.classList.add("hidden");
      empty.classList.remove("hidden");
      releaseWakeLock();
      return;
    }
    matrix = PDF417Encode.encodeMatrix(current.bytes);
    caption.textContent = captionText(current.licence);
    empty.classList.add("hidden");
    display.classList.remove("hidden");
    render();
    requestWakeLock();
  }

  window.addEventListener("resize", render);

  // ------------------------------------------------------------ wake lock
  // keep the screen on while the barcode is up
  let wakeLock = null;
  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (err) {
      // not allowed (e.g. battery saver) - the barcode still shows
    }
  }
  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && matrix) requestWakeLock();
  });

  // ------------------------------------------------------------ scanning
  // Bytes come out of the scanner already Reed-Solomon-verified; decoding
  // them as a licence (RSA block markers, layout) confirms it's a licence
  // card before it replaces the stored one.
  function onBytes(bytes) {
    try {
      SADL.decode(bytes);
    } catch (err) {
      notify(`That barcode isn't a readable licence (${err.reason || err.message || err})`);
      return;
    }
    try {
      save(bytes);
    } catch (err) {
      notify("Couldn't store the licence: this browser's storage is full or turned off.");
      return;
    }
    statusEl.textContent = "";
    show();
  }

  // Messages go to the start screen's status line, or - when a barcode is
  // showing (that screen is hidden) - briefly into the caption under it.
  let captionTimer = null;
  function notify(msg) {
    statusEl.textContent = msg;
    if (!current) return;
    caption.textContent = msg;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => (caption.textContent = captionText(current.licence)), 5000);
  }

  async function scan() {
    statusEl.textContent = "";
    releaseWakeLock();
    try {
      const returnFocus = () => (matrix ? rescanBtn : scanBtn);
      if (!(await LicenceScanner.open({ onBytes, returnFocus })) && matrix) requestWakeLock(); // already open/opening
    } catch (err) {
      notify(`Camera unavailable: ${err.name || ""} ${err.message || err}`);
      if (matrix) requestWakeLock(); // the barcode is back on screen
    }
  }

  // ?debug=1: a button that copies the stored 720 barcode bytes as hex, to
  // reproduce a scan offline (pdf417-edge.js, sadl.js) with the real data.
  if (new URLSearchParams(location.search).has("debug")) {
    copyBtn.classList.remove("hidden");
    copyBtn.addEventListener("click", async () => {
      if (!current) return;
      const hex = Array.from(current.bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      try {
        await navigator.clipboard.writeText(hex);
        notify(`Copied the barcode data (${current.bytes.length} bytes, hex)`);
      } catch (err) {
        window.prompt("Copy the barcode data:", hex); // clipboard blocked: copy by hand
      }
    });
  }

  removeBtn.addEventListener("click", () => {
    if (!window.confirm("Remove the stored licence from this phone?")) return;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (err) {
      // storage turned off: nothing was stored either
    }
    show();
    scanBtn.focus();
  });

  scanBtn.addEventListener("click", scan);
  // X: scan a different licence - the stored one stays until a new scan
  // succeeds, so closing the scanner just brings it back
  rescanBtn.addEventListener("click", scan);
  window.addEventListener("popstate", () => {
    if (matrix) requestWakeLock();
  });

  show();
})();

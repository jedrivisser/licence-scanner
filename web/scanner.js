// Full-screen licence barcode scanner, shared by the scanner app (scan/) and
// the barcode wallet (show/). Builds its own overlay; usage:
//
//   LicenceScanner.open({ onBytes: async (bytes, imageData) => {...}, returnFocus })
//
// onBytes gets the decoded 720 raw barcode bytes; the scanner closes once it
// returns (or resolves). open() rejects if the camera can't be opened.
// returnFocus (an element, or a function returning one) gets the keyboard
// focus back when the scanner closes. Needs camera-pick.js, scan-hints.js,
// pdf417-worker.js (decoder) and scanner.css.
(() => {
  // The pages live one level down (scan/, show/); resolve the worker next
  // to this script so it works under any base path (e.g. GitHub Pages).
  const WORKER_URL = new URL("pdf417-worker.js", document.currentScript.src).href;
  const PARAMS = new URLSearchParams(location.search);
  const DEBUG = PARAMS.has("debug");
  // ?debug=1&camera=ultra: use the first camera whose label contains "ultra",
  // to compare a phone's lenses (see "Help wanted" in the README). Not saved.
  const FORCE_CAMERA = DEBUG ? (PARAMS.get("camera") || "").toLowerCase() : "";

  // ------------------------------------------------------------ overlay
  const root = document.createElement("div");
  root.className = "scanner hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Barcode scanner");
  root.innerHTML = `
    <video autoplay muted playsinline></video>
    <div class="viewfinder">
      <span class="corner tl"></span><span class="corner tr"></span>
      <span class="corner bl"></span><span class="corner br"></span>
      <div class="progress"><div class="progress-bar"></div></div>
    </div>
    <div class="scanner-top">
      <button class="round close-btn" aria-label="Close scanner">&#x2715;</button>
      <button class="round save-btn hidden" aria-label="Save the last decoded frame">&#x1F4BE;</button>
      <button class="round torch-btn hidden" aria-label="Torch">&#x1F526;</button>
    </div>
    <div class="scanner-bottom">
      <p class="notice hidden">This camera probably can't focus close enough to read a licence (a laptop webcam?). Use a phone's back camera.</p>
      <p class="hint" role="status"></p>
      <p class="subhint"></p>
    </div>
    <pre class="debug hidden"></pre>`;
  const $ = (sel) => root.querySelector(sel);
  const video = $("video");
  const viewfinder = $(".viewfinder");
  const progressBar = $(".progress-bar");
  const closeBtn = $(".close-btn");
  const torchBtn = $(".torch-btn");
  const hintEl = $(".hint");
  const subhintEl = $(".subhint");
  const noticeEl = $(".notice");
  const debugEl = $(".debug");
  const saveBtn = $(".save-btn");
  if (DEBUG) {
    debugEl.classList.remove("hidden");
    saveBtn.classList.remove("hidden");
  }
  const attach = () => document.body.appendChild(root);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);

  let mediaStream = null;
  let torchOn = false;
  let onBytesCb = null;

  // ---------------------------------------------------------------- camera
  //
  // Which camera: see camera-pick.js. The choice is remembered per browser.
  // With no back camera at all (a laptop), the browser's default camera is
  // used.
  const CAMERA_KEY = "sadl-main-back-camera";
  // ~1920px on the long side, a real sensor mode (no browser crop/scale):
  // the decoder reads down to ~2.2 px/module, so this is plenty, at a
  // much higher, cheaper frame rate than the sensor maximum.
  const SIZE = { width: { ideal: 1920 }, height: { ideal: 1920 }, resizeMode: "none" };

  function storageGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (err) {
      return null;
    }
  }
  function storageSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (err) {
      // per-browser convenience only
    }
  }

  async function pickMainBackCamera() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      return CameraPick.chooseMainBackCamera(
        devices.map((d) => {
          let capabilities = {};
          try {
            capabilities = (d.getCapabilities && d.getCapabilities()) || {};
          } catch (err) {
            capabilities = {};
          }
          return { deviceId: d.deviceId, label: d.label, capabilities };
        })
      );
    } catch (err) {
      return null;
    }
  }

  async function openBackCamera() {
    const saved = storageGet(CAMERA_KEY);
    if (saved && !FORCE_CAMERA) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: saved }, ...SIZE } });
      } catch (err) {
        // gone or busy - pick again below
      }
    }
    // Labels/capabilities are only populated once permission is granted,
    // so open *a* back camera first, then switch if it isn't the main one.
    let stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, ...SIZE } });
    if (FORCE_CAMERA) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const forced = devices.find((d) => d.kind === "videoinput" && d.label.toLowerCase().includes(FORCE_CAMERA));
      if (!forced) return stream; // the overlay's first line shows which camera this is
      stream.getTracks().forEach((t) => t.stop());
      return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: forced.deviceId }, ...SIZE } });
    }
    const best = await pickMainBackCamera();
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (best && best !== current) {
      stream.getTracks().forEach((t) => t.stop());
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: best }, ...SIZE } });
      } catch (err) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, ...SIZE } });
      }
    }
    const id = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (id) storageSet(CAMERA_KEY, id);
    return stream;
  }

  // Logged to the console each time the scanner opens: every camera the
  // browser lists with what it can do, which one was picked, and what the
  // stream really delivers. For tuning camera choice and the preview on
  // devices we haven't tried (e.g. a laptop webcam). No frames; camera
  // labels can include a device name (e.g. an iPhone used as a webcam).
  async function logCameraInfo() {
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
    const CAP_KEYS = ["facingMode", "focusMode", "width", "height", "frameRate", "resizeMode", "torch", "zoom"];
    const info = { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio, cameras: [] };
    try {
      for (const d of await navigator.mediaDevices.enumerateDevices()) {
        if (d.kind !== "videoinput") continue;
        let caps = null;
        try {
          caps = d.getCapabilities ? pick(d.getCapabilities(), CAP_KEYS) : "getCapabilities not supported";
        } catch (err) {
          caps = `error: ${err.message}`;
        }
        info.cameras.push({ label: d.label, deviceId: d.deviceId.slice(0, 8), capabilities: caps });
      }
      const track = mediaStream?.getVideoTracks()[0];
      info.picked = {
        label: track?.label,
        settings: pick(track?.getSettings?.(), ["deviceId", "facingMode", "width", "height", "frameRate", "resizeMode", "aspectRatio"]),
        capabilities: track?.getCapabilities ? pick(track.getCapabilities(), CAP_KEYS) : "getCapabilities not supported",
      };
      if (info.picked.settings.deviceId) info.picked.settings.deviceId = info.picked.settings.deviceId.slice(0, 8);
      info.video = {
        width: video.videoWidth,
        height: video.videoHeight,
        boxPortrait,
        mirrored: video.classList.contains("mirrored"),
        focusWarning: !noticeEl.classList.contains("hidden"),
      };
      info.savedCamera = storageGet(CAMERA_KEY)?.slice(0, 8) || null;
    } catch (err) {
      info.error = String(err);
    }
    console.info("[scanner] camera info (copy the JSON line below):", info);
    console.info(JSON.stringify(info));
  }

  // ?debug=1: the camera in use and every camera the browser offers, at the
  // top of the overlay from the start - their names are what &camera= matches.
  let debugCameras = "";
  async function showCameras() {
    let names = [];
    try {
      names = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").map((d) => d.label || "(unnamed)");
    } catch (err) {
      names = [`(can't list: ${err.message || err})`];
    }
    debugCameras =
      `camera: ${mediaStream?.getVideoTracks()[0]?.label || "?"} ${video.videoWidth}x${video.videoHeight}\n` +
      `all cameras: ${names.join(" | ")}\n`;
    debugEl.textContent = debugCameras;
  }

  // A camera facing the user (a laptop webcam, which reports no facing
  // mode at all) shows a mirrored preview, like a mirror or a video call:
  // unmirrored, moving the card left moves it right on screen. Only the
  // preview flips - the decoder still reads the camera's own pixels, and the
  // box is centred, so the area it reads is the same either way.
  function isBackCamera(track) {
    const settings = track?.getSettings?.() || {};
    let caps = {};
    try {
      caps = track?.getCapabilities?.() || {};
    } catch (err) {
      caps = {};
    }
    return (
      settings.facingMode === "environment" ||
      (caps.facingMode || []).includes("environment") ||
      /back|rear|environment/i.test(track?.label || "")
    );
  }

  // Reading a licence needs ~2.2+ px/module across the whole barcode, so the
  // card is held close - closer than a fixed-focus laptop webcam focuses
  // (measured on a MacBook's FaceTime HD camera: never decodes - held where
  // it focuses the barcode is ~1.7 px/module; closer, it blurs). Warn, but
  // keep scanning, for a camera that is neither back-facing nor reports
  // continuous autofocus: phone back cameras say
  // facingMode "environment"; that MacBook webcam reports neither. Chrome on
  // macOS may report focus modes for no camera at all, so an iPhone used as
  // the Mac's webcam (Continuity Camera, which does autofocus) is recognised
  // by name instead; another autofocus webcam on a Mac may still get the
  // (harmless) warning.
  function likelyCantFocusClose(track) {
    let caps = {};
    try {
      caps = track?.getCapabilities?.() || {};
    } catch (err) {
      caps = {};
    }
    if (/iphone|ipad|continuity/i.test(track?.label || "")) return false;
    return !isBackCamera(track) && !(caps.focusMode || []).includes("continuous");
  }

  // ------------------------------------------------------------ open/close
  // Resolves true once the scanner is open, false if one is already open or
  // opening (a second tap while the camera is still starting would
  // otherwise open a second stream that close() never stops).
  let opening = false;
  let returnFocusTo = null;
  let pendingBegin = null; // the loadedmetadata listener, removed if closed first
  async function open({ onBytes, returnFocus = null }) {
    if (opening || !root.classList.contains("hidden")) return false;
    opening = true;
    try {
      onBytesCb = onBytes;
      returnFocusTo = returnFocus;
      mediaStream = await openBackCamera(); // rejects -> caller shows the error
    } finally {
      opening = false;
    }
    // the camera taken away (another app, a call, unplugged): nothing more
    // will arrive, so close rather than show a frozen preview
    const stream = mediaStream;
    for (const t of stream.getTracks()) t.addEventListener("ended", () => mediaStream === stream && close());
    video.srcObject = mediaStream;
    video.classList.toggle("mirrored", !isBackCamera(mediaStream.getVideoTracks()[0]));
    noticeEl.classList.toggle("hidden", !likelyCantFocusClose(mediaStream.getVideoTracks()[0]));
    root.classList.remove("hidden");
    document.documentElement.classList.add("scanner-open");
    viewfinder.classList.remove("seen");
    progressBar.style.width = "0";
    setupTorch();
    closeBtn.focus();
    // Android back button closes the scanner instead of leaving the page.
    history.pushState({ scanner: true }, "");
    try {
      await root.requestFullscreen?.({ navigationUI: "hide" });
    } catch (err) {
      // fine without - the scanner is already a fixed full-viewport layer
    }
    const begin = () => {
      pendingBegin = null;
      layoutViewfinder();
      setHint(
        "Fit the barcode inside the box",
        boxPortrait
          ? "Turn the card so the barcode runs top to bottom – hold it flat, a hand-span away"
          : "Hold the card flat, about a hand-span away – not closer"
      );
      startLiveScan();
      logCameraInfo();
      if (DEBUG) showCameras();
    };
    if (video.readyState >= 1 && video.videoWidth) begin();
    else {
      pendingBegin = begin;
      video.addEventListener("loadedmetadata", begin, { once: true });
    }
    return true;
  }

  function close(fromPopState = false) {
    if (root.classList.contains("hidden")) return;
    stopLiveScan();
    if (pendingBegin) {
      video.removeEventListener("loadedmetadata", pendingBegin);
      pendingBegin = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    video.srcObject = null;
    torchOn = false;
    root.classList.add("hidden");
    document.documentElement.classList.remove("scanner-open");
    if (!fromPopState && history.state && history.state.scanner) history.back();
    // only once out of fullscreen: leaving it drops the focus again
    const target = typeof returnFocusTo === "function" ? returnFocusTo() : returnFocusTo;
    returnFocusTo = null;
    const restoreFocus = () => target?.focus();
    if (document.fullscreenElement) (document.exitFullscreen?.() || Promise.resolve()).then(restoreFocus, restoreFocus);
    else restoreFocus();
  }

  closeBtn.addEventListener("click", () => close());
  window.addEventListener("popstate", () => close(true));
  // In fullscreen the first Escape only leaves fullscreen; the next closes.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // Switching apps or locking the phone: release the camera (iOS stops it
  // anyway, leaving a frozen preview). Opening the scanner again is a tap.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
  });

  function setupTorch() {
    torchOn = false;
    torchBtn.classList.remove("on");
    let supported = false;
    try {
      supported = !!mediaStream.getVideoTracks()[0]?.getCapabilities?.().torch;
    } catch (err) {
      supported = false;
    }
    torchBtn.classList.toggle("hidden", !supported);
  }

  torchBtn.addEventListener("click", async () => {
    const track = mediaStream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      torchOn = !!track.getSettings().torch;
      torchBtn.classList.toggle("on", torchOn);
    } catch (err) {
      // leave the button state as it was
    }
  });

  function setHint(main, sub) {
    if (hintEl.textContent !== main) hintEl.textContent = main;
    if (subhintEl.textContent !== sub) subhintEl.textContent = sub;
  }

  // ------------------------------------------------------------ viewfinder
  //
  // The box the user fits the barcode into - and exactly what gets decoded
  // (plus a margin for quiet zone and sloppy framing). Long side along the
  // screen's long side: in portrait that gives
  // the barcode the stream's 1920px rather than 1440px. Its size is also
  // the distance cue: a barcode that fills it is far enough back for the
  // whole symbol to stay in focus (measured ~2.1-2.4 px/module from a 1920px
  // stream - around the decoder's lower limit; below 2.2 the hints say
  // "closer", so a box filled at the low end may still get that hint).
  const BOX_ASPECT = 3.3; // long:short, barcode is ~4.2:1 plus slack
  const CROP_MARGIN_LONG = 0.12; // extra on each end, fraction of box length
  const CROP_MARGIN_SHORT = 0.35; // extra on each side, fraction of box width
  let boxPortrait = true;
  let box = null; // in video pixel coordinates: {x, y, w, h}

  function layoutViewfinder() {
    const ew = root.clientWidth;
    const eh = root.clientHeight;
    boxPortrait = eh >= ew;
    let bw;
    let bh;
    if (boxPortrait) {
      bh = 0.66 * eh;
      bw = bh / BOX_ASPECT;
      if (bw > 0.8 * ew) {
        bw = 0.8 * ew;
        bh = bw * BOX_ASPECT;
      }
    } else {
      bw = 0.72 * ew;
      bh = bw / BOX_ASPECT;
      if (bh > 0.6 * eh) {
        bh = 0.6 * eh;
        bw = bh * BOX_ASPECT;
      }
    }
    const left = (ew - bw) / 2;
    const top = (eh - bh) / 2 - (boxPortrait ? 0.03 * eh : 0);
    Object.assign(viewfinder.style, { left: `${left}px`, top: `${top}px`, width: `${bw}px`, height: `${bh}px` });

    // screen -> video pixels through object-fit: cover
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const s = Math.max(ew / vw, eh / vh);
    const ox = (ew - vw * s) / 2;
    const oy = (eh - vh * s) / 2;
    box = { x: (left - ox) / s, y: (top - oy) / s, w: bw / s, h: bh / s };
  }
  window.addEventListener("resize", () => {
    if (!root.classList.contains("hidden")) layoutViewfinder();
  });
  // the camera can switch frame orientation a few frames after the window
  // resizes (phone rotated): re-map the box when the video itself does
  video.addEventListener("resize", () => {
    if (!root.classList.contains("hidden")) layoutViewfinder();
  });

  // The crop actually decoded: the box plus margins, clamped to the frame.
  function cropRect() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const mx = (boxPortrait ? CROP_MARGIN_SHORT : CROP_MARGIN_LONG) * box.w;
    const my = (boxPortrait ? CROP_MARGIN_LONG : CROP_MARGIN_SHORT) * box.h;
    const x0 = Math.max(0, box.x - mx);
    const y0 = Math.max(0, box.y - my);
    const x1 = Math.min(vw, box.x + box.w + mx);
    const y1 = Math.min(vh, box.y + box.h + my);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Draws a region of the video into a canvas with the barcode's long axis
  // horizontal (the decoder scans along x): a portrait box is turned 90
  // degrees; whichever way round the card is, the decoder's own 180-degree
  // retry covers the rest. scale <= 1.
  function drawRegion(ctx, canvas, r, rotate, scale) {
    const outW = Math.round((rotate ? r.h : r.w) * scale);
    const outH = Math.round((rotate ? r.w : r.h) * scale);
    if (canvas.width !== outW) canvas.width = outW;
    if (canvas.height !== outH) canvas.height = outH;
    if (rotate) {
      // (x, y) in the region -> (y, w - x): top of the region ends up on
      // the left
      ctx.setTransform(0, -scale, scale, 0, 0, r.w * scale);
    } else {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }
    ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // -------------------------------------------------------- decoder worker
  //
  // pdf417-edge.js (an edge-based PDF417 reader - see its header) in a Web
  // Worker, which also keeps the scan session's codeword votes: every frame
  // votes, so a region blurred in one frame is filled in by the next.
  //
  // One worker per scan session: stopped when the scanner closes, so the
  // licence it just read doesn't stay in its memory, and a worker that
  // failed (didn't load, crashed, hung) is replaced instead of leaving the
  // scanner waiting forever.
  const DECODE_TIMEOUT_MS = 10000; // a decode takes well under a second
  let decoderWorker = null;
  let decoderNextId = 0;
  const decoderPending = new Map(); // id -> resolve
  function stopDecoderWorker(error) {
    decoderWorker?.terminate();
    decoderWorker = null;
    for (const resolve of decoderPending.values()) resolve({ bytes: null, detected: false, error });
    decoderPending.clear();
  }
  function getDecoderWorker() {
    if (!decoderWorker) {
      decoderWorker = new Worker(WORKER_URL);
      decoderWorker.onmessage = (e) => {
        const resolve = decoderPending.get(e.data.id);
        decoderPending.delete(e.data.id);
        if (resolve) resolve(e.data);
      };
      decoderWorker.onerror = decoderWorker.onmessageerror = (e) => {
        console.error("[scanner] decoder worker failed:", e.message || e);
        stopDecoderWorker("worker failed");
      };
    }
    return decoderWorker;
  }
  function decodeInWorker(imageData) {
    return new Promise((resolve) => {
      const id = ++decoderNextId;
      decoderPending.set(id, resolve);
      getDecoderWorker().postMessage({ type: "frame", id, imageData });
      setTimeout(() => {
        if (decoderPending.has(id)) stopDecoderWorker("timed out"); // the next frame starts a new one
      }, DECODE_TIMEOUT_MS);
    });
  }

  // ------------------------------------------------------- frame selection
  //
  // Every new video frame gets a cheap sharpness score (Brenner focus
  // measure on a 1:1 patch from the middle of the box), frames are skipped
  // while the phone is swinging around (DeviceMotion), and only the
  // sharpest frame since the last decode is handed to the decoder.
  const LIVE_SCAN_MAX_DIMENSION = 3200; // candidate canvas cap (long side)
  const PROBE_LONG = 640;
  const PROBE_SHORT = 160;
  const MIN_FRAMES_PER_DECODE = 4;
  // Deliberate repositioning only: frames at up to ~19 deg/s decoded fine
  // on a real phone; the sharpness score already prefers steadier frames.
  const MOTION_SKIP_DEG_PER_S = 45;
  const GOT_IT_MS = 400; // how long "Got it" stays up before the result

  let latestRotationDegPerS = null; // stays null where DeviceMotion never fires (no gating then)
  function onMotion(e) {
    const r = e.rotationRate;
    if (!r || r.alpha == null) return;
    latestRotationDegPerS = Math.hypot(r.alpha, r.beta || 0, r.gamma || 0);
  }

  let liveScanActive = false;
  let liveScanBusy = false;
  let liveScanSessionId = 0; // guards against a stale callback/decode from a previous session
  let candCanvas = null; // best candidate frame since the last decode (crop only)
  let candCtx = null;
  let probeCanvas = null;
  let probeCtx = null;
  let candidateScore = -1; // -1 = none since the last decode started
  let framesSinceDecode = 0;
  let notDetectedStreak = 0;

  // counts for the ?debug=1 overlay
  let counts = null;
  // ?debug=1: the last frame the decoder failed on, and what it found (a
  // successful decode closes the scanner before this is set)
  let lastDecode = null;

  // ?debug=1 "Save frame": downloads the exact crop the decoder last failed
  // on (PNG, a real licence - only for debugging) plus its diagnostics as
  // JSON in the console, to reproduce the failure offline with pdf417-edge.js.
  saveBtn.addEventListener("click", () => {
    if (!lastDecode) return;
    const { imageData, result, at } = lastDecode;
    const c = document.createElement("canvas");
    c.width = imageData.width;
    c.height = imageData.height;
    c.getContext("2d").putImageData(imageData, 0, 0);
    const name = `scanner-frame-${at.replace(/[:.]/g, "-")}`;
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.png`;
      a.click();
      // iOS asks "Download?" first: keep the image until the user has answered
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }, "image/png");
    console.info(`[scanner] saved ${name}.png, its decode result:`, JSON.stringify(result));
  });

  function startLiveScan() {
    if (liveScanActive || !mediaStream || !box) return;
    liveScanActive = true;
    liveScanBusy = false;
    latestRotationDegPerS = null;
    window.addEventListener("devicemotion", onMotion); // only while scanning
    getDecoderWorker().postMessage({ type: "reset" }); // fresh codeword votes
    counts = { probed: 0, motionSkipped: 0, attempts: 0, notFound: 0 };
    lastDecode = null; // never save a previous scan's frame
    candidateScore = -1;
    framesSinceDecode = 0;
    notDetectedStreak = 0;
    if (!candCanvas) {
      candCanvas = document.createElement("canvas");
      candCtx = candCanvas.getContext("2d", { willReadFrequently: true });
      probeCanvas = document.createElement("canvas");
      probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
    }
    scheduleNextFrame(++liveScanSessionId);
  }

  function stopLiveScan() {
    liveScanActive = false;
    window.removeEventListener("devicemotion", onMotion);
    stopDecoderWorker("closed");
  }

  // requestVideoFrameCallback fires once per *new* video frame; rAF is the
  // fallback for browsers without it.
  function scheduleNextFrame(session) {
    if (!liveScanActive || session !== liveScanSessionId) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => onLiveFrame(session));
    } else {
      requestAnimationFrame(() => onLiveFrame(session));
    }
  }

  // Brenner focus measure (mean squared 2-pixel difference across the
  // bars) on a 1:1 patch from the middle of the box, already turned so
  // the bars are vertical. Only compared between frames a few hundred ms
  // apart, so lighting-dependence doesn't matter.
  function probeSharpness(crop) {
    const longLen = Math.min(PROBE_LONG, boxPortrait ? crop.h : crop.w);
    const shortLen = Math.min(PROBE_SHORT, boxPortrait ? crop.w : crop.h);
    const pw = boxPortrait ? shortLen : longLen;
    const ph = boxPortrait ? longLen : shortLen;
    const r = { x: crop.x + (crop.w - pw) / 2, y: crop.y + (crop.h - ph) / 2, w: pw, h: ph };
    drawRegion(probeCtx, probeCanvas, r, boxPortrait, 1);
    const w = probeCanvas.width;
    const h = probeCanvas.height;
    const d = probeCtx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let y = 0; y < h; y++) {
      let i = y * w * 4 + 1; // green channel - close enough to luma
      for (let x = 0; x < w - 2; x++, i += 4) {
        const diff = d[i + 8] - d[i];
        sum += diff * diff;
      }
    }
    return sum / (h * (w - 2));
  }

  function onLiveFrame(session) {
    if (!liveScanActive || session !== liveScanSessionId) return;
    try {
      if (video.videoWidth && box) {
        const crop = cropRect();
        const score = probeSharpness(crop);
        const rotation = latestRotationDegPerS;
        counts.probed += 1;
        if (rotation !== null && rotation > MOTION_SKIP_DEG_PER_S) {
          counts.motionSkipped += 1;
        } else if (score > candidateScore) {
          const longSide = Math.max(crop.w, crop.h);
          drawRegion(candCtx, candCanvas, crop, boxPortrait, Math.min(1, LIVE_SCAN_MAX_DIMENSION / longSide));
          candidateScore = score;
        }
        framesSinceDecode += 1;
        if (!liveScanBusy && candidateScore >= 0 && framesSinceDecode >= MIN_FRAMES_PER_DECODE) {
          decodeCandidate(session); // not awaited - probing keeps running
        }
      }
    } catch (err) {
      // a single bad frame shouldn't kill the loop
    }
    scheduleNextFrame(session);
  }

  // Live guidance from what the decoder saw - the main way the user learns
  // to back off: too close is the usual failure (one end of the card out of
  // focus, or the barcode overflowing the box).
  function updateGuidance(r) {
    if (!r.detected) {
      notDetectedStreak += 1;
      if (notDetectedStreak >= 6) {
        viewfinder.classList.remove("seen");
        setHint(
          "Fit the barcode inside the box",
          boxPortrait
            ? "Barcode top to bottom, card flat – a little further back if it looks blurry"
            : "Hold the card flat, a little further back if it looks blurry"
        );
      }
      return;
    }
    notDetectedStreak = 0;
    viewfinder.classList.add("seen");
    progressBar.style.width = `${Math.min(100, Math.round((100 * r.accumulatedCells) / 640))}%`;
    // the crop spans the box plus CROP_MARGIN_LONG on each end
    setHint(...ScanHints.forResult(r, { boxFraction: 1 / (1 + 2 * CROP_MARGIN_LONG) }));
  }

  async function decodeCandidate(session) {
    liveScanBusy = true;
    const imageData = candCtx.getImageData(0, 0, candCanvas.width, candCanvas.height);
    candidateScore = -1;
    framesSinceDecode = 0;
    try {
      counts.attempts += 1;
      const r = await decodeInWorker(imageData);
      if (!liveScanActive || session !== liveScanSessionId) return; // closed meanwhile

      if (r.bytes && r.bytes.length) {
        progressBar.style.width = "100%";
        liveScanActive = false;
        if (navigator.vibrate) navigator.vibrate(60);
        setHint("Got it", "");
        // decoding is instant now: let "Got it" and the full bar show briefly
        await new Promise((resolve) => setTimeout(resolve, GOT_IT_MS));
        if (session !== liveScanSessionId || root.classList.contains("hidden")) return; // closed meanwhile
        try {
          if (onBytesCb) await onBytesCb(r.bytes, imageData);
        } catch (err) {
          console.error("[scanner] onBytes failed:", err); // the app reports its own errors
        } finally {
          // only if this scan is still the open one (the user may have closed
          // it and started another meanwhile)
          if (session === liveScanSessionId && !root.classList.contains("hidden")) close();
        }
        return;
      }

      if (!r.detected) counts.notFound += 1;
      updateGuidance(r);
      // ?debug=1: L/R below are in the decoder's frame, not the screen's: L is
      // always the start-pattern end (the crop may be turned 90 degrees, the
      // decoder may turn it 180, and a webcam preview is mirrored).
      if (DEBUG) {
        const { stats, ...summary } = r; // stats: per-row decoder internals, too long for a log line
        lastDecode = { imageData, result: { ...summary, frame: [imageData.width, imageData.height], boxPortrait }, at: new Date().toISOString() };
        console.info("[scanner] decode", JSON.stringify(lastDecode.result));
        debugEl.textContent =
          debugCameras +
          `decodes ${counts.attempts} of ${counts.probed} frames (${counts.motionSkipped} motion-skipped)\n` +
          (r.detected
            ? `found: ${r.cellsFilled}/748 this frame, ${r.accumulatedCells} accumulated, ${r.modulePx?.toFixed(2)} px/module` +
              `${r.inferred ? `, inferred ${r.inferred}` : ""}${r.rotated180 ? ", 180" : ""}, width ${r.widthFraction?.toFixed(2)}\n` +
              `pattern lines: start ${r.patternHits?.start} stop ${r.patternHits?.stop}; ` +
              `end focus L ${r.endSharpness?.left.focus} R ${r.endSharpness?.right.focus} (ratio ${r.endSharpness?.ratio}, softer: ${r.endSharpness?.softer})`
            : `no barcode found (${counts.notFound})`) +
          `, ${r.ms}ms`;
      }
    } catch (err) {
      // keep scanning
    } finally {
      liveScanBusy = false;
    }
  }

  window.LicenceScanner = { open, close };
})();

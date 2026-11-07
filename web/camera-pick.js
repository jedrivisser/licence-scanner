// Which camera to scan with, from what the browser says about each one.
// Pure (no DOM), so tests/js/camera-pick.test.js can feed it the camera
// lists real browsers report.
//
// Wanted: the phone's main back lens. A plain facingMode: "environment"
// request can land on the ultra-wide, macro or telephoto lens of a
// multi-camera phone (it did on the Android phone this was built against),
// so this picks the lowest-numbered back camera with continuous autofocus.
// Chrome on Android gives both: labels like "camera2 0, facing back" and
// each camera's focusMode.
//
// Only switch on evidence. Where no camera reports autofocus and no label
// carries a number (Safari on iPhone: "Back Camera", "Back Ultra Wide
// Camera", ...), every back camera ranks the same, and the first one listed
// may be a worse lens than the one the browser chose itself - so the answer
// is null: keep the browser's choice. Which iPhone camera works best is an
// open question; see "Help wanted: iPhone camera choice" in the README.
(function (root) {
  // cameras: [{ deviceId, label, capabilities }] as from enumerateDevices()
  // and getCapabilities(). Returns a deviceId, or null to keep the browser's
  // own pick.
  function chooseMainBackCamera(cameras) {
    const cands = cameras
      .map((c) => {
        const caps = c.capabilities || {};
        const label = c.label || "";
        const back = (caps.facingMode || []).includes("environment") || /back|rear|environment/i.test(label);
        const m = label.match(/(\d+)\s*,\s*facing/i);
        const af = (caps.focusMode || []).includes("continuous");
        return { id: c.deviceId, back, af, num: m ? Number(m[1]) : null };
      })
      .filter((c) => c.back && c.id);
    if (!cands.some((c) => c.af || c.num !== null)) return null;
    const byNum = (a, b) => (a.num === b.num ? 0 : a.num === null ? 1 : b.num === null ? -1 : a.num - b.num);
    cands.sort((a, b) => Number(b.af) - Number(a.af) || byNum(a, b)); // stable: ties keep the browser's order
    return cands[0].id;
  }

  const api = { chooseMainBackCamera };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CameraPick = api;
})(typeof self !== "undefined" ? self : this);

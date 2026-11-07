// node --test tests/js/*.test.js
//
// web/camera-pick.js: which camera the scanner switches to. The Android
// list is shaped like Chrome's on a multi-camera phone; the iPhone one like
// Safari's (no focus modes, no numbered labels).
const test = require("node:test");
const assert = require("node:assert");

const { chooseMainBackCamera } = require("../../web/camera-pick.js");

const back = (focusMode = []) => ({ facingMode: ["environment"], focusMode });

test("Android: the lowest-numbered back camera with continuous autofocus", () => {
  const cameras = [
    { deviceId: "front", label: "camera2 1, facing front", capabilities: { facingMode: ["user"], focusMode: ["continuous"] } },
    { deviceId: "wide", label: "camera2 2, facing back", capabilities: back(["continuous"]) },
    { deviceId: "macro", label: "camera2 3, facing back", capabilities: back(["manual"]) },
    { deviceId: "main", label: "camera2 0, facing back", capabilities: back(["continuous"]) },
  ];
  assert.strictEqual(chooseMainBackCamera(cameras), "main");
});

test("autofocus beats a lower number", () => {
  const cameras = [
    { deviceId: "fixed", label: "camera 0, facing back", capabilities: back(["manual"]) },
    { deviceId: "af", label: "camera 2, facing back", capabilities: back(["continuous"]) },
  ];
  assert.strictEqual(chooseMainBackCamera(cameras), "af");
});

test("labels are matched case-insensitively (\"Camera 0, Facing back\")", () => {
  const cameras = [
    { deviceId: "two", label: "Camera 2, Facing back", capabilities: {} },
    { deviceId: "zero", label: "Camera 0, Facing back", capabilities: {} },
  ];
  assert.strictEqual(chooseMainBackCamera(cameras), "zero");
});

test("iPhone (no autofocus info, no numbers): keep the browser's own pick", () => {
  const cameras = [
    { deviceId: "uw", label: "Back Ultra Wide Camera", capabilities: {} },
    { deviceId: "triple", label: "Back Triple Camera", capabilities: {} },
    { deviceId: "front", label: "Front Camera", capabilities: {} },
  ];
  assert.strictEqual(chooseMainBackCamera(cameras), null);
});

test("no back camera at all (a laptop): keep the browser's own pick", () => {
  const cameras = [{ deviceId: "cam", label: "FaceTime HD Camera", capabilities: { focusMode: ["continuous"] } }];
  assert.strictEqual(chooseMainBackCamera(cameras), null);
  assert.strictEqual(chooseMainBackCamera([]), null);
});

test("cameras without an id (no permission yet) are ignored", () => {
  const cameras = [{ deviceId: "", label: "", capabilities: back(["continuous"]) }];
  assert.strictEqual(chooseMainBackCamera(cameras), null);
});

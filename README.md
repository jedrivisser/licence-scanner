# licence-scanner

[![Pages](https://github.com/jedrivisser/licence-scanner/actions/workflows/pages.yml/badge.svg)](https://github.com/jedrivisser/licence-scanner/actions/workflows/pages.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jedrivisser/licence-scanner/badge)](https://scorecard.dev/viewer/?uri=github.com/jedrivisser/licence-scanner)

Reads the PDF417 barcode on the back of a South African driving licence card, entirely in the browser.
The site is static files only: nothing is uploaded, and there are no analytics.

**Try it: <https://licence.jedrivisser.com/>** (scanner at `/scan/`, wallet at `/show/`).

- **About** (`/`) links to the two apps and carries the privacy, "not official" and licence notices.
- **Scanner** (`scan/`) shows the card's fields and photo, and warns if the licence (or its PrDP) has expired.
- **Wallet** (`show/`) stores your own licence's barcode on the device and shows it full screen, so a barcode
  reader can scan it from the phone. It is not a driving licence: drivers still have to carry the card, and the
  app says so before the first scan.

Both apps are installable, offline-capable PWAs. Temporary (paper) licences are not supported.

## How it works

| File | Does |
| --- | --- |
| [`web/scanner.js`](web/scanner.js) | Camera, viewfinder and frame choice: it decodes the sharpest still frame. Add `?debug=1` for a diagnostics overlay, a JSON console line per failed decode, and a button that saves the last failed frame as a PNG (a real licence: never commit one). |
| [`web/camera-pick.js`](web/camera-pick.js) | Which camera to use, from what the browser reports about each one. |
| [`web/scan-hints.js`](web/scan-hints.js) | Picks the live hint (further back, closer, hold flat, hold steady) from what the decoder saw. |
| [`web/pdf417-edge.js`](web/pdf417-edge.js) | PDF417 reader for this one symbol (22 × 34, mirrored rows), runs in a Web Worker ([`web/pdf417-worker.js`](web/pdf417-worker.js)), which keeps the codeword votes across frames. |
| [`web/sadl.js`](web/sadl.js) | Decrypts (RSA, public keys), parses the fields and checks them (ID number, dates). |
| [`web/wi.js`](web/wi.js) | Decodes the photo (Summus WI wavelet, 200 × 250 greyscale); the app shows it mirrored, as printed on the card. |
| [`web/pdf417-encode.js`](web/pdf417-encode.js) | Re-draws the stored barcode exactly as printed, for the wallet: same codewords and mirrored rows, and the card's proportions (rows 3 modules high, about 4.3:1). [`web/pdf417-codes.js`](web/pdf417-codes.js) is the PDF417 codeword table both use. |
| [`web/sw.js`](web/sw.js) | Service worker: the whole site works offline. |

The pages are `web/index.html` (about), `web/scan/` and `web/show/`. Tests are in `tests/js/` (Node's built-in
test runner); `tests/js/make_fixture.py` regenerates the synthetic camera frame they use.

## Why a custom PDF417 reader

The first version used [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (via
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm)). It never read a physical card. Over about 2,800 phone frames
it either didn't find the symbol or found it and failed error correction (`ChecksumError`), with every binarizer,
at 1080p and at the full 12 MP. Even a sharp photo of the sample card off a monitor used 89% of the error
correction budget. Better frame choice (sharpest frame, skip while moving) did not change that.

Why generic readers struggle with this card:

- **Mirrored rows.** Row 0 is at the bottom. zxing-cpp has handled this since 2020
  ([issue #152](https://github.com/zxing-cpp/zxing-cpp/issues/152), [PR #175](https://github.com/zxing-cpp/zxing-cpp/pull/175)),
  so that wasn't what broke it here, but many other readers still trip on it.
- **Black/white thresholding.** zxing binarizes the image first; blur and uneven light across a laminated card
  break that before any bar is measured, so many codewords are misread rather than flagged as unreadable.
- **A bent module grid.** Card curvature and the lens shift codewords by several modules across the symbol, so
  sampling on a straight grid misreads whole columns.
- **Little slack.** 720 bytes fill a 22 × 34 symbol at EC level 6: 128 error-correction codewords for 620 data
  codewords. That corrects at most 64 misread codewords, or 128 known-unreadable ones.

Commercial PDF417 SDKs read the same card on the same phone easily, even in bad light, from a 1080p stream, so
the card is readable with a better approach. `pdf417-edge.js` works from bar edges rather than a thresholded
image:

1. Find the start and stop patterns along scan lines and flatten the symbol's perspective.
2. Find bar edges on each scan line with sub-pixel accuracy, relative to local contrast: no global threshold.
3. Identify codewords from edge-to-similar-edge distances (blur and ink spread cancel out), chaining each
   codeword's position from the previous one, from both ends, to follow the bent grid.
4. Place rows by the symbol's own row indicators, which also handles the mirroring.
5. Vote per codeword across scan lines and across frames, then run Reed-Solomon, treating unreadable
   codewords as erasures (they cost half as much as errors) and refusing near the limit rather than
   miscorrecting.

The reader works down to about 2.2 px per module on real frames (2 px on a sharp screen) and reads a real card from single frames.

## Camera settings

From what worked on real cards, and what the zxing sessions showed did not help. All in
[`web/scanner.js`](web/scanner.js):

| Decision | Why |
| --- | --- |
| Main back camera ([`web/camera-pick.js`](web/camera-pick.js)): the lowest-numbered back camera with continuous autofocus, remembered per browser; no camera picker. Where the browser reports neither (Safari on iPhone), its own choice | The main lens. A plain `facingMode: "environment"` landed on the ultra-wide or macro lens of a multi-camera phone. With no back camera (a laptop), the browser's default camera. iPhones: see [Help wanted](#help-wanted-iphone-camera-choice). |
| About 1920 px on the long side, `resizeMode: "none"` (a real sensor mode, not a browser scale) | The full 12 MP stream gave about 3 frames/s with long exposures and soft frames; at the distance the viewfinder sets, that is about 2.1-2.4 px per module (more when closer). |
| Camera defaults for focus and exposure: continuous autofocus, auto exposure, no zoom | Short manual exposures were tried with zxing and did not help; the edge reader copes with the default exposure. |
| Torch button, only when the camera supports it | For dark places; off by default, since the edge reader copes with dim light. |
| A wide viewfinder (3.3:1) along the screen's long side; only that box plus a margin is decoded | In portrait the barcode gets the stream's 1920 px instead of 1440. Filling the box puts the phone far enough back for the whole card to be in focus, about 2.1-2.4 px per module, around the reader's lower limit (the "closer" hint starts below 2.2). |
| Score every frame for sharpness (Brenner focus measure on a patch of the box) and decode only the sharpest one since the last decode, at most once every 4 frames | Decoding every frame wastes time on blurred ones. |
| Skip frames while the phone rotates faster than 45°/s (DeviceMotion) | Frames at up to about 19°/s still decoded, so only deliberate moves are skipped. |
| Keep each codeword's votes across frames until the scan closes | A part blurred in one frame is filled in by the next. |
| Live hints from the decoder ([`web/scan-hints.js`](web/scan-hints.js)): further back, closer, hold flat, hold steady | Being too close was the usual failure on a phone: one end of the card out of focus, or the barcode overflowing the box. A too-small barcode also loses one end's pattern with the card perfectly flat, so "hold flat" needs the end whose pattern didn't match to measure softer too. Order: further back; hold flat if that end is clearly softer (sharpness ratio below 0.5); closer below 2.2 px per module; hold flat if it is softer (below 0.7); hold steady. A clearly soft end outranks "closer" because a tilted card filling the box can measure just under 2.2 from its sharp far end. |
| Mirrored preview for a camera that isn't back-facing | A laptop webcam reports no facing mode; unmirrored, moving the card left moves it right on screen. Only the preview flips, not what is decoded. |
| A warning when the camera is neither back-facing nor reports continuous autofocus | See [Camera requirements](#camera-requirements). Scanning still runs. |

### Camera requirements

The reader needs about 2.2 px per module across the whole barcode, so the card has to be held close (a
hand-span from a phone) and in focus from end to end. A phone's main back camera with autofocus does this
easily. A fixed-focus laptop webcam does not: a MacBook's FaceTime HD camera never decoded a card. Checked against
the card's real data, a typical frame read 90 of the 748 codewords wrong and 219 not at all: 2 × 90 + 219 = 399,
against an error-correction budget of 120 (2 × wrong + missing; 128 EC codewords less the decoder's 8-codeword
safety margin). Held where it focuses, the barcode is too small (about 1.7 px per module); held close enough to be
big enough, it's out of focus, worst at whichever end is nearer. The scanner
warns when the camera looks like that (not back-facing and no continuous-autofocus mode reported), except for an
iPhone used as a Mac's webcam (Continuity Camera), which does autofocus. Chrome on a Mac may report no focus modes
for any camera, so another autofocus webcam there can get the warning too; scanning still runs. It can't tell
before camera access is granted, so the warning shows in the scanner, not on page load.

## Help wanted: iPhone camera choice

The scanner was tuned on Android phones. On iPhones it can't choose a lens the same way: Safari names its cameras
"Back Camera", "Back Ultra Wide Camera", "Back Triple Camera" and so on, and reports no autofocus details, so the
scanner keeps the camera Safari picks for `facingMode: "environment"`. Nobody has checked yet which camera reads a
licence best on an iPhone, or whether Safari's pick is a good one. If you have an iPhone, especially one with two
or three back cameras, you can help:

1. Open <https://licence.jedrivisser.com/scan/?debug=1> in Safari and tap "Scan licence". The text at the top of
   the scanner shows the camera in use (`camera:`) and every camera Safari offers (`all cameras:`), for example
   `Back Camera | Back Ultra Wide Camera | Back Triple Camera | Front Camera`. Scan your licence card and note
   roughly how many seconds a read takes.
2. Repeat for each back camera in that list, forcing it by name: add `&camera=` and a word from its name that no
   other camera's name contains, e.g. `?debug=1&camera=ultra` or `?debug=1&camera=triple` (for plain "Back
   Camera", the whole name: `?debug=1&camera=back%20camera`). The scanner uses the first camera whose name
   contains it; check that the `camera:` line changed.
3. [Open an issue](https://github.com/jedrivisser/licence-scanner/issues/new) with your iPhone model, iOS version,
   the camera Safari picked, and which cameras read the card and how fast.

Please don't attach screenshots, photos, saved frames or anything else showing a licence: the camera names and
timings are all that's needed.

## Use

Needs Node.js 18 or later for the tests (CI uses 26, the current LTS), Python 3 for `make serve`, and `make`.

```sh
make serve           # local: http://localhost:8080/ (about), /scan/, /show/
make test            # node --test tests/js/*.test.js
make public-vectors  # optional: real public card barcodes for extra tests (git-ignored)
uv run --with numpy --with pillow --with pdf417gen python tests/js/make_fixture.py  # regenerate the test frame
```

## Hosting

Publish `web/` as is on any static host (GitHub Pages, Firebase Hosting, ...); all paths are relative, so a
subpath like `https://<user>.github.io/licence-scanner/` works. It needs HTTPS for the camera. The two apps are
sibling directories so that each installed PWA's scope covers only its own app; don't move the scanner back to
the site root, or its scope would claim the wallet too.

`web/404.html` is the only page with links from the site root (`/style.css`, `/scan/`), because GitHub Pages
serves it for a missing path at any depth. Under a subpath, those links need the subpath added.

On GitHub, `.github/workflows/pages.yml` runs the tests on every push and pull request, and publishes `web/` from
`main`; set Settings > Pages > Source to "GitHub Actions" once.

Static hosts like GitHub Pages can't send security headers, so each page sets its Content-Security-Policy in a
`<meta>` tag: only the site's own files, no inline scripts, no third-party requests. Keep new code within it
(no inline `<script>`, no CDN), so scans provably stay on the device. A meta tag can't stop other sites framing
the pages (`frame-ancestors`) or set HSTS; with a CDN in front (the live site uses Cloudflare), send those as real
headers.

`sw.js` caches the files in its `SHELL` list for offline use (`tests/js/sw.test.js` checks the list against what
the pages load). The deploy stamps its `CACHE` name with the commit, so every deploy installs a fresh, complete
copy; there is nothing to bump by hand. On the wallet, `?debug=1` adds a button that copies the stored 720
barcode bytes as hex, to reproduce a scan offline with the real data.

## Licence

MIT: see [`LICENSE`](LICENSE). The site also serves [`web/licences.txt`](web/licences.txt), with this licence and
the notices of the MIT-licensed code it builds on (listed below).

## References

- [FrancoisSt/sa-driving-licence-barcode](https://github.com/FrancoisSt/sa-driving-licence-barcode): the
  [barcode and checks spec](https://github.com/FrancoisSt/sa-driving-licence-barcode/tree/main/spec), the
  [WI codec spec](https://github.com/FrancoisSt/sa-driving-licence-barcode/blob/main/spec/wi-codec.md) that
  `wi.js` ports, and the test vectors in `tests/js/fixtures/sa-driving-licence/` (MIT).
- Donald Jansen's
  [reconstruction of the Summus WI decoder](https://github.com/the-mars-rover/rsa_identification/issues/2#issuecomment-2493025394),
  which made the photo decodable.
- [Stack Overflow 17549231](https://stackoverflow.com/questions/17549231/decode-south-african-za-drivers-license)
  and [MyBroadband](https://mybroadband.co.za/vb/showthread.php/382187-Decode-Drivers-Licence-Barcode): the RSA
  public keys and the first descriptions of the format.
- [DanieLeeuwner/Reply.Net.SADL](https://github.com/DanieLeeuwner/Reply.Net.SADL): the public card barcodes used
  by `make public-vectors`.
- [the-mars-rover/rsa_identification](https://github.com/the-mars-rover/rsa_identification): another decoder
  for SA licences and IDs.
- [zxing-cpp #152](https://github.com/zxing-cpp/zxing-cpp/issues/152) and
  [PR #175](https://github.com/zxing-cpp/zxing-cpp/pull/175): zxing's attempts at these cards (mirrored
  symbol, too many erasures).
- [PDF417](https://en.wikipedia.org/wiki/PDF417) (ISO/IEC 15438), and
  [ihabunek/pdf417-py](https://github.com/ihabunek/pdf417-py) for the codeword table in `web/pdf417-codes.js` and the
  error-correction and row-indicator code `web/pdf417-encode.js` ports (MIT).
- [Businessware/Swi](https://github.com/Businessware/Swi): the original Summus DLL. `wi.js` matched its output
  byte for byte when checked; the portrait hashes in the test vectors now pin it.

"""Builds tests/js/fixtures/synthetic.json.gz: a synthetic SA-licence-shaped
PDF417 (random non-PII bytes, same fixed structure, vertically mirrored
like the real symbol) degraded the way real phone frames are - perspective,
a horizontally *bent* module grid (lens/card curvature, what codeword
chaining exists for), blur, uneven lighting and noise - as a grayscale
array, plus the payload it must decode to.

    uv run --with numpy --with pillow --with pdf417gen python tests/js/make_fixture.py
"""

import base64
import gzip
import json
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from pdf417gen.compaction.byte import compact_bytes
from pdf417gen.encoding import compute_error_correction_code_words, encode_rows, get_padding
from pdf417gen.rendering import render_image

# The SA licence symbol's fixed structure (see web/pdf417-edge.js)
COLUMNS = 22
SECURITY_LEVEL = 6
EC_COUNT = 128
RAW_PAYLOAD_LENGTH = 720
BYTE_COMPACTION_LATCH = 924  # byte compaction, count a multiple of 6

OUT = Path(__file__).parent / "fixtures" / "synthetic.json.gz"


def main() -> None:
    rng = random.Random(417)
    data = bytes(rng.randint(0, 255) for _ in range(RAW_PAYLOAD_LENGTH))
    words = [BYTE_COMPACTION_LATCH] + list(compact_bytes(data))
    padding = get_padding(len(words), EC_COUNT, COLUMNS)
    extended = [len(words) + len(padding) + 1] + words + padding
    allw = extended + compute_error_correction_code_words(extended, SECURITY_LEVEL)
    rows = [allw[i : i + COLUMNS] for i in range(0, len(allw), COLUMNS)]
    sym = render_image(list(encode_rows(rows, COLUMNS, SECURITY_LEVEL)), scale=6, ratio=3, padding=0)
    sym = np.asarray(sym.convert("L"), dtype=np.float32)[::-1]  # mirrored: row 0 at the bottom
    sh, sw = sym.shape

    W, H = 1500, 560
    out = np.full((H, W), 200.0, dtype=np.float32)
    # inverse map: output pixel -> symbol pixel. Perspective-ish: symbol
    # spans x 60..1440, top edge y 120->100, bottom 440->470 (left->right);
    # plus a sinusoidal x bend of up to ~2.5 modules.
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    u = (xs - 60) / (1440 - 60)  # 0..1 across
    top = 120 - 20 * u
    bot = 440 + 30 * u
    v = (ys - top) / (bot - top)
    bend = 2.5 * 6 * np.sin(np.pi * u) * 0.9  # in symbol px (6 px/module)
    sx = u * sw + bend
    sy = v * sh
    inside = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    xi = np.clip(sx.astype(int), 0, sw - 1)
    yi = np.clip(sy.astype(int), 0, sh - 1)
    out[inside] = np.where(sym[yi, xi] < 128, 30.0, 215.0)[inside]

    img = Image.fromarray(out.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1))
    a = np.asarray(img, dtype=np.float32)
    a = a * (0.55 + 0.45 * (1 - xs / W))  # light falls off to the right
    a += np.random.default_rng(1).normal(0, 3.0, a.shape)
    gray = (a.clip(0, 255) / 6).round().astype(np.uint8) * 6  # coarse levels: keeps the fixture small

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "width": W,
        "height": H,
        "gray_b64": base64.b64encode(gray.tobytes()).decode(),
        "expected_b64": base64.b64encode(data).decode(),
    }
    OUT.write_bytes(gzip.compress(json.dumps(payload).encode(), 9, mtime=0))  # reproducible bytes
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes), module ~{(1440 - 60) / 443:.2f}px")


if __name__ == "__main__":
    main()

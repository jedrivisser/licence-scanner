// node --test tests/js/*.test.js
//
// sadl.js and wi.js against the conformance vectors of
// FrancoisSt/sa-driving-licence-barcode (fixtures/sa-driving-licence/). The six
// public card barcodes are tested too once `make public-vectors` has
// fetched them (not committed: real people's details).
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SADL = require("../../web/sadl.js");
const WI = require("../../web/wi.js");

const FIX = path.join(__dirname, "fixtures", "sa-driving-licence");
const vectors = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`)));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));

// the spec's canonical output: the licence, or { error: <reason> }
function canonical(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SADL.DecodeError) return { error: err.reason };
    throw err;
  }
}

test("parse-card vectors", () => {
  for (const c of vectors("parse-card").cases) {
    assert.deepStrictEqual(canonical(() => SADL.parseCard(hex(c.payload_hex))), c.expected, c.name);
  }
});

test("decode vectors (card barcodes; temporary licences are not supported)", () => {
  let n = 0;
  for (const c of vectors("decode").cases) {
    if (c.name.startsWith("temporary-licence")) continue;
    const raw = c.raw_hex ? hex(c.raw_hex) : Uint8Array.from(Buffer.from(c.raw_text, "latin1"));
    assert.deepStrictEqual(canonical(() => SADL.decode(raw)), c.expected, c.name);
    n++;
  }
  assert.ok(n >= 5);
});

test("checks vectors", () => {
  for (const c of vectors("checks").cases) {
    if (c.licence.kind !== "card") continue;
    assert.deepStrictEqual(SADL.check(c.licence), c.expected, c.name);
  }
});

test("checkToday: expired, not yet valid, PrDP expired", () => {
  const l = { valid_from: "2022-03-23", valid_to: "2027-03-22", prdp_expiry: "2026-01-31" };
  assert.deepStrictEqual(SADL.checkToday(l, "2026-01-31"), [], "valid on the last day");
  assert.deepStrictEqual(SADL.checkToday(l, "2026-02-01"), ["prdp_expired"]);
  assert.deepStrictEqual(SADL.checkToday(l, "2027-03-22"), ["prdp_expired"]);
  assert.deepStrictEqual(SADL.checkToday(l, "2027-03-23"), ["expired", "prdp_expired"]);
  assert.deepStrictEqual(SADL.checkToday(l, "2022-03-22"), ["not_yet_valid"]);
  assert.deepStrictEqual(SADL.checkToday({ ...l, prdp_expiry: null }, "2030-01-01"), ["expired"]);
  assert.strictEqual(SADL.localDate(new Date(2027, 2, 5, 23, 59)), "2027-03-05", "local date, zero-padded");
});

test("five years from 29 February ends on 28 February", () => {
  const base = vectors("checks").cases.find((c) => c.licence.kind === "card" && !c.expected.length).licence;
  const validity = (valid_from, valid_to) => SADL.check({ ...base, valid_from, valid_to }).filter((f) => f.startsWith("validity"));
  assert.deepStrictEqual(validity("2024-02-29", "2029-02-28"), []);
  assert.deepStrictEqual(validity("2024-02-29", "2029-02-27"), ["validity_not_five_years"]);
  assert.deepStrictEqual(validity("2023-03-01", "2028-02-29"), [], "to a leap day, the day before 1 March");
  assert.deepStrictEqual(validity("2020-01-15", "2025-01-14"), []);
});

// section 14 checkpoints, hashed as the vectors state them
function checkpoints(wi) {
  const t = {};
  WI.decodeNativeOrder(wi, t);
  return {
    q: t.q,
    ll_bits: t.ll_bits,
    skip: t.skip,
    bytes_consumed: t.bytes_consumed,
    C1_ll: sha(t.C1_ll),
    C2_map: sha(t.C2_map),
    levels: t.levels.map((l) => ({
      level: l.level,
      C3_upsampled: sha(l.C3_upsampled),
      escape_bits: l.escape_bits,
      C4_coefficient_count: l.C4_coefficient_count,
      C4_coefficients: sha(l.C4_coefficients),
      C5_reconstructed: sha(l.C5_reconstructed),
    })),
    C6_sharpened: sha(t.C6_sharpened),
    C7_raster: sha(t.C7_raster),
  };
}

function expectedCheckpoints(c) {
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    ...pick(c, ["q", "ll_bits", "skip", "bytes_consumed", "C1_ll", "C2_map"]),
    levels: c.levels.map((l) =>
      pick(l, ["level", "C3_upsampled", "escape_bits", "C4_coefficient_count", "C4_coefficients", "C5_reconstructed"])
    ),
    ...pick(c, ["C6_sharpened", "C7_raster"]),
  };
}

test("WI synthetic streams: every checkpoint, and the canonical error of the failing ones", () => {
  for (const c of vectors("wi-synthetic").cases) {
    const wi = hex(c.wi_hex);
    if (c.expected_error) {
      assert.throws(() => WI.decode(wi), (err) => err instanceof WI.WiError && err.code === c.expected_error, c.name);
    } else {
      assert.deepStrictEqual(checkpoints(wi), expectedCheckpoints(c), c.name);
    }
  }
});

test("WI decode() returns the upright portrait (the codec raster reversed)", () => {
  const c = vectors("wi-synthetic").cases.find((x) => !x.expected_error);
  const raster = WI.decodeNativeOrder(hex(c.wi_hex));
  const portrait = WI.decode(hex(c.wi_hex));
  assert.strictEqual(portrait.length, WI.WIDTH * WI.HEIGHT);
  assert.deepStrictEqual(portrait, raster.slice().reverse());
});

// ---------------------------------------------------------------- public vectors
const PUBLIC = path.join(__dirname, "..", "..", "third_party", "UnitTest1.cs");
const publicRaw = fs.existsSync(PUBLIC)
  ? [...fs.readFileSync(PUBLIC, "utf8").matchAll(/"([0-9a-fA-F]{1000,})"/g)].map((m) => hex(m[1]))
  : null;

test("public card vectors: decrypt, photo and portrait byte for byte", { skip: !publicRaw && "run make public-vectors" }, () => {
  const checkpointsByIndex = new Map(vectors("wi-checkpoints").cases.map((c) => [c.index, c]));
  for (const c of vectors("public-vectors").cases) {
    const raw = publicRaw[c.index - 1];
    assert.strictEqual(sha(raw), c.raw_sha256);
    const payload = SADL.decrypt(raw);
    assert.strictEqual(sha(payload), c.payload_sha256);
    const photo = SADL.photoSection(payload);
    assert.strictEqual(photo.length, c.photo_length);
    assert.strictEqual(sha(photo), c.photo_sha256);
    assert.deepStrictEqual(checkpoints(photo), expectedCheckpoints(checkpointsByIndex.get(c.index)));
    assert.strictEqual(sha(WI.decode(photo)), c.portrait_sha256);
    assert.strictEqual(SADL.decode(raw).version, c.version);
  }
});

test("public card vectors: negative cases", { skip: !publicRaw && "run make public-vectors" }, () => {
  const raw = publicRaw[0];
  const reason = (bytes) => canonical(() => SADL.decrypt(bytes)).error;
  for (let k = 0; k < 6; k++) {
    const flipped = raw.slice();
    flipped[6 + 128 * k + 40] ^= 1;
    assert.strictEqual(reason(flipped), "block_check_failed", `block ${k + 1}`);
  }
  const unknown = raw.slice();
  unknown.set([0x01, 0x9b, 0x09, 0x46]);
  assert.strictEqual(reason(unknown), "unknown_version");
  const otherKey = raw.slice();
  otherKey.set([0x01, 0xe1, 0x02, 0x45]);
  assert.strictEqual(reason(otherKey), "block_check_failed");
  assert.strictEqual(reason(raw.slice(0, 719)), "wrong_length");
});

test("decodeCard: one decrypt gives decode()'s licence and decrypt()'s payload", { skip: !publicRaw && "run make public-vectors" }, () => {
  for (const raw of publicRaw) {
    const { licence, payload } = SADL.decodeCard(raw);
    assert.deepStrictEqual(licence, SADL.decode(raw));
    assert.deepStrictEqual(payload, SADL.decrypt(raw));
  }
});

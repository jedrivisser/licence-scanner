// South African driving-licence card barcode: the 720 raw PDF417 bytes ->
// the licence's fields, in the browser.
//
// Follows spec/card-barcode.md and spec/checks.md of
// github.com/FrancoisSt/sa-driving-licence-barcode (MIT), whose output form
// (spec/output-format.md) this returns:
//   SADL.decode(bytes)        -> { kind: "card", version, surname, ... }
//   SADL.decrypt(bytes)       -> the 684-byte payload
//   SADL.photoSection(payload)-> the WI photo bytes (wi.js decodes them)
//   SADL.check(licence)       -> finding codes, e.g. ["id_number_check_digit"]
// Failures throw a DecodeError whose .reason is the spec's error code.
(function (root) {
  "use strict";

  const CARD_SIZE = 720;

  // Published public keys (Stack Overflow 17549231; mybroadband forum):
  // [modulus, exponent] for the five 128-byte blocks, then the last 74-byte
  // block. They only undo the encryption; they are not secrets.
  const KEYS = {
    1: [
      [
        "fed2e1c27e3363316e77317a7a52c54981395186be4974760c72518d63e0544a" +
          "48d088b332c5b0c370c765d65d983c1f9de0a42b310ccc07ae770bd2b61d6a4d" +
          "cceac757689bdcbf608478faf312f6087cc496c3762cf5c4651caecda3499fae" +
          "7edb7eb40e3e18eb304170e91ed5b156aace6f432d6eca6cc35851de8c678f67",
        "bb797ffdec7f9e42c9d6f79b137059db",
      ],
      [
        "ff3cec6b5f40e3c3661451b9fcfaef3aeb06dc2329c0e6f4dccc9279726716ce" +
          "15bbe05eed2c5711bcf8f5b6c8f7276db5c43bfaa3040dc01ab14b9c4d16f71c" +
          "0ce5ea953f0c754c6b17",
        "db05ba822d9acc33fab7d8f427f9ce65",
      ],
    ],
    2: [
      [
        "ca9f18ef6c3f3fa4c5a461fea54ab19406ba5ecd746d60a27492dca3d74e3b5c" +
          "1d315f7b10383241809b029ebbd5de4d116030cc57f7d5a6c9a16f373bb14a50" +
          "8523f7e80a4c744d9085663a4a1472d7af2c56ae41b5065f7efa0293bd3278ad" +
          "693546f9f16219b79ff471a3636824cffcdb63a8ed8059e6b9a4f0db895381cb",
        "187092da6454ceb1853e6915f8466a05",
      ],
      [
        "b404a0df11d1cacff1a1a048d4d573f953a62c583d74925927561a6d7a1e2b14" +
          "042526af70b550547390ea6ec748d30fdb81adb490e0c36a1986b404b2f5f69e" +
          "f5da1b663e59509130e7",
        "309cfed9719fe2a5e20c9bb44765382b",
      ],
    ],
  };

  class DecodeError extends Error {
    constructor(reason, message) {
      super(message || reason);
      this.reason = reason;
    }
  }

  // the version bytes: 01 E1 02 45 (v1) or 01 9B 09 45 (v2, every card seen)
  function version(raw) {
    const h = Array.from(raw.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
    return { "01e10245": 1, "019b0945": 2 }[h] || null;
  }

  function modPow(b, e, n) {
    let r = 1n;
    b %= n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  }

  const toBig = (bytes) => BigInt("0x" + (Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") || "0"));

  // 720 barcode bytes -> 684-byte payload: textbook RSA per block, then check
  // and strip each block's 5 marker bytes ((j << k) & 0x7F for j = 1..5)
  function decrypt(raw) {
    raw = Uint8Array.from(raw);
    if (raw.length !== CARD_SIZE) throw new DecodeError("wrong_length", `length ${raw.length}, expected ${CARD_SIZE}`);
    const v = version(raw);
    if (!v) throw new DecodeError("unknown_version");
    const out = new Uint8Array(684);
    let o = 0;
    for (let k = 0; k < 6; k++) {
      const size = k < 5 ? 128 : 74;
      const start = 6 + 128 * k;
      const [nHex, eHex] = KEYS[v][k < 5 ? 0 : 1];
      const n = BigInt("0x" + nHex);
      const c = toBig(raw.subarray(start, start + size));
      if (c >= n) throw new DecodeError("block_check_failed", `block ${k + 1} outside the modulus`);
      const hex = modPow(c, BigInt("0x" + eHex), n).toString(16).padStart(size * 2, "0");
      const block = new Uint8Array(size);
      for (let i = 0; i < size; i++) block[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      for (let j = 1; j <= 5; j++) {
        if (block[j - 1] !== ((j << k) & 0x7f)) throw new DecodeError("block_check_failed", `block ${k + 1} marker mismatch`);
      }
      out.set(block.subarray(5), o);
      o += size - 5;
    }
    return out;
  }

  const sectionSizes = (p) => [p[5], p[7], ((p[8] << 8) | p[9]) & 0x0fff];

  // the portrait section of the payload, including its "WI" header
  function photoSection(p) {
    const [s1, s2, s3] = sectionSizes(p);
    if (10 + s1 + s2 + s3 > p.length) throw new DecodeError("malformed_payload", "section lengths exceed the payload");
    return p.slice(10 + s1 + s2, 10 + s1 + s2 + s3);
  }

  const latin1 = (bytes) => String.fromCharCode(...bytes);
  const pad2 = (n) => String(n).padStart(2, "0");

  class Nibbles {
    constructor(bytes) {
      this.v = [];
      for (const b of bytes) this.v.push(b >> 4, b & 0x0f);
      this.at = 0;
    }
    next() {
      if (this.at >= this.v.length) throw new DecodeError("malformed_payload", "ran out of nibbles");
      return this.v[this.at++];
    }
    pair() {
      return this.next().toString(16) + this.next().toString(16);
    }
    // 8 digit nibbles yyyyMMdd, or a single A nibble for "no date"
    date() {
      if (this.at < this.v.length && this.v[this.at] === 0xa) {
        this.at++;
        return null;
      }
      const d = Array.from({ length: 8 }, () => this.next());
      if (d.some((x) => x > 9)) throw new DecodeError("malformed_payload", "date nibble above 9");
      const y = d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3];
      const m = d[4] * 10 + d[5];
      const day = d[6] * 10 + d[7];
      const t = new Date(Date.UTC(2000, m - 1, day));
      t.setUTCFullYear(y);
      if (y < 1 || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== day) throw new DecodeError("malformed_payload", "not a real date");
      return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(day)}`;
    }
    doneOrPad() {
      return this.at === this.v.length || (this.at === this.v.length - 1 && this.v[this.at] === 0xa);
    }
  }

  // the 684-byte payload -> the canonical licence
  function parseCard(p, ver = 2) {
    p = Uint8Array.from(p);
    if (p.length < 10) throw new DecodeError("malformed_payload", "payload too short");
    const [s1, s2, s3] = sectionSizes(p);
    if (10 + s1 + s2 + s3 > p.length) throw new DecodeError("malformed_payload", "section lengths exceed the payload");

    // Section 1: 14 Latin-1 strings, then the 13-character ID number. E0 ends
    // a string; E1 ends a string and marks the next one empty.
    const strings = [];
    let cur = [];
    const end1 = 10 + s1;
    let i = 10;
    for (; i < end1 && strings.length < 14; i++) {
      const c = p[i];
      if (c === 0xe0 || c === 0xe1) {
        strings.push(latin1(cur));
        cur = [];
        if (c === 0xe1 && i + 1 < end1 && p[i + 1] !== 0xe1) strings.push("");
      } else cur.push(c);
    }
    if (strings.length !== 14) throw new DecodeError("malformed_payload", `${strings.length} strings, expected 14`);
    const idNumber = latin1(p.subarray(i, end1));

    // Section 2: nibbles, high nibble first
    const n = new Nibbles(p.subarray(end1, end1 + s2));
    const idType = n.pair();
    const firstIssue = [n.date(), n.date(), n.date(), n.date()];
    const driverRestrictions = n.pair();
    const prdpExpiry = n.date();
    const issueNumber = n.pair();
    const birth = n.date(), validFrom = n.date(), validTo = n.date();
    const gender = n.pair();
    if (!n.doneOrPad()) throw new DecodeError("malformed_payload", "nibbles left over");
    if (!birth || !validFrom || !validTo) throw new DecodeError("malformed_payload", "a required date is missing");

    return {
      kind: "card",
      version: ver,
      licence_number: strings[13],
      licence_country: strings[8],
      surname: strings[4],
      initials: strings[5],
      id_number: idNumber,
      id_type: idType,
      id_country: strings[7],
      birth_date: birth,
      gender,
      valid_from: validFrom,
      valid_to: validTo,
      issue_number: issueNumber,
      vehicle_codes: [0, 1, 2, 3]
        .filter((k) => strings[k])
        .map((k) => ({ code: strings[k], vehicle_restriction: strings[9 + k], first_issue: firstIssue[k] })),
      driver_restrictions: driverRestrictions,
      prdp_categories: strings[6].split(",").map((s) => s.trim()).filter(Boolean),
      prdp_expiry: prdpExpiry,
      photo_length: s3,
    };
  }

  // raw barcode bytes -> the canonical licence (card barcodes only; the paper
  // temporary licence's plain-text barcode is not supported), plus the
  // decrypted payload for photoSection() - decrypting is the slow part
  function decodeCard(raw) {
    raw = Uint8Array.from(raw);
    const v = version(raw);
    if (!v) throw new DecodeError("not_a_licence", "not a South African driving-licence card barcode");
    const payload = decrypt(raw);
    return { licence: parseCard(payload, v), payload };
  }
  const decode = (raw) => decodeCard(raw).licence;

  // ------------------------------------------------------------ checks
  const KNOWN_CODES = ["A1", "A", "B", "EB", "C1", "C", "EC1", "EC"];
  const BLOCKING = ["licence_number_format", "id_number_check_digit", "id_number_birth_date", "validity_order"];

  function idNumberValid(id) {
    if (!/^\d{13}$/.test(id || "")) return false;
    let sum = 0;
    for (let k = 0; k < 13; k++) {
      let d = +id[12 - k];
      if (k % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  }

  // same day five years on, less a day; ISO strings compare as dates. From
  // 29 February: 29 February five years on rolls to 1 March, so 28 February.
  function plusFiveYearsLessADay(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(2000, m - 1, d)); // 2000 is a leap year: 29 February stays put
    t.setUTCFullYear(y + 5);
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  }

  // findings for a canonical card, in spec/checks.md's order
  function check(l) {
    const found = [];
    if (!/^\d{7}[0-9A-Z]{5}$/.test(l.licence_number || "")) found.push("licence_number_format");
    if (!idNumberValid(l.id_number)) found.push("id_number_check_digit");
    const b = l.birth_date;
    if (l.id_number.slice(0, 6) !== b.slice(2, 4) + b.slice(5, 7) + b.slice(8, 10)) found.push("id_number_birth_date");
    if (l.valid_from >= l.valid_to) found.push("validity_order");
    else if (l.valid_to !== plusFiveYearsLessADay(l.valid_from)) found.push("validity_not_five_years");
    if (l.vehicle_codes.some((c) => !KNOWN_CODES.includes(c.code))) found.push("unknown_code");
    return found;
  }

  // a Date as "YYYY-MM-DD" in this device's own time zone, like the barcode's dates
  const localDate = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Against today's date (not in the spec: the barcode can't know the date).
  // today: localDate(); ISO strings compare as dates, and a licence is valid
  // up to and including valid_to.
  function checkToday(l, today) {
    const found = [];
    if (l.valid_to && today > l.valid_to) found.push("expired");
    else if (l.valid_from && today < l.valid_from) found.push("not_yet_valid");
    if (l.prdp_expiry && today > l.prdp_expiry) found.push("prdp_expired");
    return found;
  }

  const api = { DecodeError, KNOWN_CODES, BLOCKING, decode, decodeCard, decrypt, parseCard, photoSection, check, checkToday, localDate, idNumberValid };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SADL = api;
})(typeof self !== "undefined" ? self : this);

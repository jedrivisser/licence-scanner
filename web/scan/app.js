(() => {
  // Home: scan button (and the last result once there is one). The
  // full-screen scanner itself is ../scanner.js, shared with ../show/.
  const scanBtn = document.getElementById("scan-btn");
  const homeStatus = document.getElementById("home-status");

  const resultCard = document.getElementById("result-card");
  const resultError = document.getElementById("result-error");
  const resultPhoto = document.getElementById("result-photo");
  const resultFields = document.getElementById("result-fields");
  const resultScannedWrap = document.getElementById("result-scanned-wrap");
  const resultScannedImage = document.getElementById("result-scanned-image");

  // Installable app (manifest.webmanifest + sw.js)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("../sw.js").catch(() => {});
  }

  // Everything happens on this device: decrypt and parse (sadl.js), the
  // photo (wi.js). Nothing is uploaded.
  const ERRORS = {
    wrong_length: "Not a licence card barcode (wrong length).",
    unknown_version: "Unknown licence barcode version.",
    not_a_licence: "Not a South African driving-licence card barcode.",
    block_check_failed: "The barcode did not decrypt: a misread, or not a licence.",
    malformed_payload: "The barcode decrypted but its contents don't follow the licence layout.",
  };

  function decode(bytes) {
    let card;
    try {
      card = SADL.decodeCard(bytes);
    } catch (err) {
      return { ok: false, error: ERRORS[err.reason] || `Failed to decode: ${err.message || err}` };
    }
    const { licence, payload } = card;
    const result = { ok: true, licence, findings: SADL.check(licence), today: SADL.checkToday(licence, SADL.localDate()) };
    try {
      result.photo = portraitDataUrl(WI.decode(SADL.photoSection(payload)));
    } catch (err) {
      result.photoError = `could not decode (${err.message || err})`;
    }
    return result;
  }

  // The barcode's portrait (wi.js, upright as the spec defines it) is the
  // mirror image of the photo printed on the card: flip it left to right
  // so it looks the same as the card.
  function portraitDataUrl(gray) {
    const w = WI.WIDTH;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = WI.HEIGHT;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < gray.length; i++) {
      const o = 4 * (i - (i % w) + (w - 1 - (i % w))); // same row, mirrored column
      img.data[o] = img.data[o + 1] = img.data[o + 2] = gray[i];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  function imageDataUrl(imageData) {
    const c = document.createElement("canvas");
    c.width = imageData.width;
    c.height = imageData.height;
    c.getContext("2d").putImageData(imageData, 0, 0);
    return c.toDataURL("image/jpeg", 0.9);
  }

  function onBytes(bytes, imageData) {
    const result = decode(bytes);
    if (imageData) result.scanned = imageDataUrl(imageData);
    renderResult(result);
  }

  scanBtn.addEventListener("click", async () => {
    homeStatus.textContent = "";
    scanBtn.disabled = true;
    try {
      // keyboard focus after the scanner closes: the result, once there is one
      const returnFocus = () => (resultCard.classList.contains("hidden") ? scanBtn : resultCard);
      await LicenceScanner.open({ onBytes, returnFocus });
    } catch (err) {
      homeStatus.textContent = `Camera unavailable: ${err.name || ""} ${err.message || err}`;
    } finally {
      scanBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------ render
  const FINDINGS = {
    licence_number_format: "Licence number has an unexpected format",
    id_number_check_digit: "ID number check digit is wrong",
    id_number_birth_date: "ID number doesn't match the birth date",
    validity_order: "Valid-from is not before valid-to",
    validity_not_five_years: "Validity is not the usual five years",
    unknown_code: "Unknown vehicle code",
  };
  const TODAY = {
    expired: (l) => `This licence expired on ${l.valid_to}`,
    not_yet_valid: (l) => `This licence is only valid from ${l.valid_from}`,
    prdp_expired: (l) => `The PrDP expired on ${l.prdp_expiry}`,
  };
  const GENDER = { "01": "Male", "02": "Female" };

  function renderResult(result) {
    scanBtn.textContent = "Scan again";
    resultCard.classList.remove("hidden");
    resultFields.innerHTML = "";

    if (!result.ok) {
      resultError.textContent = result.error;
      resultError.classList.remove("hidden");
      resultPhoto.classList.add("hidden");
      resultScannedWrap.classList.add("hidden");
      return;
    }
    const l = result.licence;
    const blocking = result.findings.filter((f) => SADL.BLOCKING.includes(f));
    const problems = [...result.today.map((f) => TODAY[f](l)), ...blocking.map((f) => FINDINGS[f])];
    resultError.textContent = problems.join(". ");
    resultError.classList.toggle("hidden", !problems.length);

    const idOk = !result.findings.includes("id_number_check_digit") && !result.findings.includes("id_number_birth_date");
    appendRow("Initials", l.initials);
    appendRow("Surname", l.surname);
    appendRow("ID number", `${l.id_number} ${idOk ? "(valid)" : "(INVALID)"}`);
    appendRow("Date of birth", l.birth_date);
    appendRow("Gender", GENDER[l.gender] || l.gender);
    appendRow("Licence number", l.licence_number);
    appendRow("Valid from", l.valid_from);
    appendRow("Valid to", l.valid_to);
    appendRow("ID country", l.id_country);
    appendRow("Licence country", l.licence_country);
    appendRow(
      "Vehicle codes",
      l.vehicle_codes
        .map((v) => `${v.code} (restriction ${v.vehicle_restriction || "none"}, first issued ${v.first_issue || "?"})`)
        .join(", ") || "-"
    );
    appendRow("Driver restrictions", l.driver_restrictions === "00" ? "none" : l.driver_restrictions);
    appendRow("PrDP", l.prdp_categories.length ? `${l.prdp_categories.join(", ")}, expires ${l.prdp_expiry || "?"}` : "none");
    const notes = result.findings.filter((f) => !SADL.BLOCKING.includes(f));
    if (notes.length) appendRow("Notes", notes.map((f) => FINDINGS[f]).join(". "));

    if (result.photo) {
      resultPhoto.src = result.photo;
      resultPhoto.classList.remove("hidden");
    } else {
      resultPhoto.classList.add("hidden");
      appendRow("Photo", result.photoError);
    }

    if (result.scanned) {
      resultScannedImage.src = result.scanned;
      resultScannedWrap.classList.remove("hidden");
    } else {
      resultScannedWrap.classList.add("hidden");
    }
  }

  function appendRow(label, value) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = label;
    const td2 = document.createElement("td");
    td2.textContent = value;
    tr.appendChild(td1);
    tr.appendChild(td2);
    resultFields.appendChild(tr);
  }
})();

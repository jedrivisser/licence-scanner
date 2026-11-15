# Security

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/jedrivisser/licence-scanner/security/advisories/new). Don't open a
public issue for them.

Everything runs in the browser and the site is static files with no server code, so the parts that matter most
are the handling of scanned data (it should never leave the device) and the wallet's stored barcode. Only the
latest version on `main` (the published site) is supported.

Please don't include a real person's licence barcode, frames or photo in a report; describe the problem or use
the synthetic test data in `tests/js/fixtures/`.

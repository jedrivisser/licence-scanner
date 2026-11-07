# web/ is the whole site: static files, no build step.

# Local run: about page http://localhost:8080/, scanner /scan/, wallet
# /show/. Browsers allow the camera on localhost without HTTPS.
.PHONY: serve
serve:
	python3 -m http.server 8080 --bind 127.0.0.1 --directory web

.PHONY: test
test:
	node --test tests/js/*.test.js

# The six public card barcodes (real people's details: never commit them)
# for the byte-for-byte tests in tests/js/sadl.test.js.
.PHONY: public-vectors
public-vectors:
	mkdir -p third_party
	curl -sfL -o third_party/UnitTest1.cs \
		https://raw.githubusercontent.com/DanieLeeuwner/Reply.Net.SADL/292402a9d437fbb44568dd5076eb50cc86040245/Reply.Net.SADL/Reply.Net.SADL.Tests/UnitTest1.cs

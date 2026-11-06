# web/ is the whole site: static files, no build step.

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

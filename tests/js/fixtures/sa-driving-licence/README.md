Test vectors from [FrancoisSt/sa-driving-licence-barcode](https://github.com/FrancoisSt/sa-driving-licence-barcode)
(`spec/test-vectors/` as of commit `ef01bfee40b23294e201f50f56f5a229d29e99e5`, MIT, see [LICENSE](LICENSE)),
unchanged. All values are synthetic, except the hashes in
`public-vectors.json` and `wi-checkpoints.json`, which are of the six public card barcodes in
[DanieLeeuwner/Reply.Net.SADL](https://github.com/DanieLeeuwner/Reply.Net.SADL). Those barcodes hold real people's
details, so they are not committed: `make public-vectors` fetches them into the git-ignored `third_party/`.

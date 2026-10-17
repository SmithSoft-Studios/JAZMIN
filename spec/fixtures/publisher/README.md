# Publisher signature test vectors (spec 6.9)

Files signed as `docs/rfc/draft-jazmin-format-03.md` section 6.9 says, with a **test** PKI, and what a reader must
conclude from each (`expected.json`).

> **Every key and certificate here is for tests only.** The private keys are published in `test-keys/` on purpose, so
> other implementations can sign new vectors. Never trust anything signed with them, and never build the test root
> into a release.

## Regenerate and check

```
dotnet run -c Release dotnet/scripts/publisher-vectors.cs              # writes this folder; keeps pki/ when it exists
dotnet run -c Release dotnet/scripts/publisher-vectors.cs -- --new-pki # also makes the certificates again
dotnet run -c Release dotnet/scripts/publisher-verify.cs               # verifies every file and compares with expected.json
```

Keys come from fixed seeds (`d = (OS2IP(HKDF-SHA256(seed, info = "test-key/<name>")) mod (n - 1)) + 1`), so they are
the same on every run; certificates are kept unless `--new-pki` is given. ECDSA signatures, and the file ids, salts and
nonces the library writes, are random, so the `.jzm`, `.jws`, log and QR files change on every run. Their expected
results don't (`fileDigest` in `expected.json` changes with them).

`publisher-verify.cs` shares no code with the generator. It reads certificates with its own strict DER parser, because
on Windows .NET's `X509Certificate2` can't read an extension whose OID has a 128-bit arc, as the `2.25` test arc has.
It also opens every file with this repository's library (release 1.7.1, which knows nothing of 6.9): the library reads
the rows of every signed file. The JavaScript library (1.7.1) was checked the same way, with the same result.

## Files

| File | Expected result | What it is |
|---|---|---|
| `signed-plain.jzm` | certified | A payslip, not encrypted. `status/signed-plain.online.jws` and `status/signed-plain.confirmation.jws` are about it |
| `signed-password.jzm` | certified | Encrypted with a password; the facts too |
| `signed-shared.jzm` | certified | Access-controlled: covers the header and the owner's signature section; facts open with the owner or the access key |
| `signed-cosigned.jzm` | certified | Encrypted with a key; co-signed by an auditor (role `cosigner`) |
| `signed-sole-trader.jzm` | certified | Kind `individual`: Thandi Mokoena, trading as TM Bookkeeping |
| `signed-paper.jzm` | certified | Its QR string (6.9.7) is `signed-paper.qr.txt` |
| `expired-certificate.jzm` | certified | Signed in 2025 with a certificate that has since expired |
| `revoked-before.jzm` | certified | Signed before the date the revocation list revokes its certificate from |
| `superseded.jzm`, `withdrawn.jzm` | superseded, withdrawn | The status answer in the block says so |
| `timestamp-outside.jzm` | invalid (`validity`) | Timestamped after its certificate expired |
| `revoked.jzm` | invalid (`revoked`) | Timestamped after the revocation list's `from` |
| `stripped-algorithm.jzm` | invalid (`algorithms`) | `algorithms` lists ES256 and ML-DSA-65; the ML-DSA-65 signature was removed |
| `untrusted-root.jzm` | signed (no name) | Its chain names Sable Line Logistics but ends in a self-signed root that isn't trusted |
| `changed-byte.jzm` | changed (`digest`) | One byte before B changed and its section's CRC fixed: readers show the new text |
| `changed-gap.jzm` | changed (`coverage`) | One byte between the header and the signature section |
| `changed-trailing-byte.jzm` | changed (`after-trailer`) | One byte after the trailer: readers refuse the file (4.2); the verifier finds the last valid trailer as 11.2 does |
| `changed-extra-byte.jzm` | none | One byte between the block and the header: the 16 bytes before the header are no longer a footer |
| `appended.jzm` | none | Appended to by the library after signing: the new header has no block before it |
| `unsigned.jzm` | none | No block |

- `expected.json`: the time to verify at (`2026-10-17T12:00:00Z`), the trusted root, the revocation list, the log's
  verifier key, the files' keys and password, and per file the result: `status`, the publisher's `name`,
  `organization`, `registration`, `country`, `domain` and `kind` (`company` or `individual`), the document `code`,
  `documentKind`, `credential`, `signedAt`, `timestamp`, `cosigners`, `facts` (with the file's key when it is
  encrypted: `factsNeedKey`), the status answer in the block, and `reason` (`changed`: `digest`, `coverage`,
  `after-trailer`; `invalid`: `algorithms`, `validity`, `revoked`, and also `block`, `signature`, `chain`,
  `timestamp`, `log-receipt`, `status`, `facts`). `library` says what this repository's library reads.
- `pki/`: the certificates, DER and PEM. Trusted: `test-root` (P-384, path length 1), `test-issuing` (P-256, path
  length 0), the publishers `sable-line-logistics` (2026), `sable-line-logistics-2025` (expired),
  `sable-line-logistics-payroll` (revoked from 2026-09-15), `tm-bookkeeping`, the co-signer `khumalo-partners`, and
  `test-status`, `test-confirmation`, `test-timestamping`. Not trusted: `untrusted-*`. `test-log.pub.pem` is the log's
  key.
- `test-keys/`: every private key (PKCS #8 PEM). **Tests only.**
- `status/`: the status answers in the blocks (`*.status.jws`), an online answer for a nonce of its own, the
  revocation list and a confirmation receipt.
- `log/`: the transparency log: `leaves.json` (the entries, oldest first), `checkpoint.txt`, `test-log.vkey`, and each
  signature's receipt (`<file>.<role>.proof.txt`, the same bytes as in the block).

## Test object identifiers

Under `2.25.75298837481848457984537899361864557046` (UUID `38a60751-917e-4991-bc8d-b130f0d8a1f6`, X.667), until the
certifier's arc is assigned:

| Name | OID |
|---|---|
| id-jazmin-policy | `<arc>.1` (also the time-stamping policy in the tokens) |
| id-jazmin-document-signing | `<arc>.2` |
| id-jazmin-status | `<arc>.3` |
| id-jazmin-confirmation | `<arc>.4` |
| id-jazmin-publisher-kind | `<arc>.5` (a non-critical extension holding a UTF8String) |

## Choices where 6.9 leaves room

These vectors pick one answer for each; the spec should say which.

- **Facts in encrypted files:** key `HKDF(ikm, preamble salt, "JAZMIN/1/publisher/facts")`, with the header's `ikm`
  (the master key, or `H`); stored `nonce || ciphertext || tag`, not compressed; associated data
  `file_id || 00 01 00 00 || u32(raw length) || "publisher/facts"`: the envelope bytes 0..7 a codec-0 encrypted section
  of that length would have.
- **`algorithms`:** the distinct algorithms of the block's signatures, compared as a set.
- **Log:** an entry per signature; the RFC 9162 leaf is `SHA-256(0x00 || SHA-256(signed))`. `log_receipt` is a C2SP
  `tlog-proof@v1` text. The checkpoint is signed with ECDSA P-256 as C2SP signed-note type `0x02`: key ID
  `SHA-256(SPKI)[0..3]`, signature DER over SHA-256 of the note text, verifier key `name+id+base64(0x02 || SPKI)`.
- **JWS payloads:** times as RFC 3339 UTC (`2026-10-01T09:00:00Z`), `digest`, `nonce` and `facts` base64url without
  padding, `serial` lowercase hex; `digest` is the file digest D. Header: `alg` and `x5c` (the signer, then the issuing
  certificate). Revocation `reason` uses RFC 5280's names.
- **QR:** the payload is a CBOR map with text keys `code`, `kind`, `facts` (a map of text) and `signed_at` (integer
  milliseconds); the protected header holds `alg` (-7) and `kid`; zlib at the highest level.
- **Certificates:** ecdsa-with-SHA384 for what the root signs (the root and the issuing certificate), ecdsa-with-SHA256
  for the rest; SKI and AKI as RFC 5280 asks, basic constraints critical (also `cA` false in leaves).
- **A "signed" result** checks the signature and that the carried chain is consistent, and shows nothing from the
  block: no name, kind, code or facts. The untrusted signature has no timestamp, log receipt or status.

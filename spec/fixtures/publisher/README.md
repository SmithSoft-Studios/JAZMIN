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

`publisher-verify.cs` shares no code with the generator and reads certificates with its own strict DER parser, as 6.9.4
requires. It also opens every file with this repository's library (release 1.7.1, which knows nothing of 6.9): the
library reads the rows of every signed file, and refuses only the one with a byte after its trailer. The JavaScript
library (1.7.1) gives the same result.

## Files

| File | Expected result | What it is |
|---|---|---|
| `signed-plain.jzm` | certified | A payslip, not encrypted. `status/signed-plain.online.jws` and `status/signed-plain.confirmation.jws` are about it |
| `signed-password.jzm` | certified | Encrypted with a password; the facts too |
| `signed-shared.jzm` | certified | Access-controlled: covers the header and the owner's signature section; facts open with the owner or the access key |
| `signed-cosigned.jzm` | certified | Encrypted with a key; co-signed by an auditor |
| `signed-sole-trader.jzm` | certified | Kind `individual`: Thandi Mokoena, trading as TM Bookkeeping |
| `signed-paper.jzm` | certified | Its QR string (6.9.7) is `signed-paper.qr.txt` |
| `cross-certified.jzm` | certified | Signed under a new root readers don't have: the chain ends in a cross-certificate the trusted root signed |
| `expired-certificate.jzm` | certified | Signed in 2025 with a certificate that has since expired |
| `revoked-before.jzm` | certified | Signed before the date the revocation list revokes its certificate from |
| `superseded.jzm`, `withdrawn.jzm` | superseded, withdrawn | The status stored in the block says so |
| `timestamp-outside.jzm` | invalid (`timestamp`) | Timestamped after its certificate expired: the timestamp isn't inside the chain's validity |
| `revoked.jzm` | invalid (`revoked`) | Its stored status says valid; the more recent revocation list revokes it from before the timestamp |
| `stripped-algorithm.jzm` | invalid (`algorithms`) | `algorithms` is ES256, ML-DSA-65; the ML-DSA-65 signature was removed |
| `stripped-cosignature.jzm` | invalid (`algorithms`) | `algorithms` is ES256, ES256; the auditor's co-signature was removed |
| `invalid-block-crc.jzm` | invalid (`block`) | One byte of the block's payload changed: its CRC no longer matches |
| `invalid-block-reserved.jzm` | invalid (`block`) | The footer's `reserved` field isn't zero |
| `untrusted-root.jzm` | signed | Its chain names Sable Line Logistics but ends in a self-signed root that isn't trusted |
| `cross-untrusted.jzm` | signed | Its cross-certificate has the trusted root's name but another key |
| `self-signed.jzm` | signed | Signed with one's own key: a self-signed certificate, alone |
| `changed-byte.jzm` | changed (`digest`) | One byte before B changed and its section's CRC fixed: readers show the new text |
| `changed-gap.jzm` | changed (`coverage`) | One byte between the header and the signature section |
| `changed-extra-byte.jzm` | none | One byte between the block and the header: the 16 bytes before the header are no longer a footer |
| `appended.jzm` | none | Appended to by the library after signing: the new header has no block before it |
| `unsigned.jzm` | none | No block |
| `changed-trailing-byte.jzm` | not verified (`not-a-valid-file`) | One byte after the trailer: not a valid file (4.2); readers refuse it |

A `signed` result shows no name, kind, code or facts. One signature's block in `signed-plain.jzm` is 4,911 bytes: the
leaf and issuing certificates 1,240, the time-stamping, status and log certificates the block shares 1,721, the stored
status 579, the timestamp 506, the log receipt 459, the signed document 154, the facts 120.

- `expected.json`: the time to verify at (`2026-10-17T12:00:00Z`), the trusted root, the revocation list, the log, the
  files' keys and password, and per file the result: `status`, the publisher's `name`, `organization`, `registration`,
  `country`, `domain` and `kind` (`company` or `individual`), the document `code`, `documentKind`, `credential`,
  `signedAt`, `timestamp`, `cosigners`, `facts` (with the file's key when it is encrypted: `factsNeedKey`), the stored
  status answer, and `reason`: for `changed`, `digest` or `coverage`; for `invalid`, one of 6.9.8's `block`,
  `algorithms`, `signature`, `chain`, `timestamp`, `log`, `revoked` and `facts`. `library` says what this repository's
  library reads.
- `pki/`: the certificates, DER and PEM. Trusted chain: `test-root` (P-384, path length 2), `test-issuing`, the
  publishers `sable-line-logistics` (2026), `sable-line-logistics-2025` (expired), `sable-line-logistics-payroll`
  (revoked from 2026-09-15), `tm-bookkeeping`, the co-signer `khumalo-partners`, and `test-status`,
  `test-confirmation`, `test-timestamping`, `test-log`. The new root: `test-root-2` (self-signed, not trusted),
  `test-root-2-cross` (its key certified by `test-root`), `test-issuing-2`, `sable-line-logistics-root-2`. Not trusted:
  `untrusted-*` and `self-signed-sable-line-logistics`.
- `test-keys/`: every private key (PKCS #8 PEM). **Tests only.**
- `status/`: the status answers stored in the blocks (`*.status.jws`: `x5t#S256` names the status certificate, which
  the block carries, so there is no `x5c`), an online answer for a nonce of its own, the revocation list and a
  confirmation receipt.
- `log/`: the transparency log, whose origin `log.jazmin.example/test` is the log certificate's commonName:
  `leaves.json` (an entry per signature, oldest first, the stripped co-signature's included), `checkpoint.txt`,
  `test-log.vkey`, and each signature's receipt (`<file>.<role>.proof.txt`, the same text as in the block).

## Test object identifiers

Under `2.999.1` (6.9.4): `.1` id-jazmin-policy (also the time-stamping policy in the tokens), `.2`
id-jazmin-document-signing, `.3` id-jazmin-status, `.4` id-jazmin-confirmation, `.5` id-jazmin-publisher-kind, `.6`
id-jazmin-log.

## Readings where 6.9 leaves room

- A **stored status answer that doesn't verify** (signature, chain, `digest`, `nonce`, `certificate`, or a missing
  `from`) isn't used, as if the block had none: 6.9.8 names no reason for it.
- A block whose **first signature isn't the publisher's** (or with another role) is invalid with reason `algorithms`,
  the step 3 check it belongs to.

The libraries (`js/test/publisher.test.js`, `dotnet/tests/Jazmin.Tests/PublisherTests.cs`) check every file here, and
read these the same way:

- A **key or password that doesn't open the file** leaves the facts unread (`facts` null); only facts that don't decrypt
  with a key that reads the header are invalid (`facts`).
- **Key slots after `B`** (the trailer points into the block or the header): changed (`coverage`), since every section
  the trailer points to must be covered (6.9.1).
- A **revocation with a reason name the reader doesn't know** still revokes; a list that doesn't verify, or lacks
  `revoked` or an entry's `from`, isn't used. A certificate listed twice is revoked from the earlier `from`.
- **Times** in statements are RFC 3339 UTC strings ending in `Z`; `+02:00`, no zone or an empty fraction make the
  statement unusable.
- A status answer whose `from` is present but malformed isn't used. Of statements with the same time, the first of the
  stored status, the list and the online answer counts.

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
| `timestamp-outside.jzm` | invalid (`validity`) | Timestamped after its certificate expired |
| `revoked.jzm` | invalid (`revoked`) | Its stored status says valid; the more recent revocation list revokes it from before the timestamp |
| `stripped-algorithm.jzm` | invalid (`algorithms`) | `algorithms` is ES256, ML-DSA-65; the ML-DSA-65 signature was removed |
| `stripped-cosignature.jzm` | invalid (`algorithms`) | `algorithms` is ES256, ES256; the auditor's co-signature was removed |
| `invalid-block-crc.jzm` | invalid (`block`) | One byte of the block's payload changed: its CRC no longer matches |
| `untrusted-root.jzm` | signed | Its chain names Sable Line Logistics but ends in a self-signed root that isn't trusted |
| `cross-untrusted.jzm` | signed | Its cross-certificate has the trusted root's name but another key |
| `self-signed.jzm` | signed | Signed with one's own key: a self-signed certificate, alone |
| `changed-byte.jzm` | changed (`digest`) | One byte before B changed and its section's CRC fixed: readers show the new text |
| `changed-gap.jzm` | changed (`coverage`) | One byte between the header and the signature section |
| `changed-extra-byte.jzm` | none | One byte between the block and the header: the 16 bytes before the header are no longer a footer |
| `appended.jzm` | none | Appended to by the library after signing: the new header has no block before it |
| `unsigned.jzm` | none | No block |
| `changed-trailing-byte.jzm` | not verified (`not-a-valid-file`) | One byte after the trailer: not a valid file (4.2); readers refuse it |

A `signed` result shows no name, kind, code or facts. One signature's block in `signed-plain.jzm` is 4,832 bytes: the
leaf and issuing certificates 1,238, the time-stamping, status and log certificates the block shares 1,716, the
timestamp 506, the log receipt 463, the stored status 503, the signed document 154, the facts 120.

- `expected.json`: the time to verify at (`2026-10-17T12:00:00Z`), the trusted root, the revocation list, the log, the
  files' keys and password, and per file the result: `status`, the publisher's `name`, `organization`, `registration`,
  `country`, `domain` and `kind` (`company` or `individual`), the document `code`, `documentKind`, `credential`,
  `signedAt`, `timestamp`, `cosigners`, `facts` (with the file's key when it is encrypted: `factsNeedKey`), the stored
  status answer, and `reason` (`changed`: `digest`, `coverage`; `invalid`: `block`, `algorithms`, `validity`,
  `revoked`, and also `roles`, `signature`, `chain`, `timestamp`, `log-receipt`, `status`, `facts`). `library` says what
  this repository's library reads.
- `pki/`: the certificates, DER and PEM. Trusted chain: `test-root` (P-384, path length 2), `test-issuing`, the
  publishers `sable-line-logistics` (2026), `sable-line-logistics-2025` (expired), `sable-line-logistics-payroll`
  (revoked from 2026-09-15), `tm-bookkeeping`, the co-signer `khumalo-partners`, and `test-status`,
  `test-confirmation`, `test-timestamping`, `test-log`. The new root: `test-root-2` (self-signed, not trusted),
  `test-root-2-cross` (its key certified by `test-root`), `test-issuing-2`, `sable-line-logistics-root-2`. Not trusted:
  `untrusted-*` and `self-signed-sable-line-logistics`.
- `test-keys/`: every private key (PKCS #8 PEM). **Tests only.**
- `status/`: the status answers stored in the blocks (`*.status.jws`, without `x5c`: the block carries the status
  certificate), an online answer for a nonce of its own, the revocation list and a confirmation receipt.
- `log/`: the transparency log: `leaves.json` (an entry per signature, oldest first, the stripped co-signature's
  included), `checkpoint.txt`, `test-log.vkey`, and each signature's receipt (`<file>.<role>.proof.txt`, the same text
  as in the block).

## Test object identifiers

Under `2.999.1` (6.9.4): `.1` id-jazmin-policy (also the time-stamping policy in the tokens), `.2`
id-jazmin-document-signing, `.3` id-jazmin-status, `.4` id-jazmin-confirmation, `.5` id-jazmin-publisher-kind, `.6`
id-jazmin-log.

## Readings where 6.9 leaves room

- **Facts key** with a key or password: the key 7.3 gives a section named `publisher/facts`,
  `HKDF(master, keyring.data, "JAZMIN/1/publisher/facts")`, the keyring read from the decrypted header;
  access-controlled: `HKDF(H, preamble salt, "JAZMIN/1/publisher/facts")`.
- **Cross-certificate:** the root's row (P-384, ecdsa-with-SHA384, path length 2), signed by the other root.
- **Shared certificates:** the time-stamping, status and log certificates, and their issuing certificate when no
  signature's chain carries it. A shared certificate's issuing certificate is found among all the block's certificates.
- **A JWS without `x5c`** is checked against the block's certificates with the matching extended key usage.
- **Which status wins:** for a certificate's revocation, the most recent of the stored status and the revocation list;
  whether a document is withdrawn or superseded, from the status answer (a revocation list says nothing about it).
- **The log:** origin `log.jazmin.example/test`, also the checkpoint signature's key name; the signature is DER ECDSA
  over SHA-256 of the note text; the log certificate is checked at the signature's timestamp.
- **Co-signers** whose chain isn't trusted, beside a trusted publisher, make the result invalid (`chain`).

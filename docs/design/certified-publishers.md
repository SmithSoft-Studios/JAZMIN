# Certified publishers: signatures only SmithSoft can certify

Status: **decided** (owner, 2026-10-16 and 2026-10-17), for 1.8.0. The decisions are listed at the end. **Next:**
spec text (a new section 6.9) and test vectors made with a test root, then the libraries. This note covers what goes
in a file and how anyone checks it. How SmithSoft runs the services that issue certificates and sign is private, and
is not part of this repository.

## The idea in plain words

A JAZMIN file can hold anything, so a reader needs to know **who made it**. A certified publisher's files show, in
the viewer's own frame, **"Verified publisher: Sable Line Logistics (Pty) Ltd"**, or for a sole trader **"Verified
individual: Thandi Mokoena, trading as TM Bookkeeping"**. This works like code signing:

- SmithSoft checks a company or sole trader once (who they are, and that they are licensed) and issues a
  **certificate**: a small, signed statement that binds their verified name to a signing key.
- Documents are signed with that key. The signature covers the document's bytes and carries the certificate.
- Any viewer checks the signature, the certificate and the chain back to SmithSoft's **root**, a key whose public
  half is built into the libraries and viewers. No one but SmithSoft can make a file show as certified.

Checking is free, works offline, and is done by the open-source libraries. Certifying and signing are paid services.

## Public and private

Security rests on keeping the **keys** secret, never on keeping the **method** secret (Kerckhoffs's principle). So:

| Public (this repository, MIT) | Private (SmithSoft's services) |
|---|---|
| What a signature in a file looks like; the certificate profile | The issuing service, identity checks and fraud rules |
| How to verify, in every library and the viewer | Key ceremonies, the security modules' setup, admin access |
| SmithSoft's root public keys | The signing service, its metering and billing |
| The online check's and the revocation list's formats | Infrastructure, network layout, incident runbooks |
| Test vectors made with a **test** root | Every private key (none is ever in any repository) |

Making verification public is what makes the badge worth something: auditors, banks and other implementations can
check it themselves. Certificate authorities publish their policies for the same reason; SmithSoft will publish its
certificate policy and practice statement.

## What a signed file carries

A new optional section, the **publisher signature**, in any JAZMIN file (shared or not). It holds:

1. **What is signed:** the SHA-256 digest of the file's bytes as they were signed, and the algorithm used.
2. **One or more signatures** over it. Each names its algorithm, so a file can carry two (today's ECDSA P-256 and a
   post-quantum ML-DSA one later); a viewer checks those it knows.
3. **The certificate chain:** the publisher's certificate and the issuing certificate that signed it (the root is
   built in, never carried).
4. **A timestamp** (RFC 3161) from SmithSoft's time-stamping service: proof of when it was signed.
5. **A log receipt:** proof that SmithSoft's public transparency log recorded this signature (a signed checkpoint and
   an inclusion proof).
6. **The status at signing time:** SmithSoft's signed statement that the certificate was valid then, so the file can
   be checked years later without asking anyone (long-term validation).

A later append or rewrite changes the bytes, so it needs a new signature; until then viewers say **"Changed after it
was signed"**. Readers that don't know the section ignore it and open the file as before, without a badge.

## Certificates: a strict X.509 profile

Standard X.509 certificates (RFC 5280), limited to one JAZMIN profile and read by a small, strict parser in each
library that refuses anything outside it (no general X.509 parsing, so no large attack surface):

| Certificate | Key | Valid for | Can sign |
|---|---|---|---|
| SmithSoft root | ECDSA P-384, offline | about 20 years | issuing certificates only |
| Issuing | ECDSA P-256, in a security module | about 2 years | publisher, status and time-stamping certificates only (path length 0) |
| Publisher | ECDSA P-256, in SmithSoft's security module (hosted signing) | 1 year | documents only (not a CA; "JAZMIN document signing" key usage) |
| Status, time-stamping, log | ECDSA P-256, in a security module | about 1 year | status answers, timestamps, log checkpoints |

**Who a publisher certificate names:**

- **Companies:** legal name, country (ISO 3166), the registry and registration number (CIPC in South Africa, Companies
  House in the UK, a national register elsewhere), optionally the global **LEI**, and a verified domain.
- **Sole traders:** the person's verified name, country, "sole trader", and a trading name if they have one.
- Names in UTF-8. Our own identifiers (the certificate policy, the "JAZMIN document signing" usage, our fields) sit
  under SmithSoft's IANA Private Enterprise Number, so they never clash with anyone's.

## Verifying a file (free, offline)

1. The digest of the file's bytes matches the signed digest.
2. The signature verifies with the publisher certificate's key.
3. The publisher certificate was signed by an issuing certificate, which was signed by a root built into the library.
   The chain is exactly root, issuing, publisher: no longer, and each certificate may only do what its row above says.
4. The timestamp is valid and falls inside the publisher certificate's validity.
5. The certificate was not revoked at the time of signing: from the status carried in the file, a revocation list the
   viewer already has, or the online check.
6. The log receipt verifies against the log's key.

The result: `certified` (with the verified name), `signed` (a valid signature, but not from a SmithSoft certificate:
"Signed, publisher not certified"), `changed` (signed, then changed), `invalid` (with the reason), or `none`.

## The online check, which can't be faked

Offline checking proves who signed and when. The online check adds freshness: is the certificate revoked now?

1. The viewer sends the file's digest, the certificate's serial number and a **fresh random number** (a nonce).
2. SmithSoft answers `{ digest, serial, status, time, nonce }`, **signed with a status key** whose certificate chains
   to the root.
3. The viewer trusts only the signature. A fake server, or anyone in between, can't sign; an old answer can't be
   replayed, because it carries another nonce.

Viewers also fetch SmithSoft's signed revocation list (a static file on a CDN) when online and keep it. They say how
fresh their answer is: "Verified publisher, checked online just now" or "Verified publisher (offline; revocation list
from 3 days ago)".

## Revocation

- **Expired or not renewed:** documents signed while the certificate was valid **stay valid**: the timestamp proves
  when they were signed. New signatures fail.
- **Revoked** (fraud, a stolen key, a licence withdrawn): the revocation names a date. Documents signed after it show
  "Not valid"; earlier ones stay valid. With hosted signing a key can't be stolen from the publisher, which keeps such
  dates rare.

## The transparency log

Every certificate SmithSoft issues and every signature its signing service makes is added to an append-only log (a
Merkle tree, as browsers use for HTTPS certificates). Its signed checkpoints are public. A publisher can watch it for
certificates issued in its name; anyone can check that the log was never rewritten. It guards against a mistake or a
rogue insider at SmithSoft, not only outside attackers.

## Trust store: SmithSoft only

- Only SmithSoft's roots give the badge. A library or viewer has no way to add another root for it.
- The library holds a **list** of trusted roots, so a new root can be introduced, before the old one ends, by a
  statement the old root signs. A file signed under the old root stays valid.
- Someone who changes the open-source library to trust their own root fools only their own copy. The official
  libraries, viewer and Scout, and a verify page on SmithSoft's own domain, stay the reference.

## What viewers show

The result is shown **in the viewer's own frame, never inside the document**: a document's page can draw anything,
including a fake badge. Clicking it shows the certificate: the verified name, registration, country, domain, when it
was signed, and how fresh the revocation check is. The User Guide tells people to trust only that frame.

## Built to change, for use worldwide

- **Algorithms:** each signature names its algorithm, and a file can carry several, so post-quantum signatures
  (ML-DSA, NIST FIPS 204) can be added beside ECDSA without breaking older viewers.
- **Long life:** the status at signing time travels in the file, and a fresh timestamp can be added over the file
  before an algorithm weakens (as in Europe's long-term signature standards from ETSI).
- **Identity:** country, registry and registration number, with an optional LEI, work in any country.
- **Standards:** X.509 (RFC 5280), RFC 3161 timestamps, a published certificate policy and practice statement, and,
  later, an outside audit (WebTrust or ETSI EN 319 411).
- **Law:** the "Verified publisher" badge is SmithSoft's own. Legal-grade signatures (South Africa's ECT Act
  "advanced electronic signature", eIDAS qualified signatures in the EU) need accredited providers; the format leaves
  room to show one beside the badge, as a separate line, if SmithSoft is accredited or partners with an accredited
  provider. No legal standing is claimed before legal advice.

## The libraries (free)

- `verifyPublisher(file)` (.NET `JazminFile.VerifyPublisher`) returns `{ status, name, kind (company | individual),
  registration, country, domain, signedAt, checkedAt, reason }`, with the built-in roots and an optional revocation
  list; `verifyPublisher(file, { online: true })` makes the online check.
- Signing through SmithSoft's signing service (`signWith(service)`), and signing with your own key, which gives
  "Signed, publisher not certified".
- The browser reader and the web viewer verify as the libraries do.

## Decisions (owner)

1. **Repositories (2026-10-16):** verification public here; SmithSoft's services in a separate private repository;
   Scout a client with no secrets.
2. **Certificates (2026-10-16):** a strict X.509 profile, built to change and for use worldwide (as above).
3. **Hosting (2026-10-16):** AWS, Cape Town; keys in AWS KMS's security modules, the root offline in SmithSoft's own.
4. **Licence model first (2026-10-16):** hosted signing (keys never leave the security module; every signature counted).
5. **Who (2026-10-17):** registered companies **and** sole traders, from launch.
6. **Trust store (2026-10-17):** SmithSoft's roots only.
7. **Timestamps (2026-10-17):** SmithSoft's own RFC 3161 service.

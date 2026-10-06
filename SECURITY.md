# Security policy

## Reporting a vulnerability

Please report security problems privately by email to
**dssmith@smithsoft.co.za**. Do not open a public issue for them.

Please include:
- what is affected: the library and its version, the viewer, or the format
  specification;
- how to reproduce it, ideally with a small file or code sample;
- what an attacker could achieve with it.

We will confirm that we received your report, keep you informed while we fix
it, and credit you in the release notes unless you prefer not to be named.

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | Yes |
| 1.0.x | No: upgrade to 1.1 (it fixes a data-loss bug in the JS writer) |
| Pre-release versions (before 1.0.0) | No |

## Scope

In scope:
- the libraries (npm `@smithsoft-studios/jazmin`, NuGet `Jazmin`) and the viewer;
- the file format's security design: key hierarchy, encryption, signatures,
  access control and expiry. The design is described in
  [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) and in the format
  specification.

The keys, passwords and files under `spec/fixtures` are test data and public
by design.

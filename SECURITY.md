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

## What package scanners report

Scanners such as Socket list what the npm package does. Each of these is
expected:

- **Code generation (`new Function`, reported as "eval"):** `src/reader.js`
  builds each row object with one object literal, so every row has the same
  shape in V8. That builds rows 2 to 3 times faster than any way without
  generated code.
  - **Only names and numbers go in:** the generated code holds column names,
    written as JSON strings, and integers. A column name never runs as code;
    `test/column-names.test.js` checks names built to break out.
  - **Without code generation** (`node --disallow-code-generation-from-strings`,
    or a strict Content Security Policy), the reader builds rows without it,
    more slowly.
  - **The browser module** (`/browser`) generates no code.
- **Environment variables:** the library reads only `LOCALAPPDATA`, on
  Windows, to find where expiring keys keep their last-seen record (it
  catches a clock set back). The `jazmin` command-line tool also reads
  `JAZMIN_KEY` and `JAZMIN_PASSWORD`, so keys need not be typed on the
  command line.
- **File system (`node:fs`):** reading and writing `.jzm` files, lock files
  and the last-seen records.
- **URL `https://json-schema.org/draft/2020-12/schema`:** the standard
  `$schema` label in the JSON Schema that `toJsonSchema` returns. Nothing is
  downloaded: the library makes no network requests. Only the browser
  module's `openUrl` fetches, and only the address it is given.

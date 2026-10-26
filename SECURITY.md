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
| 1.8.x | Yes |
| 1.7.x | Security fixes until 31 January 2027, then upgrade to 1.8 (the same file format; Node.js 22.23.4, 24.22.1 or 26.12.1 or later) |
| 1.6.x | No: upgrade to 1.8 (the same file format) |
| 1.5.x | No: upgrade to 1.8 (the same file format) |
| 1.4.x | No: upgrade to 1.8 (the same file format) |
| 1.3.x | No: upgrade to 1.8 (the same file format) |
| 1.2.x | No: upgrade to 1.8 (the same file format) |
| 1.1.x | No: upgrade to 1.8 (the same file format) |
| 1.0.x | No: upgrade to 1.8 (1.1 fixed a data-loss bug in the JS writer) |
| Pre-release versions (before 1.0.0) | No |

## Keep your runtime patched

JAZMIN decompresses with the Brotli and deflate decoders built into Node.js and .NET. CVE-2026-111497 (October 2026,
an out-of-bounds write in the Brotli decoder, rated critical) is fixed in these runtimes:

| Runtime | Fixed in | What JAZMIN does on an older one |
|---|---|---|
| Node.js | 22.23.4, 24.22.1, 26.12.1 (20.x, 23.x and 25.x are not fixed) | Refuses to decompress Brotli; `JAZMIN_ALLOW_BROTLI=1` for a build with the fix backported. `engines` names the fixed releases |
| .NET | 10.0.14 (SDK 10.0.114 or 10.0.403); 11.0.0-rc.3 for .NET 11 previews | Refuses to decompress Brotli (from 1.8.1 and 1.7.4; 1.8.0 and 1.7.3 and earlier rely on the runtime). Microsoft also fixed 8.0.33 and 9.0.22 |
| Browsers | Not used: the browser reader and the viewer don't decode Brotli | Nothing to do |

On every runtime, change files and submissions that use Brotli are refused before anything is decompressed: people
the owner doesn't control write them, and JAZMIN never writes them with Brotli. Files written with deflate (the
default) or no compression don't use the Brotli decoder. Sources: [Node.js](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases),
[.NET](https://github.com/dotnet/announcements/issues/494), [NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-111497).

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

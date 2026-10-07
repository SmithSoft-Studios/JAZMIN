# Maintaining and extending JAZMIN

This page describes how we work on JAZMIN: test-first, KISS, SOLID where it
helps, and two implementations that must always read each other's files.

## Repository layout

```
docs/rfc/          The format specification (normative)
docs/              User guide, research, backlog, this file
spec/fixtures/     Shared interop dataset + files written by each implementation
js/src/            JavaScript library (no runtime dependencies)
js/test/           node:test suites (interop.test.js reads spec/fixtures)
js/examples/       Runnable JS and TypeScript examples used in the guide
js/bench/          Benchmark vs JSON
dotnet/src/Jazmin  .NET library (no third-party dependencies)
dotnet/tests/      xUnit tests (InteropTests reads AND writes spec/fixtures)
dotnet/samples/    Runnable .NET examples used in the guide
dotnet/bench/      Benchmark vs Newtonsoft.Json and System.Text.Json
```

## Everyday commands

```bash
# JavaScript (in js/)
npm test                       # all tests, including interop with .NET-written files
npm run typecheck              # TypeScript definitions + example
npm run bench                  # node --expose-gc gives the memory rows
npm run bench:proposals        # bytes read, rows and time per query (see below)
npm run test:viewer            # the viewer in every browser found (Safari: run "sudo safaridriver --enable" once)
npm run test:viewer -- --browser ios   # Safari in the iPhone simulator (a Mac with Xcode; boot a simulator first)
node examples/quickstart.mjs

# .NET (in dotnet/)
dotnet test                    # all tests (writes its interop files to a temp folder)
JAZMIN_WRITE_FIXTURES=1 dotnet test   # also refresh spec/fixtures/dotnet-*.jzm (after format changes)
dotnet run --project samples/Jazmin.Samples
dotnet run -c Release -f net10.0 --project bench/Jazmin.Benchmarks
```

When you change the format, run `JAZMIN_WRITE_FIXTURES=1 dotnet test` before
`npm test`, so that the JavaScript side reads fresh .NET files. CI always does
this.

## Measuring what a query reads

`npm run bench:proposals` (in `js/`) writes 200,000 seeded card and account
transactions three ways: sorted by time, sorted by account, and
access-controlled. It then runs the queries behind the improvement proposals
(GitHub issues #5 to #27): lookups, account pages, keyset pages, date ranges,
deep pages, one-column sums, and `get()` by position.

For each query it prints the rows returned, the bytes read from the file and
the median time of 5 runs, each on a freshly opened reader.

- **Bytes and rows are the same on every machine**, so CI checks them against
  `js/bench/proposals-baseline.json`. The build fails if a query reads more
  than 10% more bytes, or returns different rows.
- **Times depend on the machine.** Compare them only with each other, from
  one run.
- **When a change makes a query read less**, run
  `node bench/proposals.mjs --update-baseline` and commit the new baseline in
  the same pull request. Quote the before and after numbers in the PR.

## Fuzzing the readers

A reader must reject a damaged file with a JAZMIN error (`JazminError` /
`JazminException`): never another exception, a hang or a runaway memory
allocation. The fuzzers check this by reading thousands of damaged files.
They damage plain files section by section and give each damaged section a
correct CRC-32 again, so that the damage reaches the decoders instead of
stopping at the checksum. They also feed damaged section payloads to each
decoder directly.

Both test suites run a short fuzz with fixed seeds (`fuzz.test.js`,
`FuzzTests`). They also read every file in `spec/fixtures/damaged/`: inputs
that once failed with the wrong error. For longer runs:

```bash
# JavaScript (in js/): the corpus and any failing inputs are saved in --out
node scripts/fuzz.js --minutes 60 --out fuzz-findings
node scripts/fuzz.js --replay 1234 --out fuzz-findings   # rerun one seed

# .NET (in dotnet/)
JAZMIN_FUZZ_MINUTES=60 JAZMIN_FUZZ_OUT=fuzz-findings dotnet test --filter LongRun
```

The long run before a release uses the **Fuzz (long run)** workflow, on
demand (`gh workflow run fuzz.yml`): five jobs per library, each over its own
seeds for 300 minutes, so about 25 hours of fuzzing per library in about 5
hours. A job that finds something fails and uploads its findings.

Each finding is saved as `seed-<n>.bin` with `seed-<n>.txt`, which holds
the error and whether the input was a whole file or a raw section payload.
Fix the cause in both libraries. Then copy a whole-file finding to
`spec/fixtures/damaged/<what-was-wrong>.jzm`, so that both suites keep
checking it.

## How we work

1. **Test first.** For a bug, first write a test that fails and shows the bug,
   then fix it. For a feature, first write the test that describes it.
   Keep each test focused on one behaviour.
2. **Both sides, same behaviour.** A change to behaviour that can be seen in
   files or filters needs a matching change and matching tests in *both*
   implementations. Keep file and function names parallel:

   | JavaScript | .NET |
   |---|---|
   | `binary.js` | `Format/Binary.cs` |
   | `section.js` | `Format/SectionCodec.cs` |
   | `indexes.js` | `Format/Indexes.cs` |
   | `filter.js` | `Query/BoundFilter.cs` |
   | `reader.js` / `writer.js` | `JazminReader.cs` / `JazminWriter.cs` |

3. **KISS.** Prefer a plain function to a new abstraction. Add an interface
   only when a second real implementation exists, as `IIndexBuilder` does for
   the sorted and trigram indexes.
4. **No runtime dependencies** in the core libraries. Test and benchmark
   projects may have them. For example, the benchmark uses Newtonsoft as a
   baseline.
5. **No custom cryptography.** Use the platform's AES-GCM, HKDF and PBKDF2
   only. Any change under `keys.js` / `Crypto.cs` needs a second reviewer.
6. **Errors explain themselves.** Every exception says what was wrong and
   where (row, column, section).

## Changing the file format

The format is a public contract. Files written today must stay readable.
Format 1.0 has no minor versions: additions are *features* that the header
lists (spec section 5), as Delta Lake does.

| Change | Allowed as | Required steps |
|---|---|---|
| New optional catalog field (more statistics, a new setting) that readers can ignore | No feature needed: readers skip Protocol Buffers fields they don't know | Update the RFC and `spec/jazmin.proto`; add fixtures |
| New codec, column encoding, value type or unit, index or postings encoding | A **reader feature**: a reader that does not know it refuses the file, naming it. Files list it only when they use it | Update the RFC; add fixtures written with and without the feature |
| Something a writer (including one that appends) must understand | A **writer feature** | As above |
| Changing the meaning or encoding of anything already specified | Major version (new magic, `JZM2`) only | RFC update, migration notes, readers keep supporting 1.0 |
| Bug fix in an implementation that produced off-spec files | Patch | Add a regression test; document affected versions |

Steps for a format change:

1. Update `docs/rfc/draft-jazmin-format-XX.md`. Bump the draft number and add
   a change-log entry.
2. Write failing tests on both sides.
3. Implement in JavaScript, then in .NET, or the other way round.
4. Update `js/scripts/make-fixtures.js` if the dataset needs new cases. Then
   run `npm run fixtures`, `JAZMIN_WRITE_FIXTURES=1 dotnet test` and
   `npm test`, in that order.
5. Commit the regenerated `spec/fixtures/*` files. They are the proof that the
   two implementations agree.

## Recipes

**Add a codec**

1. Assign the next codec id in the RFC (section 4.3).
2. Add it to `CODEC` in `constants.js` and `JazminCodec`.
3. Add compress/decompress branches in `section.js` and `SectionCodec.cs`.
4. Add a fixture `js-<codec>.jzm` and its .NET counterpart.

**Add a data type**

1. Update the RFC (section 5.1, the key form, and the JSON/CSV/XML mapping).
2. Update `types.js` (normalize/encode/decode) and `Values.cs`.
3. Update the CSV/XML text mapping, the TypeScript `JazminType`, and the .NET
   `TypeMap.Infer`.
4. Add the type to the interop dataset.

**Add an index kind**

1. Specify the payload in the RFC (section 8).
2. Add a builder and a reader in `indexes.js` / `Indexes.cs`, and register
   it in `INDEX_CODECS` / `LoadIndex`.
3. Teach `candidates` / `FilterEngine.Candidates` which operators it answers.
4. Add a test proving that results equal a full scan.

**Add a filter operator**

1. Update the RFC (section 9.2).
2. Update `filter.js` and `BoundFilter.cs` (validation, evaluation, index
   planning and statistics pruning).
3. Update the TypeScript `Condition`.
4. If it maps to C#, update `ExpressionTranslator`. The translation must
   produce a superset of the true matches; add a `LinqTests` case that
   compares against LINQ-to-Objects.

## Releasing

The packages are published together by `.github/workflows/release.yml`: the
npm package, and the NuGet packages `Jazmin` and (from 1.2.0) `Jazmin.AspNetCore`,
all with the same version.
It runs when a version tag is pushed. A published version number can never
be reused on npm or NuGet, so check before approving.

The workflow publishes with *trusted publishing*: each registry trusts this
repository's release workflow and gives it a key that lasts about an hour.
No long-lived npm or NuGet key is stored anywhere.

**Once, before the first release:**
- **Release environment (done):** only `v*` tags can publish through the
  `release` environment, and each release waits for a maintainer's approval
  (Settings, Environments, `release`).
- **NuGet:** on nuget.org, open your account menu, then **Trusted
  Publishing**, and add a policy:
  - owner `SmithSoft-Studios`, repository `JAZMIN`;
  - workflow file `release.yml`, environment `release`.

  Then save your nuget.org user name (the profile name, not the email) as a
  repository secret: `gh secret set NUGET_USER`.

  *Or, with a NuGet API key:* create a key on nuget.org that can push new
  packages, limited to the glob `Jazmin*` (it must cover `Jazmin.AspNetCore`
  too; a key limited to `Jazmin` cannot create it), and save it with
  `gh secret set NUGET_API_KEY`. The workflow then uses the key instead of
  trusted publishing. Trusted publishing is safer, because no key is stored.
- **npm organisation (done):** the package is published as `@smithsoft-studios/jazmin` under the
  `smithsoft-studios` npm organisation. npm refuses the plain name `jazmin`
  as too close to the `jasmine` package. An npm token must be allowed to
  publish to that organisation.
- **npm, first version:** npm can only trust a workflow for a package that
  already exists, so the first version needs one of these:
  - **A short-lived token:** on npmjs.com, under Access Tokens, create a
    granular token with read and write access to packages, allowed to bypass
    two-factor sign-in, expiring in 7 days. Save it with
    `gh secret set NPM_TOKEN`, and delete it after the release.
  - **By hand:** run `npm login` (two-factor sign-in in the browser), then
    `npm publish ./smithsoft-studios-jazmin-1.0.0.tgz --access public`, using the file that
    `check-packages.sh` makes, before pushing the tag. The workflow then sees
    the version is already on npm and skips it.
- **npm, afterwards (done 2026-10-06):** on npmjs.com, open `@smithsoft-studios/jazmin`, then **Settings**, then
  **Trusted publishing**. Add GitHub Actions with organization
  `SmithSoft-Studios`, repository `JAZMIN`, workflow `release.yml` and
  environment `release`. Later releases need no npm token: the `NPM_TOKEN`
  secret is deleted, and the first release after it (1.2.0) is the first
  published this way.
- **Signing:** npm *provenance* is a signed record of the commit and workflow
  that built the package; it is added because the repository is public.
  nuget.org signs every package it accepts.

**Each release:**
1. Work through the checklist below on `main`.
2. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
3. The workflow first checks the packages:
   - the tag matches both package versions;
   - the tests pass;
   - each package installs in an empty project and its sample runs there.
4. Then it publishes, after approval if a reviewer is required. A pre-release such as
   `1.0.0-rc.1` goes to npm's `next` tag, so `npm install @smithsoft-studios/jazmin` still gets
   the last full release.
5. Each publish job skips a version that is already on its registry, so a
   release that failed halfway can simply be re-run.

To check the packages yourself, run `bash .github/scripts/check-packages.sh`
from the repository root (in Git Bash on Windows). CI runs it on every pull
request.

## Release checklist

- [ ] `npm test`, `npm run typecheck`, `dotnet test` all pass on a clean checkout
- [ ] Fixtures regenerated, if the format changed, and committed
- [ ] Benchmarks re-run; USER-GUIDE section 9 updated if the numbers moved by more than 10%
- [ ] Versions bumped together (`js/package.json`, `Jazmin.csproj`); `CHANGELOG.md` and RFC change log updated
- [ ] TASKS.md statuses updated
- [ ] Phone check of the viewer (below), results in the release notes

### Phone check

CI tests the viewer in Chrome, Firefox and Safari on computers. Safari in the
iPhone simulator runs only when asked, because it takes about 8 minutes of a
macOS runner. To run it:
- **From the Actions tab:** choose "iPhone simulator", then "Run workflow".
- **From the command line:** `gh workflow run ios-simulator.yml --ref <branch>`.
- **On a pull request:** add the label `ios-simulator`.

Run it before a release, and when a change touches the viewer or the browser
reader.

A simulator runs the real iPhone browser engine, but it has none of a phone's
memory limits. So before each release, also check by hand on one iPhone
(Safari) and one Android phone (Chrome):

1. **Host the viewer:** put `js/viewer` and `js/browser` side by side on an
   HTTPS server the phones can reach. Installing needs HTTPS.
2. **Open a file:** on each phone, open the viewer, then choose
   `spec/fixtures/js-files-access.jzm` with the file picker.
3. **Keys:** try the owner key first: for a shared file, the viewer refuses
   it and clears the box (browsers open shared files only with access keys).
   Then unlock it with bob's access key: 80 rows. Both keys are in
   `spec/fixtures/keys.json`.
4. **Data:** the first page of rows shows, and the next page opens.
5. **Document and files:** the document shows, and `img/logo.svg` opens from
   the file list.
6. **Offline:** install the viewer (Add to Home Screen), switch on flight
   mode, start it from the home screen and open the file again.
7. **Save as HTML:** save a copy, open it from the phone's files app and
   unlock it with bob's key.

Record each step's result for both phones in the release notes, including
anything that didn't work.

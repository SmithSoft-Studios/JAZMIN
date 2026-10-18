# Working on JAZMIN with Claude (local or cloud sessions)

Read [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first (layout, commands, test-first). This page is what a session
must also do, and must never do.

## What every change does

1. **Smallest safe change.** Do the task in its issue; don't clean up nearby code or add features. Note anything else
   you find in the PR under "Outside scope - not changed".
2. **Test first.** A failing test that shows the problem, then the fix. Both libraries (`js/` and `dotnet/`) must give
   the same results, and files already written (format 1.0, releases 1.0.0 to 1.7.1) must stay readable: the files in
   `spec/fixtures` are the proof.
3. **Memory first, then speed.** Measure before and after, with several runs, and put the figures in the PR. Never state
   a figure you haven't measured.
4. **Update everything a feature touches:** `CHANGELOG.md` (an "Unreleased" entry), `docs/USER-GUIDE.md`, the spec in
   `docs/rfc/` if the format changes, `docs/TASKS.md`, and a working example (`js/examples/quickstart.mjs` and
   `dotnet/samples`) with a row in `docs/SAMPLES.md`.
5. **Run before you push:** in `js/`: `npm test`, `npm run typecheck`, `node scripts/build-browser.mjs` (after editing
   `js/browser/src`); in `dotnet/`: `dotnet test -c Release`. For the viewer: `npm run test:viewer -- --browser chrome`.
   Say plainly what passed and what you could not run.

## Git and pull requests

- Work on a branch, open a **pull request to `main`**. **Never push to `main`, never merge, never tag, never publish
  a release or a package.** The owner merges, after every CI check is green.
- Commit only as **Daniël Smith <dssmith@smithsoft.co.za>** (`git config user.name "Daniël Smith"` and
  `git config user.email dssmith@smithsoft.co.za` in the checkout). No `Co-Authored-By` trailer in commits.
- Write files with **LF** line endings.
- The PR description says what changed in plain English, what was tested (the real commands and results), the
  compatibility risk, and anything outside the task that you noticed and left alone.

## What never goes in this repository (it is public)

Hosting or cloud details, how SmithSoft's keys are stored or used, vetting rules, vendors, prices and costs, customer
data, and any real private key or token. The test keys in `spec/fixtures` are made up and published on purpose. If a
task seems to need something private, stop and say so in the PR.

## Format changes need the owner's approval first

Anything that changes what is written in a file (a new member, a new flag, a changed meaning) is a format change.
Write the design note (`docs/design/`) and the spec text and open a **design PR**; build it only after the owner has
approved the design in the issue. Old readers must still open the file, and the change needs test files in
`spec/fixtures` that both libraries read.

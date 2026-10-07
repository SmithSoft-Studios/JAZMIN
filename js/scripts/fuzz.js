// Fuzzes the readers (TASKS S-5) until stopped or for --minutes: damaged files and decoder inputs must fail with a
// JazminError - never another error, a hang (no progress for 15 s) or a runaway allocation (the fuzzing process
// has a 768 MB heap; running out of memory ends that process, and the seed it was on is reported).
// The corpus (files get a random id each time they are written) is saved to --out as corpus-<n>.jzm, and failing
// inputs as seed-<n>.bin / seed-<n>.txt; `--replay <seed>` reruns one seed against the saved corpus.
//
//   node scripts/fuzz.js --minutes 60 [--seed 1] [--out fuzz-findings]
//   node scripts/fuzz.js --replay 1234 [--out fuzz-findings]
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeSection } from '../src/section.js';
import { corpus, exercise, exerciseDecoders, mutate, random, sections } from '../test/fuzz-helpers.js';

const self = fileURLToPath(import.meta.url);
const HANG_MS = 15_000;

/** The input for one seed: a damaged file, or (one in four) a damaged raw section payload for the decoders. */
function input({ files, payloads }, seed) {
  const rnd = random(seed);
  if (rnd() < 0.25) {
    let raw = Buffer.from(rnd.pick(payloads));
    for (let k = 1 + rnd.int(3); k > 0 && raw.length; k--) {
      const at = rnd.int(raw.length);
      raw[at] = rnd() < 0.5 ? rnd.int(256) : raw[at] ^ (1 << rnd.int(8));
    }
    if (rnd() < 0.1) raw = raw.subarray(0, rnd.int(raw.length + 1));
    return { kind: 'decoders', bytes: raw, rnd };
  }
  let bytes = rnd.pick(files);
  for (let k = 1 + (rnd() < 0.2 ? rnd.int(3) : 0); k > 0; k--) bytes = mutate(bytes, rnd);
  return { kind: 'file', bytes, rnd };
}

/** The corpus and the decoded section payloads of its files. */
function prepare(files) {
  const payloads = [];
  for (const file of files) {
    for (const s of sections(file)) {
      try {
        payloads.push(decodeSection(file.subarray(s.at, s.at + 16 + s.length), { sectionId: 'x' }));
      } catch {
        // compressed payloads that need their real section id: skipped
      }
    }
  }
  return { files, payloads };
}

function run(prepared, seed) {
  const { kind, bytes, rnd } = input(prepared, seed);
  return { kind, bytes, error: kind === 'file' ? exercise(bytes) : exerciseDecoders(bytes, rnd) };
}

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '10' }, seed: { type: 'string', default: '1' }, out: { type: 'string', default: 'fuzz-findings' },
    replay: { type: 'string' }, child: { type: 'boolean', default: false },
  },
});
const corpusFile = (i) => path.join(values.out, `corpus-${i}.jzm`);
const progressFile = path.join(values.out, 'progress');
const loadCorpus = () => {
  const files = [];
  for (let i = 0; fs.existsSync(corpusFile(i)); i++) files.push(fs.readFileSync(corpusFile(i)));
  if (!files.length) throw new Error(`No corpus in ${values.out}: it is saved there by a fuzzing run`);
  return prepare(files);
};
const save = (seed, kind, bytes, message) => {
  fs.writeFileSync(path.join(values.out, `seed-${seed}.bin`), bytes);
  fs.writeFileSync(path.join(values.out, `seed-${seed}.txt`), `${kind}\n${message}\n`);
  console.log(`FINDING seed ${seed} (${kind}): ${message.split('\n')[0]}`);
};

if (values.child) {
  // Fuzzing process: writes the seed it is on to the progress file before each input, so the parent can name the
  // input of a hang or of a crash that ends this process.
  const prepared = loadCorpus();
  const fd = fs.openSync(progressFile, 'w');
  const seedBytes = Buffer.alloc(8);
  for (let seed = Number(values.seed); ; seed++) {
    seedBytes.writeDoubleLE(seed);
    fs.writeSync(fd, seedBytes, 0, 8, 0);
    const { kind, bytes, error } = run(prepared, seed);
    if (error) save(seed, kind, bytes, String(error?.stack ?? error));
    // Lets Node run the work left for later: zlib frees a decompressor that failed on damaged data on the next tick,
    // and a loop that never yielded kept every one, until the 768 MB heap ran out (after about 25 minutes).
    if (seed % 1000 === 0) await new Promise(setImmediate);
  }
} else if (values.replay !== undefined) {
  const { kind, bytes, error } = run(loadCorpus(), Number(values.replay));
  console.log(`seed ${values.replay} (${kind}, ${bytes.length} bytes):`, error ?? 'no unexpected error');
  process.exit(error ? 1 : 0);
} else {
  fs.mkdirSync(values.out, { recursive: true });
  const prepared = prepare(corpus());
  prepared.files.forEach((f, i) => fs.writeFileSync(corpusFile(i), f));
  const first = Number(values.seed);
  const deadline = Date.now() + Number(values.minutes) * 60_000;
  const current = () => {
    try {
      return fs.readFileSync(progressFile).readDoubleLE(0);
    } catch {
      return -1;
    }
  };
  let reached = first;
  const start = (from) => {
    fs.rmSync(progressFile, { force: true });
    const child = fork(self, ['--child', '--seed', String(from), '--out', values.out], { execArgv: ['--max-old-space-size=768'] });
    let last = { seed: -1, at: Date.now() };
    let stopping = false;
    const watchdog = setInterval(() => {
      const seed = current();
      if (seed !== last.seed) last = { seed, at: Date.now() };
      reached = Math.max(reached, seed);
      if (Date.now() >= deadline) {
        stop();
      } else if (seed >= 0 && Date.now() - last.at > HANG_MS) {
        const { kind, bytes } = input(prepared, seed);
        save(seed, kind, bytes, `hang: no progress for ${HANG_MS / 1000} s`);
        child.once('exit', () => start(seed + 1));
        stop();
      }
    }, 1000);
    // The watchdog stops first, so a fuzzing process slow to end is reported and restarted once (it used to be every
    // second until it ended, each time starting another). SIGKILL: a process stuck in a loop, or ending after it ran out
    // of memory, may not end on SIGTERM.
    const stop = () => {
      clearInterval(watchdog);
      stopping = true;
      child.kill('SIGKILL');
    };
    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      if (stopping) {
        if (Date.now() >= deadline) finish();
        return;
      }
      // The fuzzing process ended by itself: out of memory or another fatal error on its current input.
      const seed = current();
      const { kind, bytes } = input(prepared, seed);
      save(seed, kind, bytes, `fuzzing process ended (code ${code}, signal ${signal}): out of memory or a fatal error`);
      if (Date.now() < deadline) start(seed + 1);
      else finish();
    });
  };
  const finish = () => {
    const findings = fs.readdirSync(values.out).filter((f) => f.endsWith('.txt')).length;
    console.log(`${(reached - first).toLocaleString()} inputs from seed ${first}, ${findings} finding(s) in ${values.out}`);
    process.exit(findings ? 1 : 0);
  };
  start(first);
}

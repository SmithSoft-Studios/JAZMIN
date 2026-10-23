import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { open, openAsync, write } from '../src/index.js';

// On Windows, update() and compact() replace a file that readers have open in two steps (update.js replaceOpenFile):
// for an instant its path is missing. A reader opening it then waits briefly for the new version (issue #275).

const windowsOnly = { skip: process.platform !== 'win32' && 'the path is briefly missing only on Windows' };
const AWAY = 1;
const OPENING = 2;

/**
 * Moves the file away in a worker; `opening()` (called just before opening it) lets the worker put it back after
 * about 15 ms. Returns { opening, done } (done: a promise of the worker's exit).
 */
function moveAwayAndBack(file) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const fs = require('node:fs');
    const { workerData: { file, flag } } = require('node:worker_threads');
    fs.renameSync(file, file + '.away');
    Atomics.store(flag, 0, ${AWAY});
    Atomics.notify(flag, 0);
    while (Atomics.load(flag, 0) !== ${OPENING}) Atomics.wait(flag, 0, ${AWAY}, 1000);
    Atomics.wait(flag, 0, ${OPENING}, 15);
    fs.renameSync(file + '.away', file);
  `, { eval: true, workerData: { file, flag } });
  const done = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  while (Atomics.load(flag, 0) !== AWAY) Atomics.wait(flag, 0, 0, 1000);
  assert.equal(fs.existsSync(file), false);
  return {
    opening() {
      Atomics.store(flag, 0, OPENING);
      Atomics.notify(flag, 0);
    },
    done,
  };
}

function sample() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-retry-')), 'r.jzm');
  write(file, [{ id: 1 }, { id: 2 }]);
  return file;
}

test('open waits briefly for a file whose path is missing while it is replaced', windowsOnly, async () => {
  const file = sample();
  const away = moveAwayAndBack(file);
  away.opening();
  let r;
  try {
    r = open(file); // the synchronous open sleeps between its tries, so the worker puts the file back meanwhile
  } finally {
    await away.done;
  }
  try {
    assert.equal(r.rowCount, 2);
  } finally {
    r.close();
  }
});

test('openAsync waits briefly for a file whose path is missing while it is replaced', windowsOnly, async () => {
  const file = sample();
  const away = moveAwayAndBack(file);
  away.opening();
  let r;
  try {
    r = await openAsync(file);
  } finally {
    await away.done;
  }
  try {
    assert.equal(r.rowCount, 2);
  } finally {
    r.close();
  }
});

test('a file that stays missing still fails to open, with the system error', windowsOnly, async () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-retry-')), 'none.jzm');
  assert.throws(() => open(missing), { code: 'ENOENT' });
  await assert.rejects(openAsync(missing), { code: 'ENOENT' });
});

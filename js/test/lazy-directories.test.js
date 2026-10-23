import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminFormatError, JazminKey, append, open, write } from '../src/index.js';
import { APPEND_STATE, KEY_ROTATION, SOURCE } from '../src/reader.js';

// A file's chunk directories (one per partition and append) are read when a query first needs them, not when it is
// opened: opening a file after many appends costs the same as after none (issue #275).

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-lazy-')), name);
const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string' },
];
const row = (id) => ({ id, name: `Name ${id}` });

/** A keyed file with three appends: four chunk directories. Returns { file, key, directories: [{ offset, length }] }. */
function appendedFile() {
  const file = tmp('t.jzm');
  const key = JazminKey.generate();
  write(file, Array.from({ length: 100 }, (_, i) => row(i)), { columns, key, chunkRows: 25 });
  for (let a = 0; a < 3; a++) append(file, { key, insert: [row(100 + a)] });
  const r = open(file, { key });
  try {
    const directories = r[KEY_ROTATION].sections.filter((s) => s.sectionId.startsWith('0/dir/'));
    return { file, key, directories };
  } finally {
    r.close();
  }
}

/** A byte source over a buffer that records the ranges read. */
function recordingSource(bytes) {
  const reads = [];
  return {
    reads,
    source: {
      [SOURCE]: true,
      size: bytes.length,
      read(position, length) {
        reads.push({ position, length });
        if (position < 0 || position + length > bytes.length) throw new JazminFormatError('Unexpected end of file');
        return bytes.subarray(position, position + length);
      },
      close() {},
    },
  };
}

const overlaps = (read, section) => read.position < section.offset + section.length && section.offset < read.position + read.length;
const readsOf = (reads, sections) => sections.filter((s) => reads.some((read) => overlaps(read, s))).map((s) => s.sectionId);

test('opening a file reads none of its chunk directories; the first query reads them', () => {
  const { file, key, directories } = appendedFile();
  assert.equal(directories.length, 4, 'the original rows and each append have a chunk directory');
  const { reads, source } = recordingSource(fs.readFileSync(file));
  const r = open(source, { key });
  try {
    assert.deepEqual(readsOf(reads, directories), [], 'open read a chunk directory');
    assert.equal(r.rowCount, 103);
    assert.equal(r.appendCount, 3);
    assert.equal(r.chunkCount, 7);
    assert.deepEqual(readsOf(reads, directories), [], 'rowCount, appendCount and chunkCount read a chunk directory');
    assert.deepEqual([...r.find({ id: { gte: 99 } })].map((x) => x.id), [99, 100, 101, 102]);
    assert.equal(readsOf(reads, directories).length, 4);
  } finally {
    r.close();
  }
});

test('a damaged chunk directory: the file opens, and the first query fails with a format error', () => {
  const { file, key, directories } = appendedFile();
  const bytes = fs.readFileSync(file);
  const last = directories.at(-1);
  bytes[last.offset + last.length - 1] ^= 0xff; // fails its CRC-32 check
  const r = open(bytes, { key });
  try {
    assert.equal(r.rowCount, 103);
    assert.throws(() => [...r.rows()], JazminFormatError);
    assert.throws(() => r.get(0), JazminFormatError);
  } finally {
    r.close();
  }
});

test('an unencrypted file with a damaged chunk directory opens; the first query fails', () => {
  const file = tmp('plain.jzm');
  write(file, Array.from({ length: 100 }, (_, i) => row(i)), { columns, chunkRows: 25 });
  const bytes = fs.readFileSync(file);
  const r0 = open(bytes);
  const [directory] = r0[APPEND_STATE].table.partitions[0].segments; // the one partition's chunk directory
  r0.close();
  bytes[directory.offset + directory.length - 1] ^= 0xff; // fails its CRC-32 check
  const r = open(bytes);
  try {
    assert.equal(r.rowCount, 100);
    assert.throws(() => r.count({ id: { gte: 50 } }), JazminFormatError);
  } finally {
    r.close();
  }
});

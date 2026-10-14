// Rows put into a new sort order within a memory budget, for a rewrite that changes a table's sortedBy (update(),
// compact()). Up to `runRows` rows are sorted in memory; beyond that each run of sorted rows is written to a temporary
// JAZMIN file locked with a key made for it and never kept, so no row reaches the disk readable, and the runs are then
// merged as they are read back. Equal keys keep the order the rows came in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JazminValidationError } from './errors.js';
import { JazminKey } from './keys.js';
import { JazminReader } from './reader.js';
import { compareKeys, normalizeValue, toKey } from './types.js';
import { JazminWriter } from './writer.js';

/** Rows per chunk of a temporary run: the merge decodes one chunk of each run at a time. */
const RUN_CHUNK_ROWS = 512;

/** Rows sorted in memory at a time, by the reader's priority. */
export const SORT_RUN_ROWS = { memory: 10_000, balanced: 25_000, speed: 100_000 }; // larger runs gave no more speed, only memory

function compareTuples(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return Number.isNaN(c) ? 0 : c;
  }
  return 0;
}

export class RowSorter {
  #columns;
  #sortKey;
  #runRows;
  #writeOptions;
  #buffer = [];
  #runs = [];
  #dir = null;
  #readers = [];

  /**
   * columns: the table's column definitions; sortedBy: the column names to sort by; runRows: rows sorted in memory at
   * a time; writeOptions: codec, level, maxDegreeOfParallelism and priority for the temporary runs.
   */
  constructor(columns, sortedBy, { runRows = SORT_RUN_ROWS.balanced, writeOptions = {} } = {}) {
    if (!Number.isInteger(runRows) || runRows < 1) throw new JazminValidationError('The sort needs at least 1 row in memory');
    const byName = new Map(columns.map((c) => [c.name, c]));
    const sortColumns = sortedBy.map((name) => {
      const c = byName.get(name);
      if (!c) throw new JazminValidationError(`sortedBy: unknown column '${name}'`);
      return c;
    });
    this.#sortKey = (row) => sortColumns.map((c) => {
      const v = normalizeValue(c.type, row[c.name], c.name);
      return v === null ? null : toKey(c.type, v);
    });
    this.#columns = columns.map(({ index, ...c }) => c); // the runs need no indexes
    this.#runRows = runRows;
    this.#writeOptions = writeOptions;
  }

  /** Adds a row. */
  add(row) {
    this.#buffer.push({ key: this.#sortKey(row), row });
    if (this.#buffer.length >= this.#runRows) this.#spill();
  }

  /** The buffered rows, sorted; equal keys in the order they came. */
  #sorted() {
    const buffer = this.#buffer;
    this.#buffer = [];
    buffer.forEach((entry, i) => { entry.seq = i; });
    return buffer.sort((a, b) => compareTuples(a.key, b.key) || a.seq - b.seq);
  }

  /** Writes the buffered rows, sorted, as a run in a temporary file locked with a key of its own. */
  #spill() {
    if (!this.#buffer.length) return;
    this.#dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-sort-'));
    const file = path.join(this.#dir, `run-${this.#runs.length}.jzm`);
    const key = JazminKey.generate();
    // Small chunks, light compression and one thread: the merge holds one decoded chunk per run, and runs are read once.
    const writer = new JazminWriter(file, { ...this.#writeOptions, columns: this.#columns, key, chunkRows: RUN_CHUNK_ROWS, level: 1, maxDegreeOfParallelism: 1 });
    try {
      for (const { row } of this.#sorted()) writer.writeRow(row);
      writer.finish();
    } catch (error) {
      writer.abort();
      throw error;
    }
    this.#runs.push({ file, key });
  }

  /** Every row added, in the new order. Call once, then close(). */
  *rows() {
    if (!this.#runs.length) {
      for (const { row } of this.#sorted()) yield row;
      return;
    }
    this.#spill();
    // A k-way merge of the runs: a heap of each run's next row, by key and then by run (runs keep the rows' order).
    const heads = [];
    for (const [i, run] of this.#runs.entries()) {
      const reader = new JazminReader(run.file, { key: run.key });
      this.#readers.push(reader);
      const rows = reader.rows();
      const first = rows.next();
      if (!first.done) heads.push({ run: i, rows, row: first.value, key: this.#sortKey(first.value) });
    }
    const less = (a, b) => (compareTuples(a.key, b.key) || a.run - b.run) < 0;
    const down = (i) => {
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heads.length && less(heads[l], heads[m])) m = l;
        if (r < heads.length && less(heads[r], heads[m])) m = r;
        if (m === i) return;
        [heads[i], heads[m]] = [heads[m], heads[i]];
        i = m;
      }
    };
    for (let i = (heads.length >> 1) - 1; i >= 0; i--) down(i);
    while (heads.length) {
      const top = heads[0];
      yield top.row;
      const next = top.rows.next();
      if (next.done) {
        const last = heads.pop();
        if (heads.length) heads[0] = last;
      } else {
        top.row = next.value;
        top.key = this.#sortKey(next.value);
      }
      if (heads.length) down(0);
    }
  }

  /** How many runs went to temporary files (0: sorted in memory). */
  get runs() {
    return this.#runs.length;
  }

  /** Closes the runs and deletes their files. */
  close() {
    for (const reader of this.#readers) reader.close();
    this.#readers = [];
    this.#buffer = [];
    if (this.#dir) fs.rmSync(this.#dir, { recursive: true, force: true });
    this.#dir = null;
  }
}

import { JazminValidationError } from './errors.js';
import { appendCalls } from './append.js';
import { withLock, withLockAsync } from './lock.js';

// Several calls written as one append (GitHub #275). Each append costs two flushes to disk (spec 11.2), whatever its
// size, so one append for many calls costs about what one call does. The calls are written in call order, and each
// call's delete and upsert see the file as the earlier calls leave it: the file ends up as running the calls one after
// another would. A call that would see a row an earlier call adds is a clash (append.js, orderedRows): a transaction
// refuses it, and the group writer starts a new append there.

const ROWS = ['insert', 'upsert', 'delete'];

function rowList(rows, name) {
  if (!Array.isArray(rows)) throw new JazminValidationError(`${name} needs an array of rows, e.g. ${name}([{ id: 1 }])`);
  return [...rows];
}

function filterOf(filter) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw new JazminValidationError('delete needs a filter, e.g. delete({ id: 1 })');
  return filter;
}

function needsKeyColumns(options) {
  const { keyColumns } = options;
  if (!Array.isArray(keyColumns) || keyColumns.length === 0) throw new JazminValidationError('upsert needs keyColumns, e.g. { keyColumns: ["id"] }');
}

/** Calls collected in memory and written by commit() as one append: all of them or none. No lock is held until then. */
class AppendTransaction {
  #path;
  #options;
  #calls = [];
  #state = 'open';

  constructor(path, options) {
    for (const name of ROWS) {
      if (options[name] !== undefined) throw new JazminValidationError(`beginAppend: give rows to change with ${name}(), not as the '${name}' option`);
    }
    this.#path = path;
    this.#options = options;
  }

  insert(rows) {
    this.#open();
    this.#calls.push({ insert: rowList(rows, 'insert') });
  }

  upsert(rows) {
    this.#open();
    needsKeyColumns(this.#options);
    this.#calls.push({ upsert: rowList(rows, 'upsert') });
  }

  delete(filter) {
    this.#open();
    this.#calls.push({ delete: filterOf(filter) });
  }

  /** Writes the calls as one append and returns its result. If it fails the file is left as it was, and so is the transaction: ended. */
  commit() {
    this.#open();
    this.#state = 'failed';
    const calls = this.#calls;
    this.#calls = [];
    const { result } = withLock(this.#path, () => appendCalls(this.#path, this.#options, calls));
    this.#state = 'committed';
    return result;
  }

  /** Discards the calls: nothing was written. */
  rollback() {
    this.#open();
    this.#state = 'rolled back';
    this.#calls = [];
  }

  #open() {
    if (this.#state === 'open') return;
    throw new JazminValidationError(this.#state === 'failed'
      ? 'This transaction failed to commit and has ended: begin a new one'
      : `This transaction is already ${this.#state}: begin a new one`);
  }
}

/**
 * Starts a transaction on the file at `path`: insert(rows), upsert(rows) and delete(filter) collect calls, commit()
 * writes them as one append (returning its result, as append() does), rollback() discards them. `options` are
 * append()'s, without insert, upsert and delete.
 */
export function beginAppend(path, options = {}) {
  return new AppendTransaction(path, options);
}

// Options that a batch would write again each time: changes to the file as a whole belong in append() or beginAppend().
const PER_FILE = [...ROWS, 'metadata', 'grant', 'revoke', 'addFiles', 'removeFiles', 'package', 'addShapes', 'removeShapes', 'locks', 'columns'];

/**
 * Many callers' changes merged into few appends (group commit). Each call returns a promise of the result of the
 * append that wrote it, which the other calls in that batch share. A batch starts on the next turn of the event loop
 * (or after maxDelay ms) and takes calls up to maxRows rows; calls made while a batch is written make the next one. The
 * flushes to disk are awaited, not blocking. A failed batch is tried again in halves, so each call gets its own error.
 */
class AppendWriter {
  #path;
  #options;
  #maxDelay;
  #maxRows;
  #queue = [];
  #queuedRows = 0;
  #timer = null;
  #timerNow = false; // the timer is the next turn of the event loop, not maxDelay
  #running = false;
  #last = Promise.resolve();
  #closed = false;

  constructor(path, { maxDelay = 0, maxRows = 10_000, ...options }) {
    for (const name of PER_FILE) {
      if (options[name] !== undefined) {
        throw new JazminValidationError(ROWS.includes(name)
          ? `openWriter: give rows to change with ${name}(), not as the '${name}' option`
          : `openWriter: '${name}' changes the file as a whole, and every batch would write it again; use append() or beginAppend() for it`);
      }
    }
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new JazminValidationError('openWriter: maxRows must be a whole number, 1 or more');
    if (typeof maxDelay !== 'number' || !Number.isFinite(maxDelay) || maxDelay < 0) throw new JazminValidationError('openWriter: maxDelay must be 0 or more milliseconds');
    this.#path = path;
    this.#options = options;
    this.#maxDelay = maxDelay;
    this.#maxRows = maxRows;
  }

  insert(rows) {
    return this.#call(() => ({ insert: rowList(rows, 'insert') }));
  }

  upsert(rows) {
    return this.#call(() => {
      needsKeyColumns(this.#options);
      return { upsert: rowList(rows, 'upsert') };
    });
  }

  delete(filter) {
    return this.#call(() => ({ delete: filterOf(filter) }));
  }

  /** Writes what is waiting now, without waiting for maxDelay, and resolves once it is written (or has failed). */
  async flush() {
    if (this.#queue.length) this.#start();
    await this.#last.then(() => {}, () => {});
  }

  /** Writes what is waiting, then refuses further calls. */
  async close() {
    this.#closed = true;
    await this.flush();
  }

  #call(make) {
    let call;
    try {
      if (this.#closed) throw new JazminValidationError('This writer is closed');
      call = make();
    } catch (error) {
      return Promise.reject(error);
    }
    const rows = (call.insert?.length ?? 0) + (call.upsert?.length ?? 0);
    const promise = new Promise((resolve, reject) => this.#queue.push({ call, rows, resolve, reject }));
    this.#last = promise;
    this.#queuedRows += rows;
    if (this.#running) return promise; // taken by the next batch
    const now = this.#maxDelay === 0 || this.#queuedRows >= this.#maxRows;
    if (this.#timer && (this.#timerNow || !now)) return promise;
    this.#cancelTimer();
    this.#timerNow = now;
    this.#timer = now ? setImmediate(() => this.#start()) : setTimeout(() => this.#start(), this.#maxDelay);
    return promise;
  }

  #cancelTimer() {
    if (!this.#timer) return;
    if (this.#timerNow) clearImmediate(this.#timer);
    else clearTimeout(this.#timer);
    this.#timer = null;
  }

  #start() {
    this.#cancelTimer();
    if (this.#running) return;
    this.#running = true;
    this.#drain();
  }

  async #drain() {
    try {
      while (this.#queue.length) {
        const batch = [];
        let rows = 0;
        while (this.#queue.length && (batch.length === 0 || rows + this.#queue[0].rows <= this.#maxRows)) {
          const item = this.#queue.shift();
          rows += item.rows;
          batch.push(item);
        }
        this.#queuedRows -= rows;
        await this.#write(batch);
      }
    } finally {
      this.#running = false; // in the same turn as the last check: a call made after it starts a batch itself
    }
  }

  async #write(items) {
    let outcome;
    try {
      outcome = await withLockAsync(this.#path, () => appendCalls(this.#path, this.#options, items.map((i) => i.call), { atClash: 'split', durable: 'async' }));
    } catch (error) {
      // Bad rows or a bad filter fail only their own call: the batch is tried again in halves, in order.
      if (items.length > 1 && error instanceof JazminValidationError) {
        const half = Math.ceil(items.length / 2);
        await this.#write(items.slice(0, half));
        await this.#write(items.slice(half));
      } else {
        for (const item of items) item.reject(error);
      }
      return;
    }
    for (const item of items.slice(0, outcome.taken)) item.resolve(outcome.result);
    if (outcome.taken < items.length) await this.#write(items.slice(outcome.taken)); // a clash: the rest in a new append
  }
}

/**
 * Opens a group writer on the file at `path`: insert(rows), upsert(rows) and delete(filter) each return a promise of
 * the result of the append that wrote them; flush() and close() wait for what is waiting. Options: maxDelay (ms to
 * wait for more calls, default 0: the next turn of the event loop), maxRows (rows per append, default 10,000), and
 * append()'s options that apply to every batch (key, password, keyColumns, table, codec, level, chunkRows, ...).
 */
export function openWriter(path, options = {}) {
  return new AppendWriter(path, options);
}

// Indexes (spec 8): sorted indexes in pages behind a directory, trigram indexes, postings.
import { ByteReader, ByteWriter, msFromFile, normalizeBigInt, utf8Slice } from './binary.js';
import { INDEX_DELTAS_ENCODING, POSTINGS_ENCODING } from './constants.js';
import { JazminFormatError } from './errors.js';
import { unionAll } from './rowset.js';
import { decodeBound, encodeBound } from './stats.js';
import { compareKeys, decodeValue, encodeValue, keyId, toKey } from './types.js';

export function writePostings(writer, rowIds) {
  writer.varUint(rowIds.length);
  let previous = 0;
  for (const id of rowIds) {
    writer.varUint(id - previous);
    previous = id;
  }
}

export function readPostings(reader) {
  const count = reader.varUint();
  // Each id takes at least one byte: a larger count is damage, caught before allocating for it.
  if (typeof count !== 'number' || count > reader.remaining) throw new JazminFormatError('Postings are truncated');
  const ids = new Array(count);
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const delta = reader.varUint();
    if (typeof delta !== 'number' || previous + delta > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
    previous += delta;
    ids[i] = previous;
  }
  return ids;
}

/** Postings of an entry in a page with encoding 1: the first row id is a zigzag difference from `previousFirst`. */
function readRowIds(reader, previousFirst) {
  const count = reader.varUint();
  // Each id takes at least one byte: a larger count is damage, caught before allocating for it.
  if (typeof count !== 'number' || count < 1 || count > reader.remaining) throw new JazminFormatError('Postings are truncated');
  const step = reader.varInt();
  let previous = previousFirst + step;
  if (typeof step !== 'number' || !(previous >= 0) || previous > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
  const ids = new Array(count);
  ids[0] = previous;
  for (let i = 1; i < count; i++) {
    const delta = reader.varUint();
    if (typeof delta !== 'number' || previous + delta > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
    previous += delta;
    ids[i] = previous;
  }
  return ids;
}

/** The encoding byte that starts index, page, postings and deleted-rows sections (spec 8). */
function checkEncoding(reader, what) {
  const encoding = reader.byte();
  if (encoding !== POSTINGS_ENCODING) throw new JazminFormatError(`${what} uses encoding ${encoding}, which this reader does not support`);
}

/** A postings section (null cells, deleted rows): encoding byte, then postings. */
export function encodePostingsSection(rowIds) {
  const w = new ByteWriter(rowIds.length * 2 + 8);
  w.byte(POSTINGS_ENCODING);
  writePostings(w, rowIds);
  return w.toBuffer();
}

export function decodePostingsSection(buf, what = 'Postings section') {
  const reader = new ByteReader(buf);
  checkEncoding(reader, what);
  const ids = readPostings(reader);
  if (!reader.eof) throw new JazminFormatError(`${what} has trailing bytes`);
  return ids;
}

/** Target raw size of a sorted index page (informative, spec 8.1). */
export const INDEX_PAGE_BYTES = 64 * 1024;

/**
 * Ascending runs kept before the builder falls back to a lookup table. Keys that arrive almost in order (rows appended
 * after the rest, partitions regrouped by compaction) form a few runs, merged cheaply when the pages are written; keys
 * in no particular order would form many, and use the table.
 */
const MAX_RUNS = 32;

/** Builds a sorted value index: distinct key forms in ascending order, each with its row ids. */
export class SortedIndexBuilder {
  constructor(type) {
    this.type = type;
    // Distinct keys of the current run in ascending order (in table mode: all of them, as first seen), each with its
    // first row id; later row ids only for keys seen again (by position), so a column of unique values (ids) needs
    // nothing beyond its keys and first row ids.
    this.keys = [];
    this.firstRows = [];
    this.moreRows = new Map();
    this.runs = []; // earlier ascending runs: { keys, firstRows, moreRows }, oldest first
    this.positions = null; // key id -> position in table mode, used once the keys form more than MAX_RUNS runs
    this.nulls = [];
  }

  add(rowId, value) {
    if (value === null) {
      this.nulls.push(rowId);
      return;
    }
    const key = toKey(this.type, value);
    if (Number.isNaN(key)) return; // NaN is never indexed (it is not equal to anything)
    if (this.positions !== null) {
      const at = this.positions.get(keyId(key));
      if (at !== undefined) {
        this.#more(this.moreRows, at).push(rowId);
        return;
      }
      this.positions.set(keyId(key), this.keys.length);
    } else if (this.keys.length > 0) {
      // Keys arriving in ascending order (ids, a sorted column) can only repeat the last one: no lookup needed.
      const n = this.keys.length;
      const last = this.keys[n - 1];
      const order = compareKeys(last, key);
      if (order === 0 && keyId(last) === keyId(key)) {
        this.#more(this.moreRows, n - 1).push(rowId);
        return;
      }
      if (!(order < 0)) {
        // Out of order: this key starts a new run, or, with too many runs, every key moves to the lookup table.
        this.runs.push({ keys: this.keys, firstRows: this.firstRows, moreRows: this.moreRows });
        this.keys = [];
        this.firstRows = [];
        this.moreRows = new Map();
        if (this.runs.length >= MAX_RUNS) {
          this.#toTable();
          this.add(rowId, value);
          return;
        }
      }
    }
    this.keys.push(key);
    this.firstRows.push(rowId);
  }

  /** The later row ids of the key at a position, made when it is first seen again. */
  #more(moreRows, at) {
    let more = moreRows.get(at);
    if (more === undefined) moreRows.set(at, (more = []));
    return more;
  }

  /** Table mode: the runs' keys in one list, as first seen, with a lookup table; sorted when the pages are written. */
  #toTable() {
    const runs = this.runs;
    this.runs = [];
    this.positions = new Map();
    for (const run of runs) {
      for (let i = 0; i < run.keys.length; i++) {
        const at = this.positions.get(keyId(run.keys[i]));
        const runMore = run.moreRows.get(i);
        if (at === undefined) {
          if (runMore) this.moreRows.set(this.keys.length, runMore);
          this.positions.set(keyId(run.keys[i]), this.keys.length);
          this.keys.push(run.keys[i]);
          this.firstRows.push(run.firstRows[i]);
        } else {
          const more = this.#more(this.moreRows, at);
          more.push(run.firstRows[i]);
          if (runMore) for (const id of runMore) more.push(id);
        }
      }
    }
  }

  /**
   * The distinct keys in ascending order, as { key, first, more } (first row id, later row ids): one object, updated
   * for each key, so read it before taking the next. Keys that compare equal keep the order they were first seen in;
   * a key in several runs is one entry, its row ids in the order they were added.
   */
  *#entries() {
    const entry = { key: undefined, first: 0, more: undefined };
    const at = (keys, firstRows, moreRows, i) => {
      entry.key = keys[i];
      entry.first = firstRows[i];
      entry.more = moreRows.get(i);
      return entry;
    };
    if (this.runs.length === 0 && this.positions === null) {
      for (let i = 0; i < this.keys.length; i++) yield at(this.keys, this.firstRows, this.moreRows, i); // in order already
      return;
    }
    if (this.positions !== null) {
      const order = Array.from(this.keys, (_, i) => i).sort((a, b) => compareKeys(this.keys[a], this.keys[b]));
      for (const i of order) yield at(this.keys, this.firstRows, this.moreRows, i);
      return;
    }
    const runs = [...this.runs, { keys: this.keys, firstRows: this.firstRows, moreRows: this.moreRows }];
    const next = new Array(runs.length).fill(0);
    for (;;) {
      let best = -1; // the run with the smallest key; on a tie, the oldest (first seen)
      for (let r = 0; r < runs.length; r++) {
        if (next[r] < runs[r].keys.length && (best < 0 || compareKeys(runs[r].keys[next[r]], runs[best].keys[next[best]]) < 0)) best = r;
      }
      if (best < 0) return;
      at(runs[best].keys, runs[best].firstRows, runs[best].moreRows, next[best]++);
      const { key } = entry;
      for (let r = best + 1; r < runs.length; r++) {
        const other = runs[r].keys[next[r]];
        if (next[r] < runs[r].keys.length && compareKeys(other, key) === 0 && keyId(other) === keyId(key)) {
          entry.more = [...(entry.more ?? []), runs[r].firstRows[next[r]], ...(runs[r].moreRows.get(next[r]) ?? [])];
          next[r]++;
        }
      }
      yield entry;
    }
  }

  /**
   * The index as pages of about `pageBytes` raw bytes each, generated one at a time (spec 8.1):
   * { first (key bytes), count, raw } with raw = encoding byte + varint count + entries. `deltas`: encoding 1, keys
   * and first row ids as differences from the previous entry's (reader feature 'index-deltas').
   * A small index is one page. Row ids of null cells are in `nulls`.
   */
  *pages(pageBytes = INDEX_PAGE_BYTES, deltas = false) {
    const body = new ByteWriter(Math.min(pageBytes * 2, 1 << 20));
    const keys = deltas ? new PageKeys(this.type) : null;
    let first;
    let count = 0;
    let previousFirst = 0;
    // Encoding 1 pages are cut where encoding 0 pages would be, so they hold as many entries: a lookup decodes a whole
    // page, and fuller pages made lookups up to 30% slower. They are smaller to read and decompress instead.
    let plainBytes = 0;
    const page = () => {
      const raw = new ByteWriter(body.length + 11);
      raw.byte(deltas ? INDEX_DELTAS_ENCODING : POSTINGS_ENCODING);
      raw.varUint(count);
      raw.bytes(body.buf.subarray(0, body.length));
      const result = { first: encodeBound(this.type, first), count, raw: raw.toBuffer() };
      body.length = 0;
      count = 0;
      keys?.reset(); // each page starts afresh, so it decodes on its own
      previousFirst = 0;
      plainBytes = 0;
      return result;
    };
    for (const entry of this.#entries()) {
      if (count === 0) first = entry.key;
      if (keys) {
        const plainKey = keys.write(body, entry.key);
        const postingsStart = body.length;
        writeRowIds(body, entry.first, entry.more, previousFirst);
        plainBytes += plainKey + body.length - postingsStart - varIntSize(entry.first - previousFirst) + varUintSize(entry.first);
        previousFirst = entry.first;
      } else {
        encodeValue(body, this.type, entry.key);
        writeRowIds(body, entry.first, entry.more);
      }
      count++;
      if ((keys ? plainBytes : body.length) >= pageBytes) yield page();
    }
    if (count > 0) yield page();
  }
}

/**
 * The keys of a page with encoding 1 (spec 8.1), written or read in order: an int or datetime key as the difference
 * from the previous key (the first as in encoding 0), a string key as the number of UTF-8 bytes it shares with the
 * previous key and the bytes after them. Keys of other types are as in encoding 0.
 */
class PageKeys {
  constructor(type) {
    this.type = type;
    this.bytes = Buffer.alloc(0); // strings: the previous key's UTF-8 bytes, in a buffer reused while reading
    this.reset();
  }

  reset() {
    this.previous = undefined;
    this.length = 0;
  }

  /** Writes the key; returns the size it takes in encoding 0. */
  write(writer, key) {
    if (this.type === 'int' || this.type === 'datetime') {
      if (this.previous === undefined) writer.varInt(key);
      else writer.varUint(difference(key, this.previous));
      this.previous = key;
      return varIntSize(key);
    }
    if (this.type === 'string') {
      const bytes = Buffer.from(key, 'utf8');
      const max = Math.min(bytes.length, this.length);
      let shared = 0;
      while (shared < max && bytes[shared] === this.bytes[shared]) shared++;
      writer.varUint(shared);
      writer.varUint(bytes.length - shared);
      writer.bytes(bytes.subarray(shared));
      this.bytes = bytes;
      this.length = bytes.length;
      return varUintSize(bytes.length) + bytes.length;
    }
    const start = writer.length;
    encodeValue(writer, this.type, key); // written as in encoding 0
    return writer.length - start;
  }

  read(reader) {
    if (this.type === 'int' || this.type === 'datetime') {
      let key;
      if (this.previous === undefined) key = reader.varInt();
      else {
        const step = reader.varUint();
        if (!(step >= 1)) throw new JazminFormatError('Index page keys are not ascending'); // a BigInt >= 1n passes too
        key = sum(this.previous, step);
      }
      if (this.type === 'datetime') msFromFile(key); // a date JavaScript can represent
      else if (typeof key === 'bigint' && (key > INT64_MAX || key < INT64_MIN)) throw new JazminFormatError('An index key is out of range');
      this.previous = key;
      return key;
    }
    if (this.type === 'string') {
      const shared = reader.varUint();
      const rest = reader.varUint();
      if (typeof shared !== 'number' || typeof rest !== 'number' || shared > this.length || rest > reader.remaining) {
        throw new JazminFormatError('Index page is truncated');
      }
      const length = shared + rest;
      if (this.bytes.length < length) {
        const grown = Buffer.allocUnsafe(Math.max(length, this.bytes.length * 2, 64));
        this.bytes.copy(grown, 0, 0, shared);
        this.bytes = grown;
      }
      // Byte by byte: the part after a shared prefix is short, and a view and a native copy per key made reading text
      // keys 2.6 times slower than in encoding 0.
      const { buf } = reader;
      const bytes = this.bytes;
      let at = reader.pos;
      for (let k = shared; k < length; k++) bytes[k] = buf[at++];
      reader.pos = at;
      this.length = length;
      return utf8Slice(bytes, 0, length); // a string of its own: the buffer is reused for the next key
    }
    return toKey(this.type, decodeValue(reader, this.type));
  }
}

/** Bytes of an unsigned varint (a safe integer or BigInt). */
function varUintSize(n) {
  let size = 1;
  if (typeof n === 'bigint') {
    for (; n >= 0x80n; n >>= 7n) size++;
    return size;
  }
  for (; n >= 0x80; n = Math.floor(n / 128)) size++;
  return size;
}

/** Bytes of a zigzag varint. */
function varIntSize(n) {
  if (typeof n === 'number' && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 2) return varUintSize(n >= 0 ? n * 2 : -n * 2 - 1);
  const big = BigInt(n);
  return varUintSize(big >= 0n ? big << 1n : ((-big) << 1n) - 1n);
}

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

/** key - previous for ascending int keys (numbers, or BigInts beyond 2^53). */
function difference(key, previous) {
  if (typeof key === 'number' && typeof previous === 'number') {
    const d = key - previous;
    if (Number.isSafeInteger(d)) return d;
  }
  return BigInt(key) - BigInt(previous);
}

/** previous + step, as a number where it is a safe integer. */
function sum(previous, step) {
  if (typeof previous === 'number' && typeof step === 'number') {
    const s = previous + step;
    if (Number.isSafeInteger(s)) return s;
  }
  return normalizeBigInt(BigInt(previous) + BigInt(step));
}

/**
 * Postings (as writePostings) of a key's first row id and its later ones. With `previousFirst` (encoding 1), the
 * first row id is written as the zigzag difference from the previous entry's.
 */
function writeRowIds(writer, first, more, previousFirst) {
  writer.varUint(1 + (more?.length ?? 0));
  if (previousFirst === undefined) writer.varUint(first);
  else writer.varInt(first - previousFirst);
  if (!more) return;
  let previous = first;
  for (const id of more) {
    writer.varUint(id - previous);
    previous = id;
  }
}

/** One decoded page of a sorted index. */
export class SortedIndex {
  constructor(keys, postings) {
    this.keys = keys;
    this.postings = postings;
  }

  /** `deltas`: the file has reader feature 'index-deltas', so pages may use encoding 1. */
  static decodePage(buf, type, deltas = false) {
    const reader = new ByteReader(buf);
    const encoding = reader.byte();
    const compact = deltas && encoding === INDEX_DELTAS_ENCODING;
    if (encoding !== POSTINGS_ENCODING && !compact) throw new JazminFormatError(`Index page uses encoding ${encoding}, which this reader does not support`);
    const count = reader.varUint();
    if (typeof count !== 'number' || count > reader.remaining) throw new JazminFormatError('Index page is truncated');
    const keys = new Array(count);
    const postings = new Array(count);
    if (compact) {
      const pageKeys = new PageKeys(type);
      let previousFirst = 0;
      for (let i = 0; i < count; i++) {
        keys[i] = pageKeys.read(reader);
        postings[i] = readRowIds(reader, previousFirst);
        previousFirst = postings[i][0];
      }
    } else {
      for (let i = 0; i < count; i++) {
        keys[i] = toKey(type, decodeValue(reader, type));
        postings[i] = readPostings(reader);
      }
    }
    if (!reader.eof) throw new JazminFormatError('Index page has trailing bytes');
    return new SortedIndex(keys, postings);
  }

  /** First position whose key is >= value (or > value when `strict`). */
  #bound(value, strict) {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = compareKeys(this.keys[mid], value);
      if (c < 0 || (strict && c === 0)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #span(from, to) {
    return unionAll(this.postings.slice(from, to));
  }

  eq(value) {
    if (Number.isNaN(value)) return [];
    const i = this.#bound(value, false);
    return i < this.keys.length && compareKeys(this.keys[i], value) === 0 ? this.postings[i] : [];
  }

  /** Rows whose key lies between `low` and `high` (either undefined: unbounded on that side). */
  between(low, lowInclusive, high, highInclusive) {
    const from = low === undefined ? 0 : this.#bound(low, !lowInclusive);
    const to = high === undefined ? this.keys.length : this.#bound(high, highInclusive);
    return to > from ? this.#span(from, to) : [];
  }

  prefix(text) {
    const start = this.#bound(text, false);
    let end = start;
    while (end < this.keys.length && this.keys[end].startsWith(text)) end++;
    return this.#span(start, end);
  }
}

const PAGES_CACHED = 8; // decoded pages kept per index: lookups stay fast, memory stays bounded

/*
 * Index lookups (built from filter conditions by indexPlan in filter.js):
 *   { op: 'eq', value } | { op: 'in', values } | { op: 'range', low, lowInclusive, high, highInclusive }
 *   | { op: 'prefix', text } | { op: 'nulls' } | { op: 'contains', text, ci }
 * Every index answers cost(lookup) - the bytes of index data the lookup still has to read, from what is already in
 * memory, without reading anything; null when the index cannot answer it - and rows(lookup), the sorted row ids.
 */
const isNaNKey = (value) => typeof value === 'number' && Number.isNaN(value);

/**
 * A sorted index (spec 8.1): only the directory is loaded up front; each lookup reads the pages it needs
 * through `load(part, ref)`, where part is `page/<n>` or `nulls`, and a few decoded pages are kept.
 */
export class PagedSortedIndex {
  #type;
  #pages;
  #nullsAt;
  #load;
  #cache = new Map(); // page number -> decoded page, least recently used first

  #deltas;

  /** `directory` is a decoded IndexDirectory (catalog.js); `deltas`: the file has reader feature 'index-deltas'. */
  constructor(directory, type, load, deltas = false) {
    this.#deltas = deltas;
    // Every page has a first key: for text, no bytes are the empty text (in statistics they mean "no bound").
    this.#pages = directory.pages.map((p) => ({ ...p, first: type === 'string' ? Buffer.from(p.first).toString('utf8') : decodeBound(type, p.first) }));
    for (const p of this.#pages) if (p.first === undefined) throw new JazminFormatError('Index page has no first key');
    this.#nullsAt = directory.nulls;
    this.#type = type;
    this.#load = load;
  }

  #page(i) {
    let page = this.#cache.get(i);
    if (page) {
      this.#cache.delete(i); // re-inserted below as the most recently used
    } else {
      const p = this.#pages[i];
      page = SortedIndex.decodePage(this.#load(`page/${i}`, p), this.#type, this.#deltas);
      if (page.keys.length !== p.count) throw new JazminFormatError('Index page does not match its directory');
      if (this.#cache.size >= PAGES_CACHED) this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(i, page);
    return page;
  }

  /** Last page whose first key is <= value, or -1 if value is below every key. */
  #pageFor(value) {
    let lo = 0;
    let hi = this.#pages.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareKeys(this.#pages[mid].first, value) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  /** The first and last page a lookup reads (last < first: none), from the directory alone. */
  #pageSpan(lookup) {
    const last = this.#pages.length - 1;
    switch (lookup.op) {
      case 'eq': {
        if (isNaNKey(lookup.value)) return [0, -1];
        const i = this.#pageFor(lookup.value);
        return [Math.max(i, 0), i];
      }
      case 'range': {
        if (isNaNKey(lookup.low) || isNaNKey(lookup.high)) return [0, -1];
        return [lookup.low === undefined ? 0 : Math.max(this.#pageFor(lookup.low), 0), lookup.high === undefined ? last : this.#pageFor(lookup.high)];
      }
      case 'prefix': {
        // Keys starting with the text are contiguous: they continue while the next page may still start with it.
        const from = Math.max(this.#pageFor(lookup.text), 0);
        let to = from;
        while (to < last && this.#pages[to + 1].first.startsWith(lookup.text)) to++;
        return [from, Math.min(to, last)];
      }
      default: return [0, -1];
    }
  }

  /** Distinct keys in the index (from its directory). */
  get keyCount() {
    return this.#pages.reduce((n, p) => n + p.count, 0);
  }

  cost(lookup) {
    if (lookup.op === 'contains') return null;
    if (lookup.op === 'nulls') return this.#nullsAt ? this.#nullsAt.length : 0;
    const pages = new Set();
    const add = ([from, to]) => {
      for (let i = from; i <= to; i++) if (!this.#cache.has(i)) pages.add(i);
    };
    if (lookup.op === 'in') for (const value of lookup.values) add(this.#pageSpan({ op: 'eq', value }));
    else add(this.#pageSpan(lookup));
    let bytes = 0;
    for (const i of pages) bytes += this.#pages[i].length;
    return bytes;
  }

  rows(lookup) {
    switch (lookup.op) {
      case 'eq': return this.#eq(lookup.value);
      case 'in': return unionAll(lookup.values.map((v) => this.#eq(v)));
      case 'nulls': return this.#nullsAt ? decodePostingsSection(this.#load('nulls', this.#nullsAt), 'Index null postings') : [];
      case 'range': case 'prefix': {
        const [from, to] = this.#pageSpan(lookup);
        const lists = [];
        for (let j = from; j <= to; j++) {
          const page = this.#page(j);
          lists.push(lookup.op === 'prefix' ? page.prefix(lookup.text) : page.between(lookup.low, lookup.lowInclusive, lookup.high, lookup.highInclusive));
        }
        return unionAll(lists);
      }
      default: return null;
    }
  }

  #eq(value) {
    if (isNaNKey(value)) return [];
    const i = this.#pageFor(value);
    return i < 0 ? [] : this.#page(i).eq(value);
  }
}

/**
 * ASCII-only lower-casing. Deliberately not locale/Unicode aware so every
 * implementation produces byte-identical trigram indexes.
 */
export function asciiLower(text) {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Splits ASCII-lower-cased text into distinct 3-character (UTF-16 code unit) grams. */
export function trigrams(text) {
  const lower = asciiLower(text);
  const grams = new Set();
  for (let i = 0; i + 3 <= lower.length; i++) grams.add(lower.substring(i, i + 3));
  return grams;
}

/** Builds a trigram index used to accelerate `contains` / `icontains` filters (spec 8.2). */
const TRIGRAM_SEEN_LIMIT = 4096; // distinct values whose grams a trigram builder remembers

/**
 * One gram's row ids while an index is built, kept as they are written (spec 8.2 postings): the differences between
 * ascending row ids as varints, in a byte buffer that doubles as it fills. Indexed text often repeats, and a gram's
 * ids then take about a byte each, where an array of numbers takes 8 and leaves its smaller copies to collect.
 */
class PostingBytes {
  constructor(rowId) {
    this.bytes = new Uint8Array(16);
    this.length = 0;
    this.count = 0;
    this.last = 0;
    this.add(rowId);
  }

  /** Adds a row id not below the last one; the same id again (a gram repeated within one value) counts once. */
  add(rowId) {
    if (this.count !== 0 && rowId === this.last) return;
    if (this.length + 10 > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    let delta = rowId - this.last;
    while (delta >= 0x80) {
      this.bytes[this.length++] = (delta % 128) | 0x80;
      delta = Math.floor(delta / 128);
    }
    this.bytes[this.length++] = delta;
    this.count++;
    this.last = rowId;
  }
}

export class TrigramIndexBuilder {
  constructor() {
    // Gram -> its row ids (PostingBytes), with no strings created while building. A gram of ASCII code units
    // (c0, c1, c2), the usual case, is keyed as c0·2¹⁴ + c1·2⁷ + c2: a small integer, which V8 hashes fastest. Any
    // other gram is keyed as c0·2³² + c1·2¹⁶ + c2. In both, numeric order equals the code-unit order of the text.
    this.ascii = new Map();
    this.grams = new Map();
    // Value -> the row-id lists of its grams. Indexed text often repeats (names, categories): a value seen before
    // needs only its row id added to each list. Bounded, and dropped when values rarely repeat.
    this.seen = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  add(rowId, value) {
    if (value === null || value.length < 3) return;
    const seen = this.seen;
    if (seen) {
      const lists = seen.get(value);
      if (lists) {
        this.hits++;
        for (let k = 0; k < lists.length; k++) lists[k].add(rowId);
        return;
      }
      if (++this.misses > TRIGRAM_SEEN_LIMIT && this.hits < this.misses) this.seen = null; // values rarely repeat
    }
    const lists = this.seen && this.seen.size < TRIGRAM_SEEN_LIMIT ? [] : null;
    const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c); // same ASCII-only folding as asciiLower()
    let a = lower(value.charCodeAt(0));
    let b = lower(value.charCodeAt(1));
    for (let i = 2; i < value.length; i++) {
      const c = lower(value.charCodeAt(i));
      const ascii = (a | b | c) < 128;
      const grams = ascii ? this.ascii : this.grams;
      const key = ascii ? (a << 14) | (b << 7) | c : a * 4294967296 + b * 65536 + c;
      let ids = grams.get(key);
      if (!ids) grams.set(key, (ids = new PostingBytes(rowId)));
      else ids.add(rowId);
      if (lists) lists.push(ids);
      a = b;
      b = c;
    }
    if (lists) this.seen.set(value, lists);
  }

  encode() {
    // Every gram in the wide form (the ASCII ones converted), in code-unit order.
    const entries = [];
    for (const [key, ids] of this.ascii) entries.push([(key >> 14) * 4294967296 + ((key >> 7) & 127) * 65536 + (key & 127), ids]);
    for (const entry of this.grams) entries.push(entry);
    entries.sort((x, y) => x[0] - y[0]);
    const writer = new ByteWriter();
    writer.byte(POSTINGS_ENCODING);
    writer.varUint(entries.length);
    for (const [key, ids] of entries) {
      writer.u16(Math.floor(key / 4294967296));
      writer.u16(Math.floor(key / 65536) % 65536);
      writer.u16(key % 65536);
      writer.varUint(ids.count); // postings: the count, then the differences already written
      writer.bytes(ids.bytes.subarray(0, ids.length));
    }
    return writer.toBuffer();
  }
}

/** Steps over postings (a count, then that many varints) without making the row ids; `view` is over reader.buf. */
function skipPostings(reader, view) {
  const count = reader.varUint();
  // Each id takes at least one byte: a larger count is damage.
  if (typeof count !== 'number' || count > reader.remaining) throw new JazminFormatError('Postings are truncated');
  const buf = reader.buf;
  let pos = reader.pos;
  let left = count;
  // Eight bytes at a time, counting the bytes that end a varint (high bit clear): a window ends at most 8 varints,
  // so while 8 or more are left it is stepped over whole. Several times quicker than a byte at a time.
  for (const end = buf.length - 8; left >= 8 && pos <= end; pos += 8) {
    const low = (view.getUint32(pos, true) & 0x80808080) >>> 7;
    const high = (view.getUint32(pos + 4, true) & 0x80808080) >>> 7;
    left -= 8 - (Math.imul(low, 0x01010101) >>> 24) - (Math.imul(high, 0x01010101) >>> 24);
  }
  for (; left > 0; pos++) {
    if (pos >= buf.length) throw new JazminFormatError('Postings are truncated');
    if ((buf[pos] & 0x80) === 0) left--;
  }
  reader.pos = pos;
}

/** Postings intersected with the sorted row ids `ids` (kept in place in `ids`) as they are read: no list is made. */
function intersectPostings(reader, ids) {
  const count = reader.varUint();
  if (typeof count !== 'number' || count > reader.remaining) throw new JazminFormatError('Postings are truncated');
  let kept = 0;
  let j = 0;
  let previous = 0;
  for (let i = 0; i < count && j < ids.length; i++) {
    const delta = reader.varUint();
    if (typeof delta !== 'number' || previous + delta > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
    previous += delta;
    while (j < ids.length && ids[j] < previous) j++;
    if (ids[j] === previous) ids[kept++] = ids[j++];
  }
  ids.length = kept;
  return ids;
}

const GRAM_HIGH = 4294967296; // a gram (c0, c1, c2) is held as c0·2³² + c1·2¹⁶ + c2: numeric order is code-unit order

export class TrigramIndex {
  #buf;
  #grams; // each gram as a number (GRAM_HIGH), ascending
  #offsets; // where each gram's postings start in #buf

  constructor(buf, grams, offsets) {
    this.#buf = buf;
    this.#grams = grams;
    this.#offsets = offsets;
  }

  /**
   * Reads where each gram's postings are, into two typed arrays: no strings are made, and no row ids until a lookup
   * needs a gram's. Indexed text often repeats (names, categories), and then the postings are millions of row ids.
   */
  static decode(buf) {
    const reader = new ByteReader(buf);
    checkEncoding(reader, 'Trigram index');
    const count = reader.varUint();
    if (typeof count !== 'number' || count > reader.remaining / 7) throw new JazminFormatError('Trigram index is truncated');
    let grams = new Float64Array(count);
    let offsets = buf.length > 0xffffffff ? new Float64Array(count) : new Uint32Array(count);
    let ascending = true;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
    for (let i = 0; i < count; i++) {
      const c0 = reader.u16();
      const c1 = reader.u16();
      const gram = c0 * GRAM_HIGH + c1 * 65536 + reader.u16();
      if (i > 0 && gram <= grams[i - 1]) ascending = false;
      grams[i] = gram;
      offsets[i] = reader.pos;
      skipPostings(reader, view);
    }
    if (!reader.eof) throw new JazminFormatError('Trigram index has trailing bytes');
    if (!ascending) {
      // Spec 8.2 orders the grams; an index that does not is still read.
      const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => grams[x] - grams[y]);
      grams = Float64Array.from(order, (i) => grams[i]);
      offsets = offsets.constructor.from(order, (i) => offsets[i]);
    }
    return new TrigramIndex(buf, grams, offsets);
  }

  /** Where a gram's postings start, or -1 when no row has it. */
  #find(gram) {
    const grams = this.#grams;
    let lo = 0;
    let hi = grams.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (grams[mid] < gram) lo = mid + 1;
      else if (grams[mid] > gram) hi = mid - 1;
      else return this.#offsets[mid];
    }
    return -1;
  }

  /** The postings of each gram of `text`, rarest first, as { at, count }; or null when a gram is in no row. */
  #lists(text) {
    const lists = [];
    for (const gram of trigrams(text)) {
      const at = this.#find(gram.charCodeAt(0) * GRAM_HIGH + gram.charCodeAt(1) * 65536 + gram.charCodeAt(2));
      if (at < 0) return null;
      lists.push({ at, count: new ByteReader(this.#buf, at).varUint() });
    }
    return lists.sort((x, y) => x.count - y.count);
  }

  /** Whether a trigram index can narrow a search for `text`: not under 3 characters, nor case-insensitive non-ASCII. */
  static answers(text, caseInsensitive) {
    return !(caseInsensitive && /[^\x00-\x7f]/.test(text)) && trigrams(text).size > 0;
  }

  cost(lookup) {
    return lookup.op === 'contains' && TrigramIndex.answers(lookup.text, lookup.ci) ? 0 : null;
  }

  /** At most how many rows rows() returns: those of the text's rarest gram. Read from the postings' counts alone. */
  bound(lookup) {
    const lists = this.#lists(lookup.text);
    return lists === null ? 0 : lists.length ? lists[0].count : Infinity;
  }

  /** How far apart the rows of the text's rarest gram are: from its first row id to its last, inclusive. */
  span(lookup) {
    const lists = this.#lists(lookup.text);
    if (lists === null) return 0;
    if (!lists.length) return Infinity;
    const reader = new ByteReader(this.#buf, lists[0].at);
    const count = reader.varUint();
    let first = 0;
    let last = 0;
    for (let i = 0; i < count; i++) {
      const delta = reader.varUint();
      if (typeof delta !== 'number' || last + delta > Number.MAX_SAFE_INTEGER) throw new JazminFormatError('A row id is out of range');
      last += delta;
      if (i === 0) first = last;
    }
    return count ? last - first + 1 : 0;
  }

  /** Superset of rows that may contain the text (one that TrigramIndex.answers), or null when it has no gram. */
  rows(lookup) {
    const lists = this.#lists(lookup.text);
    if (lists === null) return [];
    if (!lists.length) return null;
    // From the rarest gram, so the ids kept shrink fastest; the other grams' postings are intersected as they are read.
    let result = readPostings(new ByteReader(this.#buf, lists[0].at));
    for (let i = 1; i < lists.length && result.length; i++) result = intersectPostings(new ByteReader(this.#buf, lists[i].at), result);
    return result;
  }
}

/**
 * Answers lookups across several index segments of the same column (the original index plus one
 * per append) by combining their results. Row ids never overlap between segments.
 */
export class CompositeIndex {
  constructor(parts) {
    this.parts = parts;
  }

  cost(lookup) {
    let bytes = 0;
    for (const part of this.parts) {
      const cost = part.cost(lookup);
      if (cost === null) return null;
      bytes += cost;
    }
    return bytes;
  }

  rows(lookup) {
    return unionAll(this.parts.map((p) => p.rows(lookup)));
  }

  /** At most how many rows rows() returns (trigram segments). */
  bound(lookup) {
    return this.parts.reduce((n, p) => n + p.bound(lookup), 0);
  }

  /** How far apart those rows are, summed over the segments (trigram segments). */
  span(lookup) {
    return this.parts.reduce((n, p) => n + p.span(lookup), 0);
  }

  /** Distinct keys, at most (a key found in several segments counts once per segment). */
  get keyCount() {
    return this.parts.reduce((n, p) => n + (p.keyCount ?? 0), 0);
  }
}

const COMMON_SHARE = 1 / 4; // see LazyTrigramIndex.rows

/**
 * A trigram index read only when a lookup is made: until then a lookup costs the whole index's size, so a planner
 * can choose a scan without reading it.
 */
export class LazyTrigramIndex {
  #bytes;
  #load;
  #index = null;

  constructor(bytes, load) {
    this.#bytes = bytes;
    this.#load = load;
  }

  cost(lookup) {
    if (lookup.op !== 'contains' || !TrigramIndex.answers(lookup.text, lookup.ci)) return null;
    return this.#index ? 0 : this.#bytes;
  }

  /**
   * Row ids that may match; or null, given `scanRows` (the rows a scan would read), when the text is common: its
   * rarest gram is in over a quarter of them, spread over more than three quarters. Its rows then fall in most
   * chunks, and a scan checks each row more cheaply. Common text in rows that are together still uses the index,
   * which skips the chunks around them.
   */
  rows(lookup, scanRows) {
    const index = (this.#index ??= this.#load());
    const common = scanRows !== undefined && index.bound(lookup) > scanRows * COMMON_SHARE && index.span(lookup) > scanRows * (1 - COMMON_SHARE);
    return common ? null : index.rows(lookup);
  }
}

export const INDEX_BUILDERS = { sorted: SortedIndexBuilder, trigram: TrigramIndexBuilder };

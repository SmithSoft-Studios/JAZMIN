// Indexes (spec 8): sorted indexes in pages behind a directory, trigram indexes, postings.
import { ByteReader, ByteWriter } from './binary.js';
import { POSTINGS_ENCODING } from './constants.js';
import { JazminFormatError } from './errors.js';
import { unionAll, intersect } from './rowset.js';
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
    // first row id; later row ids only for keys seen again, so a column of unique values (ids) needs no array per key.
    this.keys = [];
    this.firstRows = [];
    this.moreRows = [];
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
        (this.moreRows[at] ??= []).push(rowId);
        return;
      }
      this.positions.set(keyId(key), this.keys.length);
    } else if (this.keys.length > 0) {
      // Keys arriving in ascending order (ids, a sorted column) can only repeat the last one: no lookup needed.
      const n = this.keys.length;
      const last = this.keys[n - 1];
      const order = compareKeys(last, key);
      if (order === 0 && keyId(last) === keyId(key)) {
        (this.moreRows[n - 1] ??= []).push(rowId);
        return;
      }
      if (!(order < 0)) {
        // Out of order: this key starts a new run, or, with too many runs, every key moves to the lookup table.
        this.runs.push({ keys: this.keys, firstRows: this.firstRows, moreRows: this.moreRows });
        this.keys = [];
        this.firstRows = [];
        this.moreRows = [];
        if (this.runs.length >= MAX_RUNS) {
          this.#toTable();
          this.add(rowId, value);
          return;
        }
      }
    }
    this.keys.push(key);
    this.firstRows.push(rowId);
    this.moreRows.push(undefined);
  }

  /** Table mode: the runs' keys in one list, as first seen, with a lookup table; sorted when the pages are written. */
  #toTable() {
    const runs = this.runs;
    this.runs = [];
    this.positions = new Map();
    for (const run of runs) {
      for (let i = 0; i < run.keys.length; i++) {
        const at = this.positions.get(keyId(run.keys[i]));
        if (at === undefined) {
          this.positions.set(keyId(run.keys[i]), this.keys.length);
          this.keys.push(run.keys[i]);
          this.firstRows.push(run.firstRows[i]);
          this.moreRows.push(run.moreRows[i]);
        } else {
          const more = (this.moreRows[at] ??= []);
          more.push(run.firstRows[i]);
          if (run.moreRows[i]) for (const id of run.moreRows[i]) more.push(id);
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
      entry.more = moreRows[i];
      return entry;
    };
    if (this.positions !== null || this.runs.length === 0) {
      const order = Array.from(this.keys, (_, i) => i);
      if (this.positions !== null) order.sort((a, b) => compareKeys(this.keys[a], this.keys[b]));
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
          entry.more = [...(entry.more ?? []), runs[r].firstRows[next[r]], ...(runs[r].moreRows[next[r]] ?? [])];
          next[r]++;
        }
      }
      yield entry;
    }
  }

  /**
   * The index as pages of about `pageBytes` raw bytes each, generated one at a time (spec 8.1):
   * { first (key bytes), count, raw } with raw = encoding byte + varint count + entries.
   * A small index is one page. Row ids of null cells are in `nulls`.
   */
  *pages(pageBytes = INDEX_PAGE_BYTES) {
    const body = new ByteWriter(Math.min(pageBytes * 2, 1 << 20));
    let first;
    let count = 0;
    const page = () => {
      const raw = new ByteWriter(body.length + 11);
      raw.byte(POSTINGS_ENCODING);
      raw.varUint(count);
      raw.bytes(body.buf.subarray(0, body.length));
      const result = { first: encodeBound(this.type, first), count, raw: raw.toBuffer() };
      body.length = 0;
      count = 0;
      return result;
    };
    for (const entry of this.#entries()) {
      if (count === 0) first = entry.key;
      encodeValue(body, this.type, entry.key);
      writeRowIds(body, entry.first, entry.more);
      count++;
      if (body.length >= pageBytes) yield page();
    }
    if (count > 0) yield page();
  }
}

/** Postings (as writePostings) of a key's first row id and its later ones. */
function writeRowIds(writer, first, more) {
  writer.varUint(1 + (more?.length ?? 0));
  writer.varUint(first);
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

  static decodePage(buf, type) {
    const reader = new ByteReader(buf);
    checkEncoding(reader, 'Index page');
    const count = reader.varUint();
    if (typeof count !== 'number' || count > reader.remaining) throw new JazminFormatError('Index page is truncated');
    const keys = new Array(count);
    const postings = new Array(count);
    for (let i = 0; i < count; i++) {
      keys[i] = toKey(type, decodeValue(reader, type));
      postings[i] = readPostings(reader);
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

  /** `directory` is a decoded IndexDirectory (catalog.js). */
  constructor(directory, type, load) {
    this.#pages = directory.pages.map((p) => ({ ...p, first: decodeBound(type, p.first) }));
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
      page = SortedIndex.decodePage(this.#load(`page/${i}`, p), this.#type);
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

export class TrigramIndexBuilder {
  constructor() {
    // Gram -> row ids, with no strings created while building. A gram of ASCII code units (c0, c1, c2), the usual
    // case, is keyed as c0·2¹⁴ + c1·2⁷ + c2: a small integer, which V8 hashes fastest. Any other gram is keyed as
    // c0·2³² + c1·2¹⁶ + c2. In both, numeric order equals the code-unit order of the text.
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
        for (let k = 0; k < lists.length; k++) {
          const ids = lists[k];
          if (ids[ids.length - 1] !== rowId) ids.push(rowId); // a gram repeated within one value counts once
        }
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
      if (!ids) grams.set(key, (ids = [rowId]));
      else if (ids[ids.length - 1] !== rowId) ids.push(rowId); // a gram repeated within one value counts once
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
      writePostings(writer, ids);
    }
    return writer.toBuffer();
  }
}

export class TrigramIndex {
  constructor(grams) {
    this.grams = grams;
  }

  static decode(buf) {
    const reader = new ByteReader(buf);
    checkEncoding(reader, 'Trigram index');
    const count = reader.varUint();
    if (typeof count !== 'number' || count > reader.remaining / 7) throw new JazminFormatError('Trigram index is truncated');
    const grams = new Map();
    for (let i = 0; i < count; i++) {
      const gram = String.fromCharCode(reader.u16(), reader.u16(), reader.u16());
      grams.set(gram, readPostings(reader));
    }
    if (!reader.eof) throw new JazminFormatError('Trigram index has trailing bytes');
    return new TrigramIndex(grams);
  }

  /** Whether a trigram index can narrow a search for `text`: not under 3 characters, nor case-insensitive non-ASCII. */
  static answers(text, caseInsensitive) {
    return !(caseInsensitive && /[^\x00-\x7f]/.test(text)) && trigrams(text).size > 0;
  }

  cost(lookup) {
    return lookup.op === 'contains' && TrigramIndex.answers(lookup.text, lookup.ci) ? 0 : null;
  }

  rows(lookup) {
    return this.#candidates(lookup.text);
  }

  /** Superset of rows that may contain `text` (one that TrigramIndex.answers). */
  #candidates(text) {
    const grams = trigrams(text);
    let result = null;
    for (const gram of grams) {
      const ids = this.grams.get(gram);
      if (!ids) return [];
      result = result === null ? ids : intersect(result, ids);
      if (result.length === 0) return result;
    }
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

  /** Distinct keys, at most (a key found in several segments counts once per segment). */
  get keyCount() {
    return this.parts.reduce((n, p) => n + (p.keyCount ?? 0), 0);
  }
}

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

  rows(lookup) {
    this.#index ??= this.#load();
    return this.#index.rows(lookup);
  }
}

export const INDEX_BUILDERS = { sorted: SortedIndexBuilder, trigram: TrigramIndexBuilder };

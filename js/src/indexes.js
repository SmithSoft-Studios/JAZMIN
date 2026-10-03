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

/** Builds a sorted value index: distinct key forms in ascending order, each with its row ids. */
export class SortedIndexBuilder {
  constructor(type) {
    this.type = type;
    this.entries = new Map(); // key id -> { key, ids }
    this.nulls = [];
  }

  add(rowId, value) {
    if (value === null) {
      this.nulls.push(rowId);
      return;
    }
    const key = toKey(this.type, value);
    if (Number.isNaN(key)) return; // NaN is never indexed (it is not equal to anything)
    const id = keyId(key);
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, (entry = { key, ids: [] }));
    entry.ids.push(rowId);
  }

  /**
   * The index as pages of about `pageBytes` raw bytes each, generated one at a time (spec 8.1):
   * { first (key bytes), count, raw } with raw = encoding byte + varint count + entries.
   * A small index is one page. Row ids of null cells are in `nulls`.
   */
  *pages(pageBytes = INDEX_PAGE_BYTES) {
    const sorted = [...this.entries.values()].sort((a, b) => compareKeys(a.key, b.key));
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
    for (const { key, ids } of sorted) {
      if (count === 0) first = key;
      encodeValue(body, this.type, key);
      writePostings(body, ids);
      count++;
      if (body.length >= pageBytes) yield page();
    }
    if (count > 0) yield page();
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

  /** op: 'gt' | 'gte' | 'lt' | 'lte' */
  range(op, value) {
    if (Number.isNaN(value)) return [];
    switch (op) {
      case 'gt': return this.#span(this.#bound(value, true), this.keys.length);
      case 'gte': return this.#span(this.#bound(value, false), this.keys.length);
      case 'lt': return this.#span(0, this.#bound(value, false));
      case 'lte': return this.#span(0, this.#bound(value, true));
      default: throw new Error(`Unsupported range op ${op}`);
    }
  }

  prefix(text) {
    const start = this.#bound(text, false);
    let end = start;
    while (end < this.keys.length && this.keys[end].startsWith(text)) end++;
    return this.#span(start, end);
  }
}

const PAGES_CACHED = 8; // decoded pages kept per index: lookups stay fast, memory stays bounded

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

  eq(value) {
    if (Number.isNaN(value)) return [];
    const i = this.#pageFor(value);
    return i < 0 ? [] : this.#page(i).eq(value);
  }

  /** op: 'gt' | 'gte' | 'lt' | 'lte'; reads only the pages the range spans. */
  range(op, value) {
    if (Number.isNaN(value)) return [];
    const i = this.#pageFor(value);
    const lists = [];
    if (op === 'gt' || op === 'gte') {
      for (let j = Math.max(i, 0); j < this.#pages.length; j++) lists.push(this.#page(j).range(op, value));
    } else {
      for (let j = 0; j <= i; j++) lists.push(this.#page(j).range(op, value));
    }
    return unionAll(lists);
  }

  prefix(text) {
    const lists = [];
    // Keys starting with `text` are contiguous: continue while the next page may still start with it.
    for (let j = Math.max(this.#pageFor(text), 0); j < this.#pages.length; j++) {
      lists.push(this.#page(j).prefix(text));
      if (j + 1 >= this.#pages.length || !this.#pages[j + 1].first.startsWith(text)) break;
    }
    return unionAll(lists);
  }

  get nulls() {
    return this.#nullsAt ? decodePostingsSection(this.#load('nulls', this.#nullsAt), 'Index null postings') : [];
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
export class TrigramIndexBuilder {
  constructor() {
    // Gram -> row ids. A gram of code units (c0, c1, c2) is keyed as the number c0·2³² + c1·2¹⁶ + c2:
    // no strings are created while building, and numeric order equals the code-unit order of the text.
    this.grams = new Map();
  }

  add(rowId, value) {
    if (value === null || value.length < 3) return;
    const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c); // same ASCII-only folding as asciiLower()
    let a = lower(value.charCodeAt(0));
    let b = lower(value.charCodeAt(1));
    for (let i = 2; i < value.length; i++) {
      const c = lower(value.charCodeAt(i));
      const key = a * 4294967296 + b * 65536 + c;
      const ids = this.grams.get(key);
      if (!ids) this.grams.set(key, [rowId]);
      else if (ids[ids.length - 1] !== rowId) ids.push(rowId); // a gram repeated within one value counts once
      a = b;
      b = c;
    }
  }

  encode() {
    const sorted = [...this.grams.keys()].sort((x, y) => x - y);
    const writer = new ByteWriter();
    writer.byte(POSTINGS_ENCODING);
    writer.varUint(sorted.length);
    for (const key of sorted) {
      writer.u16(Math.floor(key / 4294967296));
      writer.u16(Math.floor(key / 65536) % 65536);
      writer.u16(key % 65536);
      writePostings(writer, this.grams.get(key));
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

  /**
   * Superset of rows that may contain `text`, or null when the index cannot help
   * (text shorter than 3, or a case-insensitive search with non-ASCII characters).
   */
  candidates(text, caseInsensitive) {
    if (caseInsensitive && /[^\x00-\x7f]/.test(text)) return null;
    const grams = trigrams(text);
    if (grams.size === 0) return null;
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

  eq(value) {
    return unionAll(this.parts.map((p) => p.eq(value)));
  }

  range(op, value) {
    return unionAll(this.parts.map((p) => p.range(op, value)));
  }

  prefix(text) {
    return unionAll(this.parts.map((p) => p.prefix(text)));
  }

  get nulls() {
    return unionAll(this.parts.map((p) => p.nulls));
  }

  candidates(text, caseInsensitive) {
    const lists = [];
    for (const part of this.parts) {
      const ids = part.candidates(text, caseInsensitive);
      if (ids === null) return null;
      lists.push(ids);
    }
    return unionAll(lists);
  }
}

export const INDEX_BUILDERS = { sorted: SortedIndexBuilder, trigram: TrigramIndexBuilder };

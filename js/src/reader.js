// Reads JAZMIN format 1.0 files (docs/rfc/draft-jazmin-format-03.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  FileSecrets, digest, findKeySlotPage, headerKey, keySlotPages, ownerDirectoryKey, parseKeySlots, partKey, partitionName, sectionKeyFrom,
  unsealSlot, verifyOwner, verifySignedBy,
} from './access.js';
import { crc32, parseJsonText } from './binary.js';
import { checkLinks, readLinks } from './links.js';
import {
  decodeChunkDirectoryLists, decodeChunkMap, decodeColumnDefinitions, decodeDelta, decodeHeader, decodeIndexDirectory, decodeOwnerCatalog, joinChunkMaps,
  decodePartitionTable, decodeStatistics, findPartitions,
} from './catalog.js';
import { decodeColumnar, decodeColumnarAt } from './columnar.js';
import {
  CODEC, DRAFT_MAGIC, EDIT_LIMITS, ENVELOPE_SIZE, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, KEYRING_GROUPS,
  INDEX_DELTAS, KNOWN_FLAGS, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, SUPPORTED_READER_FEATURES,
  SUPPORTED_WRITER_FEATURES, TRAILER_SIZE, WHOLE_TABLE,
} from './constants.js';
import { JazminFileLockedError, JazminFormatError, JazminKeyError, JazminValidationError } from './errors.js';
import { enforceExpiry, toMs } from './expiry.js';
import { EVERYONE, effectiveEdit, keyServiceAddress, mergeActions, normalizeEdit, normalizeEditLimit, readActions, readPage } from './files.js';
import { answeredExactly, evaluate, filterReads, indexPlan, mayMatch, mustMatch, normalizeFilter } from './filter.js';
import { CompositeIndex, LazyTrigramIndex, PagedSortedIndex, TrigramIndex, decodePostingsSection } from './indexes.js';
import { HkdfKeys, JazminAccessKey, JazminKey, KeySchedule, deriveFromPassword, hkdf, parseAnyKey, parseUnlockToken, slotId } from './keys.js';
import {
  LOCK_KINDS, checkLockIterations, lockKey, lockNeeds, openContentKey, openGroupSecret, parseFileUnlockToken, readOwnerLocks,
} from './locks.js';
import { checkPriority, readThreads } from './priority.js';
import { directoryShapes, shapeFits } from './saved-shapes.js';
import { setField } from './schema.js';
import { SectionPool } from './section-pool.js';
import { decodeSection, sectionKeyCheck, sectionPayloadLength } from './section.js';
import { decodeBound } from './stats.js';
import { compareKeys } from './types.js';
import { openFileSync } from './open-retry.js';


/** First index in a sorted array whose value is >= target. */
function lowerBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bounds on one column implied by a filter: { low, lowInclusive, high, highInclusive }, or null
 * when the filter does not restrict the column (only top-level AND conditions are used).
 */
function sortBounds(plan, col) {
  const leaves = plan.kind === 'and' ? plan.items : [plan];
  let bounds = null;
  const tighten = (low, lowInclusive, high, highInclusive) => {
    bounds ??= {};
    if (low !== undefined && (bounds.low === undefined || compareKeys(low, bounds.low) > 0)) Object.assign(bounds, { low, lowInclusive });
    if (high !== undefined && (bounds.high === undefined || compareKeys(high, bounds.high) < 0)) Object.assign(bounds, { high, highInclusive });
  };
  for (const leaf of leaves) {
    if (leaf.kind !== 'leaf' || leaf.col !== col || Number.isNaN(leaf.value)) continue;
    switch (leaf.op) {
      case 'eq': tighten(leaf.value, true, leaf.value, true); break;
      case 'gt': tighten(leaf.value, false, undefined); break;
      case 'gte': tighten(leaf.value, true, undefined); break;
      case 'lt': tighten(undefined, false, leaf.value, false); break;
      case 'lte': tighten(undefined, false, leaf.value, true); break;
      default: break;
    }
  }
  return bounds;
}

/**
 * Row `r` of a decoded chunk (see #chunk), written by column position into `into`, an array of nulls: only the
 * decoded columns are written. A chunk may hold more columns than asked for (see decodedAll), so reuse `into` across
 * chunks only when reading just the columns asked for.
 */
function chunkRow(chunk, r, into) {
  for (const c of chunk.decoded) into[c] = chunk.columns[c][r];
  return into;
}

const PIECE = 8192; // values per piece of a column array: pieces are joined once, at the end
const NUMBER_TYPES = new Set(['int', 'float', 'datetime']);

/**
 * Collects one column's values for columnArrays(): numbers and dates (as milliseconds) in a Float64Array, bools in a
 * Uint8Array (1 = true), other types in a plain array. Typed arrays cannot hold null: those rows hold NaN (0 for bools)
 * and their bit is set in a null bitmap (bit i & 7 of byte i >> 3). Values are gathered in pieces and joined at the
 * end, so memory peaks at about twice the result. add(column, from, to) takes a decoded column's rows from..to-1 in
 * one loop: a full read hands over each chunk's rows at once.
 */
function columnCollector({ name, type }) {
  const Typed = NUMBER_TYPES.has(type) ? Float64Array : type === 'bool' ? Uint8Array : null;
  if (!Typed) {
    const values = [];
    return {
      add(column, from, to) {
        for (let r = from; r < to; r++) values.push(column[r]);
      },
      finish: () => ({ values }),
    };
  }
  const pieces = [];
  let piece = new Typed(PIECE);
  let used = 0;
  let count = 0;
  const nullRows = [];
  return {
    add(column, from, to) {
      for (let r = from; r < to; r++) {
        if (used === PIECE) {
          pieces.push(piece);
          piece = new Typed(PIECE);
          used = 0;
        }
        const v = column[r];
        if (v === null) {
          nullRows.push(count);
          piece[used] = Typed === Float64Array ? NaN : 0;
        } else if (type === 'datetime') piece[used] = typeof v === 'number' ? v : v.getTime();
        else if (type === 'bool') piece[used] = v ? 1 : 0;
        else if (typeof v === 'bigint') throw new JazminValidationError(`Column '${name}' holds ${v}, beyond ±2^53: a Float64Array cannot hold it exactly (use find())`);
        else piece[used] = v;
        used++;
        count++;
      }
    },
    finish() {
      const values = new Typed(count);
      let at = 0;
      for (const p of pieces) {
        values.set(p, at);
        at += p.length;
      }
      values.set(piece.subarray(0, used), at);
      if (!nullRows.length) return { values };
      const nulls = new Uint8Array((count + 7) >> 3);
      for (const r of nullRows) nulls[r >> 3] |= 1 << (r & 7);
      return { values, nulls };
    },
  };
}

/** Whether a chunk decoded with the columns `have` (by position; null: all) holds every column `need` asks for. */
const decodedAll = (have, need) => have === null || (need !== null && need.every((wanted, c) => !wanted || have[c]));

/** The type of the leaf at `path` (field positions; a list's item adds none) in a nested column, or null when none. */
function leafType(column, path) {
  let node = column;
  for (const step of path) {
    while (node.type === 'list') node = node.item;
    if (node.type !== 'object' || !(Number.isInteger(step) && step >= 0 && step < node.fields.length)) return null;
    node = node.fields[step];
  }
  while (node.type === 'list') node = node.item;
  return node.type === 'object' ? null : node.type;
}

/** Positions of the columns a normalized filter reads. */
function planColumns(plan) {
  const cols = new Set();
  (function collect(node) {
    if (node.kind === 'leaf' || node.kind === 'nested') cols.add(node.col);
    else (node.items ?? [node.item]).forEach(collect);
  })(plan);
  return cols;
}

/** The top-level AND condition (eq / in / isNull:true) that pins the partition column to exact values, or null. */
function partitionLeaf(plan, col) {
  if (col < 0) return null;
  const leaves = plan.kind === 'and' ? plan.items : [plan];
  return leaves.find((leaf) => leaf.kind === 'leaf' && leaf.col === col
    && (leaf.op === 'eq' || leaf.op === 'in' || (leaf.op === 'isNull' && leaf.value))) ?? null;
}

/** Partition names a filter pins the partition column to, or null when it does not restrict it to exact values. */
function partitionLookup(plan, col) {
  const leaf = partitionLeaf(plan, col);
  if (!leaf) return null;
  if (leaf.op === 'eq') return [partitionName(leaf.value)];
  if (leaf.op === 'in') return leaf.value.map((v) => partitionName(v));
  return [''];
}

/**
 * The statistics every chunk of a pinned partition has for the partition column: all its rows hold the one value
 * (or null) that names the partition. Undefined for `in`, whose partitions hold different values.
 */
function pinnedPartitionStats(plan, col) {
  const leaf = partitionLeaf(plan, col);
  if (!leaf || leaf.op === 'in') return undefined;
  return (rowCount) => (leaf.op === 'eq' ? { nulls: 0, min: leaf.value, max: leaf.value } : { nulls: rowCount });
}

/** Internal: state the appender needs to continue an existing file (see append.js). */
/** Internal: what key rotation needs (see the getter). */
export const KEY_ROTATION = Symbol('jazmin.keyRotation');

/** Internal: whether a reader's file uses compact sorted indexes (update keeps them). */
export const COMPACT_INDEXES = Symbol('jazmin.compactIndexes');
export const APPEND_STATE = Symbol('jazmin.appendState');

/** Internal: yields [rowId, row object] for visible, non-deleted rows matching a filter. */
export const ROWS_WITH_IDS = Symbol('jazmin.rowsWithIds');

/** Internal: lets update() carry an access-controlled file's grants into its next version. */
export const OWNER_GRANTS = Symbol('jazmin.ownerGrants');
export const ROWS_BY_PARTITION = Symbol('jazmin.rowsByPartition');

/** Internal: lets update() and append() carry a file's embedded files into its next version. */
export const FILE_STATE = Symbol('jazmin.fileState');

/** Internal: the owner directory's locks (spec 6.8.1), Map(id -> lock), or null when the key is not the owner's. */
export const OWNER_LOCKS = Symbol('jazmin.ownerLocks');

/** Internal: the owner directory's masked columns (spec 7.6.8), as it keeps them, or null when the key is not the owner's. */
export const OWNER_MASKS = Symbol('jazmin.ownerMasks');

/**
 * Refuses a file with a writer feature this library does not support (spec 12): modifying it could lose what the
 * feature keeps. Called before an append or a rewrite.
 */
export function checkWriterFeatures(reader) {
  for (const feature of reader.writerFeatures) {
    if (!SUPPORTED_WRITER_FEATURES.has(feature) && !SUPPORTED_READER_FEATURES.has(feature)) {
      throw new JazminFormatError(`This file needs the writer feature '${feature}' to be modified, which this JAZMIN library does not support`);
    }
  }
}

const NEXT_CHUNK = Symbol('jazmin.nextChunk'); // yielded by internal scans before each chunk is read (findAsync)
const READ_AHEAD = 2; // chunks read ahead by findAsync
const SMALL_LOOKUP_BYTES = 8 * 1024; // index lookups this small are always made: the bytes are negligible, and rows are not decoded
// Index candidates are decoded on their own (decodeColumnarAt) when they are at most this share of a chunk's rows: the
// values between them are passed over without being made. More candidates are decoded with their whole columns.
const FEW_ROWS = 1 / 8;
/**
 * What an owner's index lookup may cost (bytes of index pages) to be made before reading every partition: the
 * alternative reads at least a section per partition (chunk directories, statistics).
 */
const ownerLookupBudget = (partitions) => SMALL_LOOKUP_BYTES * Math.max(1, partitions);
// Many catalog sections read together (an owner's chunk directories and statistics: one per partition) are read in
// ranges: from READ_AHEAD_SECTIONS sections, those at most READ_AHEAD_GAP apart share a read of at most READ_AHEAD_MAX
// bytes. A read is a system call; the gaps are other small catalog sections.
const READ_AHEAD_SECTIONS = 16;
// A publisher signature block's footer (spec 6.9.1): length, CRC-32, version, reserved, magic 'JZPS'.
const PUBLISHER_FOOTER_SIZE = 16;
const PUBLISHER_MAGIC = 0x53505a4a; // 'JZPS', read little-endian
const READ_AHEAD_GAP = 4 * 1024;
const READ_AHEAD_MAX = 8 * 1024 * 1024;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve)); // lets timers and I/O callbacks run

/**
 * Progress and stopping for a long read (`onProgress`, `signal`), as the browser reader has them: before each chunk is
 * read, the chunks finished so far are reported as { done, total, matches } and the signal is checked, so a stop takes
 * effect before the next chunk. `total` is the chunks the read plans to read.
 */
function chunkStarts(watch, matches) {
  if (watch.started > 0) watch.onProgress?.({ done: watch.started, total: watch.total, matches });
  watch.signal?.throwIfAborted();
  watch.started++;
}

/** The last report, once the read is done (or a limit ended it): the chunks it read. */
function chunksDone(watch, matches) {
  if (watch.started > 0) watch.onProgress?.({ done: watch.started, total: watch.total, matches });
}

/** Internal: openTable() passes this as the source, with the reader it shares the open file with. */
const SHARED = Symbol('jazmin.shared');
const FIND_KEY = Symbol('jazmin.findKey');

/**
 * Internal (applyChanges): the index of the first of `keys` (key bytes) that opens the key-encrypted file `source`, or
 * -1. The file is read once; each key then costs only deriving its header key and checking the header's tag, instead of
 * a whole open. Open the file with the key found as usual: that checks everything else.
 */
export function findKey(source, keys) {
  return new JazminReader(source, { [FIND_KEY]: keys })[FIND_KEY];
}
/** Internal: the priority a reader was opened with ('memory', 'balanced' or 'speed'), for exports that batch. */
export const READ_PRIORITY = Symbol('jazmin.readPriority');
/**
 * Internal (applyChanges, fileSubmission): refuse Brotli sections. Change files and submissions are written by people
 * the owner doesn't control, and JAZMIN never writes them with Brotli, so a Brotli section there can only be meant for
 * the decoder (CVE-2026-111497): it is refused before anything is decompressed.
 */
export const NO_BROTLI = Symbol('jazmin.noBrotli');

/** Releases a byte source shared by the readers of several tables (openTable): the last one closes it. */
function release(source) {
  source.refs = (source.refs ?? 1) - 1;
  if (source.refs <= 0) source.close();
}

/** Internal: a source object carrying this symbol is used by the reader as-is (see openAsync). */
export const SOURCE = Symbol('jazmin.source');

/**
 * Byte source over an open file. Besides synchronous reads, it can load byte ranges ahead with non-blocking
 * reads (`load`); `read` then serves them from memory. findAsync and openAsync use this, so the synchronous
 * query engine runs unchanged on bytes that were read asynchronously.
 */
export function fileSource(fd, size) {
  let loaded = []; // { start, buf } ranges read ahead of use
  let generation = 0; // drop() discards loads still in flight
  let inFlight = 0;
  let closing = false;
  return {
    [SOURCE]: true,
    size,
    onRead: null, // called with a loaded range's start when it is read (findAsync tracks progress with it)
    read(position, length, scratch) {
      if (position < 0 || position + length > size) throw new JazminFormatError('Unexpected end of file');
      for (const range of loaded) {
        if (position >= range.start && position + length <= range.start + range.buf.length) {
          this.onRead?.(range.start);
          return range.buf.subarray(position - range.start, position - range.start + length);
        }
      }
      const buf = scratch && scratch.length >= length ? scratch.subarray(0, length) : Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const n = fs.readSync(fd, buf, offset, length - offset, position + offset);
        if (n === 0) throw new JazminFormatError('Unexpected end of file');
        offset += n;
      }
      return buf;
    },
    /** Reads a range with non-blocking reads and keeps it for `read` until released or dropped. */
    load(position, length) {
      if (position < 0 || position + length > size) return Promise.reject(new JazminFormatError('Unexpected end of file'));
      const started = generation;
      const buf = Buffer.allocUnsafe(length);
      inFlight++;
      return new Promise((resolve, reject) => {
        const finish = (error) => {
          if (--inFlight === 0 && closing) fs.close(fd, () => {});
          if (error) reject(error);
          else {
            if (started === generation && !closing) loaded.push({ start: position, buf });
            resolve();
          }
        };
        const step = (offset) => {
          if (offset >= length) return finish();
          fs.read(fd, buf, offset, length - offset, position + offset, (error, n) => {
            if (error) return finish(error);
            if (n === 0) return finish(new JazminFormatError('Unexpected end of file'));
            step(offset + n);
          });
        };
        step(0);
      });
    },
    release(start) {
      loaded = loaded.filter((range) => range.start !== start);
    },
    /** Reads a range now and keeps it for `read` until `unload(range)`: many small sections in one read. */
    preload(position, length) {
      if (position < 0 || position + length > size) throw new JazminFormatError('Unexpected end of file');
      const buf = Buffer.allocUnsafe(length);
      for (let offset = 0; offset < length;) {
        const n = fs.readSync(fd, buf, offset, length - offset, position + offset);
        if (n === 0) throw new JazminFormatError('Unexpected end of file');
        offset += n;
      }
      const range = { start: position, buf };
      loaded.push(range);
      return range;
    },
    unload(range) {
      loaded = loaded.filter((r) => r !== range);
    },
    drop() {
      generation++;
      loaded = [];
    },
    close() {
      loaded = [];
      if (inFlight > 0) closing = true; // closed when the reads in flight finish
      else fs.closeSync(fd);
    },
  };
}

/** Random-access byte source over a file path or an in-memory buffer. */
export function openSource(source) {
  if (source?.[SOURCE]) return source;
  if (typeof source === 'string') {
    const fd = openFileSync(source, 'r');
    return fileSource(fd, fs.fstatSync(fd).size);
  }
  if (source instanceof Uint8Array) {
    const buf = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    return {
      size: buf.length,
      read(position, length) {
        if (position < 0 || position + length > buf.length) throw new JazminFormatError('Unexpected end of file');
        return buf.subarray(position, position + length);
      },
      close: () => {},
    };
  }
  throw new JazminValidationError('Source must be a file path or a Buffer/Uint8Array');
}

/**
 * A column name as a property key in generated code. The names come from the file, so they are written as JSON
 * strings (never as code). `__proto__` is computed: in a literal, `"__proto__": v` sets the prototype instead of
 * adding a field (issue #68).
 */
const literalKey = (name) => (name === '__proto__' ? '["__proto__"]' : JSON.stringify(name));

/**
 * Builds a function that turns a row array into an object. Creating every object with one literal
 * gives V8 a single object shape, which is markedly faster than adding properties one by one.
 * Falls back to assigning the fields one by one where code generation is disabled.
 */
function objectMaker(names, indexes) {
  try {
    return new Function('row', `return { ${names.map((n, k) => `${literalKey(n)}: row[${indexes[k]}]`).join(', ')} };`);
  } catch {
    // e.g. node --disallow-code-generation-from-strings
    return (row) => {
      const out = {};
      for (let k = 0; k < names.length; k++) setField(out, names[k], row[indexes[k]]);
      return out;
    };
  }
}

/**
 * Builds a function turning row `r` of decoded column arrays into an object with the selected columns.
 * Objects are built one at a time as rows are consumed, so a chunk's rows are never all alive at once.
 * Returns null where code generation is disabled.
 */
function columnsToObject(columns, select) {
  const object = select.map((i) => `${literalKey(columns[i].name)}: c[${i}][r]`).join(', ');
  try {
    return new Function('c', 'r', `return { ${object} };`);
  } catch {
    return null;
  }
}

/** Public form of a catalog column definition (with a list's item or an object's fields, spec 5.4). */
function publicColumn(c) {
  return {
    name: c.name,
    type: c.type,
    nullable: !c.required,
    ...(c.description ? { description: c.description } : {}),
    ...(c.attributes ? { attributes: parseJsonText(c.attributes, `Column '${c.name}' attributes`, true) } : {}),
    ...(c.item ? { item: publicColumn(c.item) } : {}),
    ...(c.fields ? { fields: c.fields.map(publicColumn) } : {}),
  };
}

const idText = (id) => (id.length ? id.toString('base64url') : WHOLE_TABLE);

/** The key-slot and signature sections are stored unencrypted and uncompressed (spec 7.6.4); anything else is refused. */
function plainSection(section, sectionId) {
  if (section.length < ENVELOPE_SIZE || section[0] !== CODEC.none || section[1] !== 0) throw new JazminFormatError(`Section '${sectionId}' must be stored as is`);
  return section;
}

/**
 * An owner directory grant's column groups ('*': all): masked groups are listed apart, and a grant of every group says
 * so (spec 7.6.8).
 */
/**
 * A grant's (or a key's own) edit member (spec 7.9.1): { edit, lost, unreadable }. In a file with limits a grant without
 * one may send nothing (an older release lost it), and so may one this library can't read. {} is no limit.
 */
const NO_LIMIT = Object.freeze({ edit: undefined, lost: false, unreadable: false });

function readEditLimit(value, limitsFile) {
  if (value === undefined) return limitsFile ? { edit: undefined, lost: true, unreadable: false } : NO_LIMIT;
  // {}: no limit, the most common value in a file with limits, read without the full check.
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && isEmptyObject(value)) return NO_LIMIT;
  try {
    const edit = normalizeEditLimit(value, 'edit');
    return { edit: Object.keys(edit).length ? edit : undefined, lost: false, unreadable: false };
  } catch {
    return { edit: undefined, lost: true, unreadable: true };
  }
}

function isEmptyObject(value) {
  for (const _ in value) return false;
  return true;
}

function grantColumns(g) {
  if (g.allColumns === true) return '*';
  return Array.isArray(g.maskedColumns) && Array.isArray(g.columns) ? [...g.columns, ...g.maskedColumns] : g.columns;
}

/**
 * A key slot's masked columns (spec 7.6.8): { locks: Map(id -> lock), groups: Map(group -> { lock, sealed, column }) };
 * empty when the slot has none. A member that isn't well-formed is refused.
 */
function readBundleMasks(masks) {
  const out = { locks: new Map(), groups: new Map() };
  if (masks === undefined) return out;
  const ok = (test) => {
    if (!test) throw new JazminFormatError("The key slot's masked columns are malformed");
  };
  ok(masks && typeof masks === 'object' && masks.locks && typeof masks.locks === 'object' && masks.groups && typeof masks.groups === 'object');
  for (const [id, l] of Object.entries(masks.locks)) {
    ok(l && LOCK_KINDS.includes(l.kind) && typeof l.salt === 'string');
    out.locks.set(id, { id, kind: l.kind, salt: Buffer.from(l.salt, 'base64'), iterations: l.iterations, keyService: keyServiceAddress(l.keyService) });
  }
  for (const [group, g] of Object.entries(masks.groups)) {
    const c = g?.column;
    ok(g && out.locks.has(g.lock) && typeof g.sealed === 'string' && c && Number.isSafeInteger(c.table) && Number.isSafeInteger(c.position)
      && typeof c.name === 'string' && typeof c.type === 'string');
    out.groups.set(group, { lock: g.lock, sealed: g.sealed, column: c });
  }
  return out;
}

/** Checks the shape of an embedded-file directory (JSON, spec 6.8) before it is used. */
function checkFileDirectory(d) {
  const ok = (test) => {
    if (!test) throw new JazminFormatError('An embedded-file directory is malformed');
  };
  const count = (v) => Number.isSafeInteger(v) && v >= 0;
  ok(d && typeof d === 'object' && Array.isArray(d.files) && Array.isArray(d.contents));
  for (const c of d.contents) {
    ok(c && count(c.id) && count(c.size) && typeof c.sha256 === 'string' && Array.isArray(c.blocks));
    ok(count(c.blockSize) && c.blockSize > 0 && c.blocks.length === Math.ceil(c.size / c.blockSize));
    ok(c.key === undefined || typeof c.key === 'string');
    ok(c.lock === undefined || (typeof c.lock === 'string' && c.key === undefined));
    for (const b of c.blocks) ok(b && count(b.offset) && count(b.length) && (b.digest === undefined || typeof b.digest === 'string'));
  }
  for (const f of d.files) {
    ok(f && typeof f.path === 'string' && typeof f.type === 'string' && count(f.content));
    ok(f.groups === undefined || (Array.isArray(f.groups) && f.groups.every((g) => typeof g === 'string')));
  }
  ok(d.locks === undefined || Array.isArray(d.locks));
  for (const l of d.locks ?? []) {
    ok(l && typeof l.id === 'string' && LOCK_KINDS.includes(l.kind) && typeof l.salt === 'string');
    ok(l.keys && typeof l.keys === 'object' && Object.values(l.keys).every((k) => typeof k === 'string'));
  }
  return d;
}

/**
 * Random-access reader. Opening reads the trailer and header (and, for access-controlled files, the key
 * slots, signature and the key's own chunk directories); chunks, statistics and indexes are read on
 * demand, one decoded chunk cached at a time.
 *
 * With an access key, only the granted partitions and column groups are visible: hidden rows are simply
 * not returned, and hidden columns are not part of `columns`.
 */
export class JazminReader {
  #source;
  #header;
  #table;
  #tableIndex = 0; // the table read: its number in the file
  #metadata;
  #fileId;
  #salt;
  #keys = null; // key or password files
  #access = null; // access mode: { isOwner, secrets, partitions: Map id->secret, partitionNames, columns: Map group->secret, ... }
  #columns; // by position; hidden columns are placeholders { name: null, type: null }
  #types;
  #streamTypes;
  #visibleCols; // positions this reader may return
  #groups; // column groups: [{ name, cols, visible }]
  #groupOf; // position -> column group index
  #partitions = new Map(); // id text -> { id, segments, loaded, visible, ordinals }, for partitions looked up so far
  #partitionTable = null; // the partition table's bytes until every partition is listed
  #deltaSegments = new Map(); // id text -> directory segments added by appends (deltas), in order
  #allListed = false;
  #tableLookups = 0; // partition-table scans so far: repeated lookups decode it once instead
  #allLoaded = false;
  #segments = []; // loaded directory segments: { partition, suffix, ordinals, statistics, statsLoaded: Set }
  // Chunks by ordinal, in typed arrays (no object per chunk): filled as their partitions' directories load.
  #rowStart;
  #rowCount;
  #loaded;
  #chunkPartition;
  #partOffset; // ordinal * groups + group
  #partLength;
  // Access-controlled files: each part's digest, as the directory section that holds it (#digestBlocks, by position
  // + 1; 0 for none) and its place there. Typed arrays, not a view per part: a file can have a chunk per row.
  #digestBlocks = [];
  #partDigestBlock = null;
  #partDigestAt = null;
  #visibleChunks = new Int32Array(0); // loaded, visible ordinals in order
  #colStats = []; // per column, once a query needs it: { nulls, min, max, has } by ordinal
  #statCols = new Set(); // columns whose statistics queries have needed (loaded for every loaded segment)
  #statOrdinal = 0;
  #statLookup = (col) => this.#statAt(col, this.#statOrdinal); // statistics of one chunk, for mayMatch
  #leafStats = []; // by column: nested columns' leaves' statistics, by path ("1,0")
  #leafLookup = (col, path) => this.#leafAt(col, path, this.#statOrdinal);
  #indexRefs = null;
  #indexes = new Map();
  #indexProvider = { get: (column, kind) => this.#index(column, kind) };
  #readAheads = []; // ranges read ahead (#readAhead) while they are held
  #map; // the owner's chunk map (#chunkMap): undefined until looked up, null when there is none
  #grantKeys = new Map(); // grant key text -> parsed access key (owner)
  #hasLimits; // whether grants limit what keys send back (spec 7.9.1), once known
  #grantInfos; // the owner's grants list, once built
  // The last chunk decoded, the columns decoded (null: all) and the definitions they were decoded with.
  #cachedChunk = { ordinal: -1, wanted: null, types: null, chunk: null };
  #sortStatsComplete; // computed on first sorted scan
  #flags = 0;
  #noBrotli = false; // NO_BROTLI
  #deleted = []; // sorted row ids removed by appends
  #deletedVisible; // computed on first use
  #validEnd = 0; // end of the trailer in use (an interrupted append may have left bytes after it)
  #headerRef = null; // where the header section is ({ offset, length }), from the trailer
  #recovered = false;
  #closed = false;
  #readOptions;
  #makers = new Map(); // selected column indexes -> row-object builder
  #shapeList = null; // saved shapes this key can use, worked out once
  #fileIndex = null; // embedded files visible to this key: { entries: Map(path -> entry), contents: Map(id -> content), shapes }
  #scratch = Buffer.alloc(0); // file-read buffer reused across chunks (see #readChunk)
  #ahead = null; // priority 'speed': { pool, ordinals } - chunks being decoded on worker threads, in the order submitted
  #aheadBuffer = Buffer.alloc(0); // file-read buffer of chunks read ahead (the pool copies what it is given)
  #cost = null; // while explain({ analyze: true }) runs a query: what it reads (see QueryCost in index.d.ts)

  /**
   * options: key | password; for online access keys `unlockToken` (from the owner's key service);
   * `now` (Date / ms, default the system clock) and `accessState` ({ dir } | custom store | false)
   * for expiring keys - see enforceExpiry; `table`: the name of the table to read (default: the first).
   */
  constructor(source, { key, password, unlockToken, now, accessState, table, priority = 'balanced', [SHARED]: from, [FIND_KEY]: candidates, [NO_BROTLI]: noBrotli = false } = {}) {
    this.#noBrotli = noBrotli;
    if (source === SHARED) {
      this.#share(from, table);
      return;
    }
    if (candidates) {
      this.#source = openSource(source);
      try {
        this[FIND_KEY] = this.#findKey(candidates);
      } finally {
        this.#source.close();
      }
      return;
    }
    checkPriority(priority);
    this.#readOptions = { unlockToken, now, accessState, table, priority };
    this.#source = openSource(source);
    try {
      this.#open(key, password);
    } catch (error) {
      this.#source.close();
      throw error;
    }
  }

  #open(key, password) {
    const { size } = this.#source;
    if (size < PREAMBLE_SIZE + TRAILER_SIZE) throw new JazminFormatError('File is too small to be JAZMIN');
    const preamble = this.#source.read(0, PREAMBLE_SIZE);
    const magic = preamble.subarray(0, 4);
    if (magic.equals(DRAFT_MAGIC)) {
      throw new JazminFormatError('This file uses a pre-release JAZMIN draft format. Write it again from its source data.');
    }
    if (!magic.equals(MAGIC)) throw new JazminFormatError('Not a JAZMIN file (bad magic)');
    const flags = preamble.readUInt16LE(4);
    if (flags & ~KNOWN_FLAGS) throw new JazminFormatError(`Unsupported file features (flags 0x${flags.toString(16)})`);
    this.#flags = flags;
    this.#fileId = Buffer.from(preamble.subarray(8, 24));
    this.#salt = Buffer.from(preamble.subarray(24, 56));
    const iterations = preamble.readUInt32LE(56);
    this.kdfIterations = iterations || undefined;
    this.encrypted = (flags & FLAG_ENCRYPTED) !== 0;

    const trailer = this.#locateTrailer(size, flags);
    this.#headerRef = trailer.header;
    const headerSection = Buffer.from(this.#source.read(trailer.header.offset, trailer.header.length));

    let raw;
    if (flags & FLAG_ACCESS) {
      raw = this.#openAccess(key, password, headerSection, trailer);
    } else {
      const parsedKey = key ? parseAnyKey(key) : null;
      if (parsedKey instanceof JazminAccessKey) throw new JazminKeyError('This file is not access-controlled - use its master key');
      if (this.encrypted) {
        if (!key && !password) throw new JazminKeyError('This file is encrypted - supply a key or password');
        if (password && !(flags & FLAG_PASSWORD)) throw new JazminKeyError('This file was encrypted with a key, not a password');
        if (password && !(iterations >= MIN_KDF_ITERATIONS && iterations <= MAX_KDF_ITERATIONS)) {
          throw new JazminFormatError(`The file asks for ${iterations} password iterations; readers accept ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
        }
        const master = password ? deriveFromPassword(password, this.#salt, iterations) : parsedKey.bytes;
        this.#keys = new KeySchedule(master, this.#salt);
      } else if (key || password) {
        throw new JazminKeyError('A key was supplied but the file is not encrypted');
      }
      this.#refuseBrotli(headerSection, 'header');
      raw = decodeSection(headerSection, { key: this.#keys?.headerKey, fileId: this.#fileId, sectionId: 'header' });
    }

    const header = decodeHeader(raw);
    for (const feature of header.readerFeatures) {
      if (!SUPPORTED_READER_FEATURES.has(feature)) throw new JazminFormatError(`This file needs the '${feature}' feature, which this JAZMIN reader does not support`);
    }
    this.#header = header;
    this.#metadata = header.metadata ? parseJsonText(header.metadata, 'Metadata', true) : {};
    if (this.#keys) this.#keys.setKeyring(header.keyring ?? {});
    this.#openTable(this.#readOptions.table);
    if (this.#access?.expires) {
      const expires = Date.parse(this.#access.expires);
      if (!Number.isFinite(expires)) throw new JazminFormatError("This key's expiry date is not valid"); // fail closed
      enforceExpiry({
        expires,
        writtenAt: header.modified || header.created,
        now: toMs(this.#readOptions.now),
        fileId: this.#fileId,
        keyId: slotId(this.#access.keySecret).toString('hex'),
        secret: this.#access.keySecret,
        state: this.#readOptions.accessState,
      });
    }
  }

  /** Opens one table (spec 6.2), chosen by name; the first by default: its columns, partitions and deleted rows. */
  #openTable(name) {
    const { tables } = this.#header;
    this.#tableIndex = name === undefined ? 0 : tables.findIndex((t) => t.name === name);
    if (this.#tableIndex < 0) {
      throw new JazminValidationError(`This file has no table '${name}' (tables: ${tables.map((t) => `'${t.name}'`).join(', ')})`);
    }
    this.#table = tables[this.#tableIndex];
    if (!this.#table) throw new JazminFormatError('Catalog: the file lists no tables');
    this.#openColumns();
    this.#openPartitions();
    if (this.#table.deletes) {
      const sectionId = `${this.#tableIndex}/deletes/${this.#table.deletedCount}`;
      this.#deleted = decodePostingsSection(this.#read(this.#table.deletes, sectionId, this.#catalogKey(sectionId, this.#access?.headerSecret)), 'Deleted rows');
    }
  }

  /** A reader of another table that shares `from`'s open file, keys and checks (see openTable). */
  #share(from, table) {
    this.#source = from.#source;
    if (from.#access) from.#access.reopen?.add(this.#reopen);
    this.#source.refs = (this.#source.refs ?? 1) + 1;
    this.#readOptions = { ...from.#readOptions, table };
    this.#header = from.#header;
    this.#headerRef = from.#headerRef;
    this.#metadata = from.#metadata;
    this.#fileId = from.#fileId;
    this.#salt = from.#salt;
    this.#keys = from.#keys;
    this.#access = from.#access;
    this.#flags = from.#flags;
    this.#noBrotli = from.#noBrotli;
    this.#validEnd = from.#validEnd;
    this.#recovered = from.#recovered;
    this.kdfIterations = from.kdfIterations;
    this.encrypted = from.encrypted;
    try {
      this.#openTable(table);
    } catch (error) {
      release(this.#source);
      throw error;
    }
  }

  /**
   * Another table of this file, read without opening the file again: the new reader shares this one's open file,
   * keys and checks (signature, key slot, expiry), so it opens in a fraction of the time. Close it too; the file is
   * closed with the last of them.
   */
  openTable(name) {
    if (this.#closed) throw new JazminValidationError('This reader is closed');
    return new JazminReader(SHARED, { table: name, [SHARED]: this });
  }

  /**
   * Finds the trailer of the latest complete version: normally the last 44 bytes. In a file that has been
   * appended to, an interrupted append leaves extra bytes at the end; the previous version is then found by
   * scanning back for a valid trailer (spec 4.2).
   */
  /** See findKey: the preamble, trailer and header section read once, then each key tried on the header alone. */
  #findKey(keys) {
    const { size } = this.#source;
    if (size < PREAMBLE_SIZE + TRAILER_SIZE) throw new JazminFormatError('File is too small to be JAZMIN');
    const preamble = this.#source.read(0, PREAMBLE_SIZE);
    if (!preamble.subarray(0, 4).equals(MAGIC)) throw new JazminFormatError('Not a JAZMIN file (bad magic)');
    const flags = preamble.readUInt16LE(4);
    if (flags & ~KNOWN_FLAGS) throw new JazminFormatError(`Unsupported file features (flags 0x${flags.toString(16)})`);
    if (!(flags & FLAG_ENCRYPTED) || flags & (FLAG_ACCESS | FLAG_PASSWORD)) return -1; // not a file a key alone opens
    const fileId = Buffer.from(preamble.subarray(8, 24));
    const salt = Buffer.from(preamble.subarray(24, 56));
    const trailer = this.#locateTrailer(size, flags);
    const headerSection = Buffer.from(this.#source.read(trailer.header.offset, trailer.header.length));
    const opensHeader = sectionKeyCheck(headerSection, { fileId, sectionId: 'header' });
    if (!opensHeader) return -1; // an encrypted file's header is encrypted: refused when opened
    // Each key's header key, the HKDF extract step and expand by HMAC (HkdfKeys gives the same keys as hkdf()).
    for (let i = 0; i < keys.length; i++) if (opensHeader(new HkdfKeys(keys[i], salt).key('JAZMIN/1/header'))) return i;
    return -1;
  }

  #locateTrailer(size, flags) {
    const parse = (t) => ({
      header: { offset: Number(t.readBigUInt64LE(0)), length: t.readUInt32LE(8) },
      keySlots: { offset: Number(t.readBigUInt64LE(12)), length: t.readUInt32LE(20) },
      signature: { offset: Number(t.readBigUInt64LE(24)), length: t.readUInt32LE(32) },
    });
    const valid = (t, at) => {
      if (!t.subarray(40, 44).equals(MAGIC) || crc32(t.subarray(0, 36)) !== t.readUInt32LE(36)) return false;
      const p = parse(t);
      const ok = (r) => r.offset >= PREAMBLE_SIZE && r.offset + r.length <= at;
      if (!ok(p.header) || (p.keySlots.length && !ok(p.keySlots)) || (p.signature.length && !ok(p.signature))) return false;
      return Math.max(p.header.offset + p.header.length, p.signature.length ? p.signature.offset + p.signature.length : 0) === at;
    };
    const last = this.#source.read(size - TRAILER_SIZE, TRAILER_SIZE);
    if (valid(last, size - TRAILER_SIZE) || !(flags & FLAG_APPENDED)) {
      if (!last.subarray(40, 44).equals(MAGIC)) throw new JazminFormatError('Missing trailer - file is truncated or incomplete');
      if (crc32(last.subarray(0, 36)) !== last.readUInt32LE(36)) throw new JazminFormatError('Trailer failed its CRC-32 check');
      if (!valid(last, size - TRAILER_SIZE)) throw new JazminFormatError('Trailer points outside the file');
      this.#validEnd = size;
      return parse(last);
    }
    const BLOCK = 1 << 20;
    for (let end = size; end > PREAMBLE_SIZE + TRAILER_SIZE; end -= BLOCK - TRAILER_SIZE) {
      const start = Math.max(PREAMBLE_SIZE, end - BLOCK);
      const block = this.#source.read(start, end - start);
      for (let i = block.lastIndexOf(MAGIC); i >= 0; i = i > 0 ? block.lastIndexOf(MAGIC, i - 1) : -1) {
        const at = start + i - 40; // trailer start
        if (at < PREAMBLE_SIZE || at + TRAILER_SIZE > size) continue;
        const candidate = this.#source.read(at, TRAILER_SIZE);
        if (valid(candidate, at)) {
          this.#validEnd = at + TRAILER_SIZE;
          this.#recovered = true;
          return parse(candidate);
        }
      }
      if (start === PREAMBLE_SIZE) break;
    }
    throw new JazminFormatError('Missing trailer - file is truncated or incomplete');
  }

  /** Verifies the owner signature, unseals this key's slot and decrypts the header (spec 7.6.6). */
  #openAccess(key, password, headerSection, trailer) {
    if (password || !key) throw new JazminKeyError('This file is access-controlled - supply an owner key or access key');
    const parsedKey = parseAnyKey(key);
    if (!trailer.keySlots.length || !trailer.signature.length) throw new JazminFormatError('Key-slot or signature section is missing');
    const slotsSection = Buffer.from(this.#source.read(trailer.keySlots.offset, trailer.keySlots.length));
    const signatureSection = this.#source.read(trailer.signature.offset, trailer.signature.length);
    const signature = decodeSection(plainSection(signatureSection, 'signature'), { key: undefined, fileId: this.#fileId, sectionId: 'signature' });
    verifyOwner(signature, this.#fileId, slotsSection, headerSection, parsedKey);
    const secret = parsedKey instanceof JazminAccessKey ? parsedKey.secret : parsedKey.bytes;
    // The signed page list gives each page's digest: read and check only the page that can hold this key's slot.
    const list = decodeSection(plainSection(slotsSection, 'keyslots'), { key: undefined, fileId: this.#fileId, sectionId: 'keyslots' });
    const page = findKeySlotPage(list, slotId(secret));
    if (!page) throw new JazminKeyError('This key has not been granted access to this file');
    const pageSection = this.#source.read(page.offset, page.length);
    if (!digest(pageSection).equals(page.digest)) throw new JazminFormatError("Key-slot page does not match the owner's signature");
    const keySlots = parseKeySlots(decodeSection(plainSection(pageSection, `keyslots/${page.index}`), { key: undefined, fileId: this.#fileId, sectionId: `keyslots/${page.index}` }));
    const { unlockToken } = this.#readOptions;
    const bundle = unsealSlot(keySlots, secret, this.#salt, this.#fileId, unlockToken ? parseUnlockToken(unlockToken) : undefined);
    if (!bundle) throw new JazminKeyError('This key has not been granted access to this file');
    const b = (s) => Buffer.from(s, 'base64');
    const isOwner = bundle.owner !== undefined;
    this.#access = {
      isOwner,
      // The owner derives every secret from its owner secret; access keys hold only theirs.
      secrets: isOwner ? new FileSecrets(this.#salt, b(bundle.header), b(bundle.owner)) : null,
      partitions: new Map(Object.entries(bundle.partitions ?? {}).map(([id, s]) => [id, b(s)])),
      partitionNames: bundle.partitionNames ?? {},
      columns: new Map(Object.entries(bundle.columns ?? {}).map(([name, s]) => [name, b(s)])),
      files: new Map(Object.entries(bundle.files ?? {}).map(([id, s]) => [id, b(s)])),
      headerSecret: b(bundle.header),
      expires: bundle.expires,
      online: bundle.online === true,
      submission: typeof bundle.submission === 'string' ? b(bundle.submission) : null,
      masks: readBundleMasks(bundle.masks),
      editLimit: bundle.edit, // what this key may send back (spec 7.9.1), as written
      keySecret: secret,
      reopen: new Set(), // readers of the file's other tables, built again when a masked column is unlocked
      directory: null,
      keySlots: { ...trailer.keySlots, section: slotsSection },
      signature: trailer.signature,
      signedBy: Buffer.from(signature.subarray(0, 65)), // the owner public key checked above, for verify()
    };
    this.#refuseBrotli(headerSection, 'header');
    return decodeSection(headerSection, { key: headerKey(b(bundle.header), this.#salt), fileId: this.#fileId, sectionId: 'header' });
  }

  /** NO_BROTLI: a Brotli section is refused before it is decompressed. */
  #refuseBrotli(section, sectionId) {
    if (this.#noBrotli && section[0] === CODEC.brotli) {
      throw new JazminFormatError(`Section '${sectionId}' is compressed with Brotli, which change files and submissions never use: `
        + 'the file was not written by JAZMIN as it should be, and is refused (CVE-2026-111497)');
    }
  }

  #partitionSecret(id) {
    return this.#access.isOwner ? this.#access.secrets.partitionSecret(id) : this.#access.partitions.get(id);
  }

  #columnSecret(name) {
    return this.#access.isOwner ? this.#access.secrets.columnSecret(name) : this.#access.columns.get(name);
  }

  /** Key of a catalog section: keyring `data` (key/password files) or `secret` (access-controlled files). */
  #catalogKey(sectionId, secret, group = KEYRING_GROUPS.data) {
    if (this.#access) return sectionKeyFrom(secret, this.#salt, sectionId);
    return this.#keys?.sectionKey(group, sectionId);
  }

  /** Column groups and definitions; restricted groups only when this key may open them (spec 7.6.5). */
  #openColumns() {
    const table = this.#table;
    // Every column is in exactly one group; a damaged count fails here instead of sizing the arrays below.
    const counted = table.columnGroups.reduce((n, g) => n + (g.definitions ? g.columnCount : g.columns.length), 0);
    if (counted !== table.columnCount || counted > this.#source.size) throw new JazminFormatError('Catalog: the column count does not match the column groups');
    this.#columns = Array.from({ length: table.columnCount }, () => ({ name: null, type: null, hidden: true }));
    this.#groupOf = new Array(table.columnCount).fill(-1);
    this.#groups = table.columnGroups.map((g, gi) => {
      let defs = g.columns;
      let visible = true;
      if (g.definitions) {
        const secret = this.#access ? this.#columnSecret(g.name) : null;
        visible = Boolean(secret);
        if (visible) {
          const sectionId = `${this.#tableIndex}/columns/${g.name}`;
          defs = decodeColumnDefinitions(this.#read(g.definitions, sectionId, sectionKeyFrom(secret, this.#salt, sectionId)));
        }
      } else if (this.#access && !this.#access.isOwner) {
        visible = this.#access.columns.has(g.name);
      }
      for (const c of visible ? defs : []) {
        if (c.position >= table.columnCount || !this.#columns[c.position].hidden) throw new JazminFormatError('Column positions are inconsistent');
        this.#columns[c.position] = publicColumn(c);
        this.#groupOf[c.position] = gi;
      }
      return { name: g.name, cols: visible ? defs.map((c) => c.position).sort((a, b) => a - b) : [], visible };
    });
    this.#types = this.#columns.map((c) => c.type);
    // What the chunk decoder needs per column: the type, or a list's or object's definition.
    this.#streamTypes = this.#columns.map((c) => (c.type === 'list' || c.type === 'object' ? c : c.type));
    this.#visibleCols = this.#columns.map((c, i) => (c.hidden ? -1 : i)).filter((i) => i >= 0);
  }

  /**
   * Partitions (spec 6.3) are listed as they are needed: a key holder looks up only its own in the partition table,
   * and the owner lists them all only for queries that do not pin the partition column. Appends' deltas are small
   * and read now. Chunk directories are read by the first query that needs them (#plan, #ensureAllChunks), so a file
   * opens as fast after many appends as after none; only an access key reads its own now, for rowCount.
   */
  #openPartitions() {
    const n = this.#table.chunkCount;
    const g = this.#groups.length;
    // Each chunk is stored as sections of at least an envelope: a damaged count cannot size these arrays.
    if (n * ENVELOPE_SIZE > this.#source.size) throw new JazminFormatError('Catalog: the chunk count is larger than the file can hold');
    this.#rowStart = new Float64Array(n);
    this.#rowCount = new Uint32Array(n);
    this.#loaded = new Uint8Array(n);
    this.#chunkPartition = new Array(n);
    this.#partOffset = new Float64Array(n * g);
    this.#partLength = new Uint32Array(n * g);
    if (this.#table.partitionTable) {
      const sectionId = `${this.#tableIndex}/partitions`;
      this.#partitionTable = this.#read(this.#table.partitionTable, sectionId, this.#catalogKey(sectionId, this.#access?.headerSecret));
    }
    this.#header.deltas.forEach((ref, i) => {
      const sectionId = `delta/${i}`;
      for (const t of decodeDelta(this.#read(ref, sectionId, this.#catalogKey(sectionId, this.#access?.headerSecret)))) {
        if (t.table !== this.#tableIndex) continue;
        for (const p of t.partitions) {
          const id = idText(p.id);
          this.#deltaSegments.set(id, [...(this.#deltaSegments.get(id) ?? []), ...p.segments]);
        }
      }
    });
    if (this.#access && !this.#access.isOwner) this.#ensureAllChunks(); // only this key's own: rowCount needs them
  }

  #newPartition(id, base) {
    const visible = !this.#access || this.#access.isOwner || (this.#access.partitions.has(id) && this.#groups.some((group) => group.visible));
    return { id, segments: [...base, ...(this.#deltaSegments.get(id) ?? [])], loaded: 0, ordinals: [], visible };
  }

  /** Lists these partitions (id texts), looking them up in the partition table without decoding the others. */
  #lookupPartitions(ids) {
    const missing = this.#allListed ? [] : ids.filter((id) => !this.#partitions.has(id));
    if (missing.length === 0) return;
    // One lookup (open, read a section) scans the table; a reader that keeps looking up partitions decodes it once.
    if (this.#partitionTable && ++this.#tableLookups > 2) {
      this.#listAllPartitions();
      return;
    }
    const base = new Map();
    const listed = this.#partitionTable
      ? findPartitions(this.#partitionTable, missing.filter((id) => id !== WHOLE_TABLE).map((id) => Buffer.from(id, 'base64url')))
      : this.#table.partitions;
    for (const p of listed) base.set(idText(p.id), p.segments);
    for (const id of missing) {
      if (base.has(id) || this.#deltaSegments.has(id)) this.#partitions.set(id, this.#newPartition(id, base.get(id) ?? []));
    }
  }

  /** Lists every partition (owner queries that do not pin the partition column). */
  #listAllPartitions() {
    if (this.#allListed) return;
    for (const p of this.#partitionTable ? decodePartitionTable(this.#partitionTable) : this.#table.partitions) {
      const id = idText(p.id);
      if (!this.#partitions.has(id)) this.#partitions.set(id, this.#newPartition(id, p.segments));
    }
    for (const id of this.#deltaSegments.keys()) if (!this.#partitions.has(id)) this.#partitions.set(id, this.#newPartition(id, []));
    this.#allListed = true;
    this.#partitionTable = null; // decoded: no longer needed
  }

  /**
   * Reads these sections' bytes ahead, in a few reads (sections close together share one), for #read to serve from
   * memory. Returns a function that releases them.
   */
  #readAhead(refs) {
    if (!this.#source.preload || refs.length < READ_AHEAD_SECTIONS) return () => {};
    const sorted = refs.map((r) => [r.offset, r.offset + r.length]).sort((a, b) => a[0] - b[0]);
    const ranges = [];
    for (const [start, end] of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && start - last.end <= READ_AHEAD_GAP && end - last.start <= READ_AHEAD_MAX) {
        last.end = Math.max(last.end, end);
        last.sections++;
      } else {
        ranges.push({ start, end, sections: 1 });
      }
    }
    const held = ranges.filter((r) => r.sections > 1).map((r) => this.#source.preload(r.start, r.end - r.start));
    if (this.#cost) for (const range of held) this.#cost.bytesRead += range.buf.length;
    this.#readAheads.push(...held);
    return () => {
      for (const range of held) this.#source.unload(range);
      this.#readAheads = this.#readAheads.filter((r) => !held.includes(r));
    };
  }

  /** Loads the chunk directories of these partitions (id texts). */
  #ensurePartitions(ids) {
    this.#lookupPartitions(ids);
    const g = this.#groups.length;
    const added = [];
    const release = this.#readAhead(ids.flatMap((id) => {
      const p = this.#partitions.get(id);
      return p && p.visible ? p.segments.slice(p.loaded) : [];
    }));
    try {
      this.#loadDirectories(ids, g, added);
    } finally {
      release();
    }
    if (added.length === 0) return;
    let count = 0;
    for (let o = 0; o < this.#loaded.length; o++) count += this.#loaded[o];
    this.#visibleChunks = new Int32Array(count);
    for (let o = 0, i = 0; o < this.#loaded.length; o++) if (this.#loaded[o]) this.#visibleChunks[i++] = o;
    this.#sortStatsComplete = undefined;
    if (this.#statCols.size) this.#loadStats(this.#statCols, added);
  }

  #loadDirectories(ids, g, added) {
    for (const id of ids) {
      const p = this.#partitions.get(id);
      if (!p || !p.visible || p.loaded === p.segments.length) continue;
      const secret = this.#access ? this.#partitionSecret(id) : null;
      for (let s = p.loaded; s < p.segments.length; s++) {
        const suffix = s ? `/${s}` : ''; // segment s > 0 was written by an append
        const sectionId = `${this.#tableIndex}/dir/${id}${suffix}`;
        const d = decodeChunkDirectoryLists(this.#read(p.segments[s], sectionId, this.#catalogKey(sectionId, secret)), g);
        for (let i = 0; i < d.ordinals.length; i++) {
          const o = d.ordinals[i];
          if (o >= this.#loaded.length || this.#loaded[o]) throw new JazminFormatError('Chunk ordinals are inconsistent');
          this.#loaded[o] = 1;
          this.#rowStart[o] = d.rowStarts[i];
          this.#rowCount[o] = d.rowCounts[i];
          this.#chunkPartition[o] = id;
          for (let k = 0; k < g; k++) {
            this.#partOffset[o * g + k] = d.offsets[i * g + k];
            this.#partLength[o * g + k] = d.lengths[i * g + k];
          }
          if (d.digests) {
            if (!this.#partDigestBlock) {
              this.#partDigestBlock = new Uint32Array(this.#loaded.length * g);
              this.#partDigestAt = new Uint32Array(this.#loaded.length * g);
            }
            if (this.#digestBlocks.at(-1) !== d.digests) this.#digestBlocks.push(d.digests);
            for (let k = 0; k < g; k++) {
              this.#partDigestBlock[o * g + k] = this.#digestBlocks.length;
              this.#partDigestAt[o * g + k] = i * g + k;
            }
          }
          if (this.#access) p.ordinals.push(o);
        }
        const segment = { partition: id, suffix, ordinals: d.ordinals, statistics: d.statistics, statsLoaded: new Set() };
        this.#segments.push(segment);
        added.push(segment);
      }
      p.loaded = p.segments.length;
    }
  }

  /** Loads every partition this reader may see (a key holder: its own). */
  #ensureAllChunks() {
    if (this.#allLoaded) return;
    if (this.#access && !this.#access.isOwner) this.#lookupPartitions([...this.#access.partitions.keys()]);
    else this.#listAllPartitions();
    this.#ensurePartitions([...this.#partitions.keys()]);
    this.#allLoaded = true;
  }

  /** A chunk part's reference ({ offset, length, digest? }). */
  #part(ordinal, group) {
    const k = ordinal * this.#groups.length + group;
    const block = this.#partDigestBlock?.[k];
    if (!block) return { offset: this.#partOffset[k], length: this.#partLength[k] };
    const at = this.#partDigestAt[k] * 32;
    return { offset: this.#partOffset[k], length: this.#partLength[k], digest: this.#digestBlocks[block - 1].subarray(at, at + 32) };
  }

  /** Where a chunk's parts are in the file: { offset, length } of the span (for reading ahead). */
  #span(ordinal) {
    const g = this.#groups.length;
    const first = ordinal * g;
    const last = first + g - 1;
    return { offset: this.#partOffset[first], length: this.#partOffset[last] + this.#partLength[last] - this.#partOffset[first] };
  }

  /** A column's statistics in a chunk ({ nulls, min, max }), or undefined when not loaded or not kept. */
  #statAt(col, ordinal) {
    const s = this.#colStats[col];
    if (!s || !s.has[ordinal]) return undefined;
    const view = s.view; // reused: callers read it before asking for another chunk's statistics of this column
    view.nulls = s.nulls[ordinal];
    view.min = s.min[ordinal];
    view.max = s.max[ordinal];
    return view;
  }

  /** A nested column's leaf's statistics in a chunk ({ count, nulls, min, max }), or undefined when not kept. */
  #leafAt(col, path, ordinal) {
    const s = this.#leafStats[col]?.get(path);
    if (!s || !s.has[ordinal]) return undefined;
    const view = s.view;
    view.count = s.counts[ordinal];
    view.nulls = s.nulls[ordinal];
    view.min = s.min[ordinal];
    view.max = s.max[ordinal];
    return view;
  }

  /** A nested column's leaf statistics for one segment (spec 6.4): each leaf named once, with an entry per chunk. */
  #loadLeafStats(col, leaves, ordinals) {
    const column = this.#columns[col];
    if (column.type !== 'list' && column.type !== 'object') throw new JazminFormatError('Statistics list fields of a column that has none');
    const n = this.#loaded.length;
    const byPath = (this.#leafStats[col] ??= new Map());
    const seen = new Set();
    for (const leaf of leaves) {
      const type = leafType(column, leaf.path);
      if (!type) throw new JazminFormatError('Statistics name a field that does not exist');
      const key = leaf.path.join(',');
      if (seen.has(key)) throw new JazminFormatError('Statistics name a field twice');
      seen.add(key);
      const count = ordinals.length;
      if (leaf.counts.length !== count || leaf.nullCounts.length !== count || leaf.min.length !== count || leaf.max.length !== count) {
        throw new JazminFormatError('Statistics do not match the chunk directory');
      }
      let s = byPath.get(key);
      if (!s) {
        s = { counts: new Float64Array(n), nulls: new Float64Array(n), min: new Array(n), max: new Array(n), has: new Uint8Array(n), view: { count: 0, nulls: 0, min: undefined, max: undefined } };
        byPath.set(key, s);
      }
      for (let i = 0; i < count; i++) {
        if (!(leaf.nullCounts[i] <= leaf.counts[i])) throw new JazminFormatError('Statistics count more nulls than values');
        const o = ordinals[i];
        s.has[o] = 1;
        s.counts[o] = Number(leaf.counts[i]);
        s.nulls[o] = Number(leaf.nullCounts[i]);
        s.min[o] = decodeBound(type, leaf.min[i]);
        s.max[o] = decodeBound(type, leaf.max[i]);
      }
    }
  }

  /** How many of these row ids (ascending) appends have deleted. */
  #deletedAmong(rowIds) {
    let n = 0;
    for (let i = 0, d = 0; i < rowIds.length && d < this.#deleted.length; i++) {
      while (d < this.#deleted.length && this.#deleted[d] < rowIds[i]) d++;
      if (this.#deleted[d] === rowIds[i]) n++;
    }
    return n;
  }

  /** Rows of a chunk that appends have not deleted. */
  #liveRows(ordinal) {
    const count = this.#rowCount[ordinal];
    if (this.#deleted.length === 0) return count;
    const start = this.#rowStart[ordinal];
    return count - (lowerBound(this.#deleted, start + count) - lowerBound(this.#deleted, start));
  }

  /**
   * A test for chunks every row of which matches the filter: proven by chunk statistics or, in access-controlled
   * files, by the partition the filter pins. An offset skips such chunks by their row count, without reading them.
   */
  #wholeChunkTest(plan) {
    if (!plan) return () => true;
    const partitionCol = this.#access ? this.#partitionCol() : -1;
    const pinned = partitionCol >= 0 ? pinnedPartitionStats(plan, partitionCol) : undefined;
    return (ordinal) => {
      const rowCount = this.#rowCount[ordinal];
      return mustMatch(plan, (col) => (pinned && col === partitionCol ? pinned(rowCount) : this.#statAt(col, ordinal)), rowCount);
    };
  }

  #mayMatch(plan, ordinal) {
    this.#statOrdinal = ordinal;
    return mayMatch(plan, this.#statLookup, this.#rowCount[ordinal], this.#leafLookup);
  }

  /** Loads the statistics of these columns for every loaded segment (spec 6.4), one array set per column. */
  #ensureStats(cols) {
    const missing = new Set([...cols].filter((c) => c >= 0 && !this.#statCols.has(c)));
    if (missing.size === 0) return; // segments loaded later get these columns' statistics as they load
    for (const col of missing) this.#statCols.add(col);
    this.#loadStats(missing, this.#segments);
  }

  #loadStats(cols, segments) {
    const wanted = (block) => block.columns.some((c) => cols.has(c));
    const release = this.#readAhead(segments.flatMap((segment) => segment.statistics.filter((block, b) => !segment.statsLoaded.has(b) && wanted(block)).map((block) => block.section)));
    try {
      this.#loadStatsOf(cols, segments);
    } finally {
      release();
    }
    this.#sortStatsComplete = undefined; // the leading sort column's statistics may be complete now
  }

  #loadStatsOf(cols, segments) {
    const n = this.#loaded.length;
    for (const segment of segments) {
      segment.statistics.forEach((block, b) => {
        if (segment.statsLoaded.has(b) || !block.columns.some((c) => cols.has(c))) return;
        segment.statsLoaded.add(b);
        if (block.columns.some((c) => !(c >= 0 && c < this.#columns.length))) throw new JazminFormatError('Statistics block lists unknown columns');
        const group = this.#groupOf[block.columns[0]];
        if (group < 0) return; // a column group this key cannot see
        const sectionId = `${this.#tableIndex}/stats/${segment.partition}/${b}${segment.suffix}`;
        const key = this.#access
          ? partKey(this.#partitionSecret(segment.partition), this.#columnSecret(this.#groups[group].name), this.#salt, sectionId)
          : this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId);
        const entries = decodeStatistics(this.#read(block.section, sectionId, key));
        if (entries.length !== block.columns.length) throw new JazminFormatError('Statistics block does not match its columns');
        block.columns.forEach((col, k) => {
          const e = entries[k];
          const count = segment.ordinals.length;
          if (e.nullCounts.length !== count || e.min.length !== count || e.max.length !== count) throw new JazminFormatError('Statistics do not match the chunk directory');
          const type = this.#types[col];
          const s = (this.#colStats[col] ??= {
            nulls: new Float64Array(n), min: new Array(n), max: new Array(n), has: new Uint8Array(n), view: { nulls: 0, min: undefined, max: undefined },
          });
          for (let i = 0; i < count; i++) {
            const o = segment.ordinals[i];
            s.has[o] = 1;
            s.nulls[o] = e.nullCounts[i];
            s.min[o] = decodeBound(type, e.min[i]);
            s.max[o] = decodeBound(type, e.max[i]);
          }
          if (e.leaves.length) this.#loadLeafStats(col, e.leaves, segment.ordinals);
        });
      });
    }
  }

  /** Owner only: partition names and grants, loaded on first use (clients never read it). */
  #ownerDirectory() {
    if (!this.#access.directory) {
      const ref = this.#header.access.ownerDirectory;
      const raw = this.#read(ref, 'owner', ownerDirectoryKey(this.#access.secrets.owner, this.#salt));
      this.#access.directoryText = raw.toString('utf8');
      this.#access.directory = parseJsonText(this.#access.directoryText, 'The owner directory', true);
    }
    return this.#access.directory;
  }

  get columns() {
    return this.#visibleCols.map((i) => ({ ...this.#columns[i] }));
  }

  get metadata() {
    return structuredClone(this.#metadata);
  }

  /** The links the file declares between its tables (metadata `jazmin.links`): [{ name, from, to }]. */
  get links() {
    return readLinks(this.#metadata);
  }

  /**
   * Each declared link checked against the rows this key sees: rows whose link finds nothing, and target keys that
   * repeat (see links.js checkLinks). Reads only the link columns.
   */
  checkLinks(options = {}) {
    if (this.#closed) throw new JazminValidationError('This reader is closed');
    return checkLinks(this, options);
  }

  /** Rows visible to this reader (excluding deleted rows, and rows an access key may not see). */
  get rowCount() {
    let n = this.#table.rowCount;
    if (this.#access && !this.#access.isOwner) {
      n = 0;
      for (const ordinal of this.#visibleChunks) n += this.#rowCount[ordinal];
    }
    return n - this.deletedRowCount;
  }

  /** Live rows in the file that this key may not see. */
  get hiddenRowCount() {
    return this.#table.rowCount - this.#deleted.length - this.rowCount;
  }

  /** Rows deleted by appends and not yet removed by compaction (only those visible to this key). */
  get deletedRowCount() {
    if (!this.#access || this.#access.isOwner) return this.#deleted.length;
    this.#deletedVisible ??= this.#deleted.filter((id) => this.#isVisibleChunk(this.#chunkOrdinalFor(id))).length;
    return this.#deletedVisible;
  }

  /** Number of appends since the file was last written in full (compaction resets it to 0). */
  /**
   * The submission key (spec 7.8): the key of the files this access key's holder sends back to the owner, such as
   * records captured offline. Only an access key that opened this file has it (with its unlock token, for an online
   * grant); the owner derives anyone's with ownerKey.submissionKey(keyId). Null for the owner, and for files written
   * before submission keys existed, until the owner's next rewrite or compaction adds them.
   */
  get submissionKey() {
    const bytes = this.#access?.submission;
    return bytes ? new JazminKey(bytes) : null;
  }

  get appendCount() {
    return this.#header.appendCount;
  }

  /** The file's id (hex), as inspect() gives it. A rewrite (update, compact) gives the file a new one. */
  get fileId() {
    return this.#fileId.toString('hex');
  }

  /**
   * When the file was last written: its last append or, without one, when it was created. It comes from the writer's
   * clock, so it is what the writer claims, not when the file reached you.
   */
  get writtenAt() {
    return new Date(this.#header.modified || this.#header.created);
  }

  /**
   * The reader features the file needs (spec 3.2), such as 'index-deltas' (compact indexes) or 'nested-columns': a reader
   * that doesn't know one refuses the file. Empty for files every 1.x release reads.
   */
  get readerFeatures() {
    return [...this.#header.readerFeatures];
  }

  /**
   * The writer features of the file (spec 12), such as 'file-locks': a library that doesn't know one refuses to modify
   * the file (append, update, compact), and still reads it.
   */
  get writerFeatures() {
    return [...this.#header.writerFeatures];
  }

  /** True when the end of the file held an interrupted append, and the previous version was used. */
  get recovered() {
    return this.#recovered;
  }

  get chunkCount() {
    return this.#table.chunkCount;
  }

  /** Columns the writer declared the rows to be ordered by (undefined if none). */
  get sortedBy() {
    return this.#table.sortedBy.length ? [...this.#table.sortedBy] : undefined;
  }

  /**
   * The table's whole order when a key compares text another way (spec 6.7): [{ column, nocase?, natural? }], else
   * undefined (the order is sortedBy's). sortedBy keeps its leading plain keys: those every reader can rely on.
   */
  get sort() {
    return this.#table.sort?.length ? this.#table.sort.map((k) => ({ ...k })) : undefined;
  }

  /** Index refs this reader may use: the table's, or (access-controlled files, owner only) the owner catalog's. */
  #indexList() {
    if (this.#indexRefs) return this.#indexRefs;
    if (!this.#access) this.#indexRefs = this.#table.indexes;
    else if (!this.#access.isOwner) this.#indexRefs = [];
    else this.#indexRefs = this.#ownerCatalog().find((t) => t.table === this.#tableIndex)?.indexes ?? [];
    return this.#indexRefs;
  }

  /** Owner only: the indexes of every table (spec 7.6.5). */
  #ownerCatalog() {
    if (!this.#access.catalog) {
      const sectionId = 'owner/catalog';
      this.#access.catalog = decodeOwnerCatalog(this.#read(this.#header.access.ownerCatalog, sectionId, sectionKeyFrom(this.#access.secrets.owner, this.#salt, sectionId)));
    }
    return this.#access.catalog;
  }

  /**
   * Owner: this table's chunk map (spec 7.6.5) as { rowStarts, rowCounts, partitionOf, partitions }, or null when the
   * file has none or it does not cover the table's chunks. It only says where to look: the chunk directories, read
   * after it, are checked against it.
   */
  #chunkMap() {
    if (this.#map !== undefined) return this.#map;
    this.#map = null;
    const parts = this.#chunkMapParts();
    const map = parts && (parts.appended ? joinChunkMaps(parts.base, parts.appended) : parts.base);
    const n = this.#table.chunkCount;
    if (!map || map.rowCounts.length !== n || map.partitionOf.length !== n || map.partitionOf.some((p) => p >= map.partitions.length)) return null;
    const rowStarts = new Float64Array(n);
    let total = 0;
    for (let o = 0; o < n; o++) {
      rowStarts[o] = total;
      total += map.rowCounts[o];
    }
    if (total !== this.#table.rowCount) return null;
    this.#map = { rowStarts, rowCounts: map.rowCounts, partitionOf: map.partitionOf, partitions: map.partitions };
    return this.#map;
  }

  /**
   * Owner: this table's chunk map sections (spec 7.6.5), read: { base, baseRef, appended }, or null when it has none.
   */
  #chunkMapParts() {
    const entry = this.#ownerCatalog().find((t) => t.table === this.#tableIndex);
    if (!entry?.chunkMap) return null;
    const read = (ref, sectionId) => decodeChunkMap(this.#read(ref, sectionId, sectionKeyFrom(this.#access.secrets.owner, this.#salt, sectionId)));
    const base = read(entry.chunkMap, `${this.#tableIndex}/chunkmap`);
    // The appended chunks' section is named after the append that wrote it.
    const appended = entry.chunkMapAppended ? read(entry.chunkMapAppended, `${this.#tableIndex}/chunkmap/${entry.chunkMapSegment}`) : null;
    return { base, baseRef: entry.chunkMap, appended };
  }

  /** Owner, appending: the chunk map so far ({ base: ref, appended, chunks }), or null when the file has none. */
  #chunkMapState() {
    const parts = this.#chunkMapParts();
    if (!parts) return null;
    return { base: parts.baseRef, appended: parts.appended, chunks: parts.base.rowCounts.length + (parts.appended?.rowCounts.length ?? 0) };
  }

  /**
   * Owner: loads only the partitions the chunk map puts these rows in, and checks their chunk directories agree with
   * it. False when there is no map or a row is not in it, or the directories disagree: the caller then loads every
   * partition.
   */
  #loadPartitionsOf(rowIds) {
    const map = this.#chunkMap();
    if (!map) return false;
    const ordinals = new Set();
    for (const rowId of rowIds) {
      let lo = 0;
      let hi = map.rowStarts.length - 1;
      if (hi < 0) return false;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (map.rowStarts[mid] <= rowId) lo = mid;
        else hi = mid - 1;
      }
      if (!(rowId >= map.rowStarts[lo] && rowId < map.rowStarts[lo] + map.rowCounts[lo])) return false;
      ordinals.add(lo);
    }
    this.#ensurePartitions([...new Set([...ordinals].map((o) => map.partitions[map.partitionOf[o]]))]);
    for (const o of ordinals) {
      if (!this.#loaded[o] || this.#rowStart[o] !== map.rowStarts[o] || this.#rowCount[o] !== map.rowCounts[o]) return false;
    }
    return true;
  }

  /** Names of the file's tables, in order (spec 6.2). */
  get tables() {
    return this.#header.tables.map((t) => t.name);
  }

  /** Name of the table this reader reads. */
  get table() {
    return this.#table.name;
  }

  get [READ_PRIORITY]() {
    return this.#readOptions.priority ?? 'balanced';
  }

  /** Index descriptors usable by this reader: [{ column, kind }]. */
  get indexes() {
    const seen = new Set(); // an appended file has one index segment per append for the same column and kind
    return this.#indexList()
      .map(({ column, kind }) => ({ column, kind }))
      .filter(({ column, kind }) => !seen.has(`${column}/${kind}`) && seen.add(`${column}/${kind}`));
  }

  /**
   * Access-control details, or null for ordinary files:
   *   { isOwner, partitionBy, columnGroups, visiblePartitions, visibleColumnGroups, grants?, groupColumns? }
   * `grants` (owner only) lists who can see what, without any secrets; `groupColumns` (owner only) names the columns
   * of each column group.
   */
  get access() {
    if (!this.#access) return null;
    const { isOwner } = this.#access;
    const columnGroups = this.#groups.map((g) => g.name);
    const info = {
      isOwner,
      partitionBy: this.#table.partitionBy || null,
      columnGroups,
      visiblePartitions: isOwner ? this.#ownerDirectory().partitions : Object.values(this.#access.partitionNames),
      visibleColumnGroups: isOwner ? columnGroups : this.#groups.filter((g) => g.visible).map((g) => g.name),
    };
    if (!isOwner) {
      info.keyId = slotId(this.#access.keySecret).toString('hex'); // the access key's id, as the owner's grants list it
      info.online = this.#access.online;
      if (this.#access.expires) info.expires = this.#access.expires;
      const { edit, lost } = readEditLimit(this.#access.editLimit, this.#limitsFile());
      if (edit) info.edit = edit; // what this key may send back (spec 7.9.1)
      if (lost) info.editLost = true;
    }
    if (isOwner) {
      // Built once per reader (the owner directory doesn't change while it is open), and handed out as new objects.
      this.#grantInfos ??= this.#ownerDirectory().grants.map((g) => ({
        keyId: this.#grantKey(g.key).id, rows: g.rows, columns: grantColumns(g), ...(g.label === undefined ? {} : { label: g.label }),
        mode: g.mode ?? 'offline',
        ...(g.expires ? { expires: g.expires } : {}),
        ...(g.files === undefined ? {} : { files: g.files }), // extra file groups: re-granting without them removes them
        ...this.#grantEditInfo(g.edit),
      }));
      info.grants = this.#grantInfos.map((g) => ({ ...g }));
      info.groupColumns = Object.fromEntries(this.#groups.map((g) => [g.name, g.cols.map((i) => this.#columns[i].name)]));
    }
    return info;
  }

  // ---- embedded files (spec 6.8) ---------------------------------------------------------------

  /** Loads the file directories this key can open, merged by path (once). */
  #files() {
    if (this.#fileIndex) return this.#fileIndex;
    // locks: id -> { id, kind, salt, iterations, keys: Map(content id -> sealed key) }; contentKeys: id -> K, once opened.
    const index = { entries: new Map(), contents: new Map(), shapes: new Map(), locks: new Map(), contentKeys: new Map() };
    const member = this.#header.files;
    if (member) {
      const suffix = member.segment ? `/${member.segment}` : '';
      const ownerNames = this.#access?.isOwner
        ? new Map((this.#ownerDirectory().fileGroups ?? []).map((name) => [this.#access.secrets.partitionId(name), name]))
        : null;
      for (const dir of member.directories) {
        let sectionId;
        let key;
        if (!this.#access) {
          sectionId = `files/dir${suffix}`;
          key = this.#keys?.sectionKey(KEYRING_GROUPS.files, sectionId);
        } else {
          const secret = this.#access.isOwner ? this.#access.secrets.fileGroupSecret(dir.group) : this.#access.files.get(dir.group);
          if (!secret) continue; // a group this key does not see
          sectionId = `files/dir/${dir.group}${suffix}`;
          key = hkdf(secret, this.#salt, `JAZMIN/1/${sectionId}`);
        }
        const directory = checkFileDirectory(parseJsonText(this.#read(dir.section, sectionId, key).toString('utf8'), 'An embedded-file directory', true));
        for (const c of directory.contents) index.contents.set(c.id, c);
        for (const l of directory.locks ?? []) {
          if (!index.locks.has(l.id)) {
            index.locks.set(l.id, {
              id: l.id, kind: l.kind, salt: Buffer.from(l.salt, 'base64'), iterations: l.iterations, keys: new Map(), keyService: keyServiceAddress(l.keyService),
            });
          }
          const lock = index.locks.get(l.id);
          for (const [id, sealed] of Object.entries(l.keys)) if (!lock.keys.has(id)) lock.keys.set(id, sealed);
        }
        for (const f of directory.files) {
          const known = index.entries.get(f.path);
          const groups = f.groups ?? (ownerNames ? [ownerNames.get(dir.group)] : undefined);
          const actions = readActions(f.actions);
          const page = this.#access ? readPage(f.page) : undefined; // a group's page (spec 6.8)
          // The owner keeps each group's actions, so rewrites and appends write them back as they were.
          const own = ownerNames ? { [ownerNames.get(dir.group)]: actions ?? {} } : null;
          if (known) {
            if (known.groups && groups) known.groups = [...new Set([...known.groups, ...groups])].sort();
            // Seen through several groups: an action is allowed when any of them allows it.
            const merged = mergeActions(known.actions, actions);
            if (merged) known.actions = merged;
            else delete known.actions;
            if (own) known.groupActions = { ...known.groupActions, ...own };
            if (page && !known.page) known.page = page;
          } else {
            index.entries.set(f.path, {
              path: f.path, type: f.type, content: f.content, ...(groups ? { groups } : {}), ...(actions ? { actions } : {}), ...(own ? { groupActions: own } : {}),
              ...(page ? { page } : {}),
            });
          }
        }
        for (const s of directoryShapes(directory)) {
          const known = index.shapes.get(s.name);
          const groups = s.groups ?? (ownerNames ? [ownerNames.get(dir.group)] : undefined);
          if (known) {
            if (known.groups && groups) known.groups = [...new Set([...known.groups, ...groups])].sort();
          } else {
            index.shapes.set(s.name, {
              name: s.name, ...(s.description ? { description: s.description } : {}), ...(s.default ? { default: true } : {}),
              ...(s.table === undefined ? {} : { table: s.table }), ...(groups ? { groups } : {}), shape: s.shape,
            });
          }
        }
      }
      for (const e of index.entries.values()) {
        if (!index.contents.has(e.content)) throw new JazminFormatError(`Embedded file '${e.path}' refers to missing content`);
        if (e.groups?.includes(EVERYONE)) e.groups = [EVERYONE];
      }
      for (const s of index.shapes.values()) if (s.groups?.includes(EVERYONE)) s.groups = [EVERYONE];
    }
    // The key service of the file's online locks that don't name their own (spec 6.8.2).
    index.keyService = member?.package ? keyServiceAddress(parseJsonText(member.package, 'Package settings', true)?.keyService) : undefined;
    this.#fileIndex = index;
    return index;
  }

  /**
   * Embedded files this key can see: [{ path, type, size, sha256, groups?, actions? }] (groups for the owner / single-key
   * files; actions, what viewers may do with the file, when its writer set them).
   */
  get files() {
    const { entries, contents } = this.#files();
    return [...entries.values()].map((e) => {
      const c = contents.get(e.content);
      return {
        path: e.path, type: e.type, size: c.size, sha256: c.sha256, ...(e.groups ? { groups: [...e.groups] } : {}),
        ...(e.actions ? { actions: structuredClone(e.actions) } : {}),
        ...(c.lock !== undefined ? { lock: this.#lockInfo(c.lock) } : {}),
        ...(e.page ? { page: structuredClone(e.page) } : {}), // a page of the document only some keys know of (spec 6.8)
        // The owner sees each group's actions when they differ (actions above: what any of them allows).
        ...(e.groupActions && new Set(Object.values(e.groupActions).map((a) => JSON.stringify(a))).size > 1 ? { groupActions: structuredClone(e.groupActions) } : {}),
      };
    });
  }

  /**
   * Saved export shapes this key can use: [{ name, description?, default?, table?, shape, groups? }] (groups for the
   * owner and single-key files). Shapes that use a column this key can't see are left out. Use one by name:
   * toJSON(reader, { shape: name }).
   */
  get shapes() {
    if (!this.#shapeList) {
      const tables = new Map([[this.table, this.columns]]);
      const columnsOf = (name) => {
        if (!tables.has(name)) {
          if (!this.tables.includes(name)) return undefined;
          const table = this.openTable(name);
          try {
            tables.set(name, table.columns);
          } finally {
            table.close();
          }
        }
        return tables.get(name);
      };
      this.#shapeList = [...this.#files().shapes.values()].filter((s) => shapeFits(s, this.tables[0], columnsOf))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    return structuredClone(this.#shapeList);
  }

  /**
   * Package settings for viewers ({ entry, title, allowedOrigins, allowWasm, edit, ... }), or undefined. A file whose
   * grants limit what keys send back stores the document's edit settings as editByKey (spec 7.9.1): given here as edit.
   */
  get package() {
    const settings = this.#rawPackage();
    if (!settings || settings.editByKey === undefined) return settings;
    const { editByKey, ...rest } = settings;
    return rest.edit === undefined ? { ...rest, edit: editByKey } : rest;
  }

  #rawPackage() {
    const settings = this.#header.files?.package;
    return settings ? parseJsonText(settings, 'Package settings', true) : undefined;
  }

  /** Whether the file's grants limit what keys send back (spec 7.9.1): its writer feature, or editByKey. Worked out once. */
  #limitsFile() {
    this.#hasLimits ??= this.#header.writerFeatures.includes(EDIT_LIMITS) || this.#rawPackage()?.editByKey !== undefined;
    return this.#hasLimits;
  }

  /** A grant's limit as the owner's grants list gives it: edit, editLost, editUnreadable. */
  #grantEditInfo(stored) {
    const { edit, lost, unreadable } = readEditLimit(stored, this.#limitsFile());
    return { ...(edit ? { edit } : {}), ...(lost ? { editLost: true } : {}), ...(unreadable ? { editUnreadable: true } : {}) };
  }

  /**
   * What this key may send back through the document now (spec 7.9.1): the document's edit settings narrowed by the
   * key's limit and the columns it sees, { table?, key, columns, add, delete }; null when the document takes no changes.
   * A key whose limit was lost may send nothing.
   */
  get edit() {
    const stored = this.package?.edit;
    if (!stored) return null;
    let doc;
    try {
      doc = normalizeEdit(stored);
    } catch {
      return null; // settings this library can't read: the document takes no changes
    }
    if (!this.#access || this.#access.isOwner) return doc;
    const limit = readEditLimit(this.#access.editLimit, this.#limitsFile());
    const name = doc.table ?? this.tables[0];
    const table = name === this.table ? this : this.openTable(name);
    try {
      return effectiveEdit(doc, limit.edit, new Set(table.columns.map((c) => c.name)), limit.lost);
    } finally {
      if (table !== this) table.close();
    }
  }

  /**
   * Locks of the stored files this key can see (spec 6.8.1): [{ id, kind, unlocked }], kind 'password', 'online' or
   * 'both'. unlock() opens one; the owner key opens every lock.
   */
  get locks() {
    // The owner sees every lock of the file: also those only masked columns use (spec 7.6.8).
    const ids = new Set([...this.#files().locks.keys(), ...(this.#access?.masks?.locks.keys() ?? []), ...(this.#access?.isOwner ? this.#ownerLocks().keys() : [])]);
    return [...ids].sort().map((id) => this.#lockInfo(id));
  }

  /** A lock, from the file directories (stored files) or the key slot's masked columns (spec 7.6.8). */
  #lockRecord(id) {
    return this.#files().locks.get(id) ?? this.#access?.masks?.locks.get(id);
  }

  /**
   * Masked columns of this table (spec 7.6.8): [{ column, type, group, lock: { id, kind, unlocked, keyService? },
   * shown?, unmasked?, at }]. Until its lock is unlocked a masked column isn't in `columns`: rows don't have it. `shown`
   * names the column with what its values show; `unmasked`, the column with its values in the rows that aren't masked;
   * `at`, where the column is (or will be, once unlocked) in `columns`, for viewers that show it in its place.
   */
  get masked() {
    if (!this.#access) return [];
    const at = (position) => this.#visibleCols.filter((i) => i < position).length;
    const extra = (c) => ({ ...(c.shown ? { shown: c.shown } : {}), ...(c.unmasked ? { unmasked: c.unmasked } : {}), at: at(c.position) });
    if (this.#access.isOwner) {
      return (this.#ownerDirectory().masks ?? []).filter((m) => m.table === this.#tableIndex).sort((a, b) => a.position - b.position)
        .map((m) => ({
          column: m.column, type: m.type, group: m.group, lock: this.#lockInfo(m.lock), ...extra(m),
          // The owner also sees how it is masked, to change it (update({ masks })).
          show: structuredClone(m.show ?? 'none'), ...(m.rows !== undefined ? { rows: structuredClone(m.rows) } : {}),
        }));
    }
    return [...this.#access.masks.groups].filter(([, e]) => e.column.table === this.#tableIndex).sort(([, a], [, b]) => a.column.position - b.column.position)
      .map(([group, e]) => ({ column: e.column.name, type: e.column.type, group, lock: this.#lockInfo(e.lock), ...extra(e.column) }));
  }

  /** Builds the columns again (a masked column unlocked): every reader of the file's tables. */
  #reopen = () => {
    this.#openColumns();
    this.#makers.clear();
    this.#cachedChunk = { ordinal: -1, wanted: null, types: null, chunk: null };
    this.#shapeList = null;
  };

  #lockInfo(id) {
    const index = this.#files();
    const lock = this.#lockRecord(id) ?? (this.#access?.isOwner ? this.#ownerLocks().get(id) : undefined);
    // Where an online lock's unlock token comes from (spec 6.8.2): the lock's own key service, else the file's.
    const keyService = lock && lock.kind !== 'password' ? lock.keyService ?? index.keyService : undefined;
    return { id, ...(lock ? { kind: lock.kind } : {}), unlocked: this.#lockKeyOf(id) !== undefined, ...(keyService ? { keyService } : {}) };
  }

  /** The key of a lock this reader has opened (or, for the owner, the owner directory's), else undefined. */
  #lockKeyOf(id) {
    if (!this.#access) return undefined;
    if (this.#access.isOwner) return this.#ownerLocks().get(id)?.key;
    return this.#access.unlocked?.get(id);
  }

  #ownerLocks() {
    this.#access.ownerLocks ??= readOwnerLocks(this.#ownerDirectory().locks);
    return this.#access.ownerLocks;
  }

  /** Internal: the owner directory's masked columns (owner key only), else null. */
  get [OWNER_MASKS]() {
    return this.#access?.isOwner ? structuredClone(this.#ownerDirectory().masks ?? []) : null;
  }

  /** Internal: the owner directory's locks (owner key only), else null. */
  get [OWNER_LOCKS]() {
    return this.#access?.isOwner ? this.#ownerLocks() : null;
  }

  /**
   * Opens a lock of the stored files (spec 6.8.1) for as long as the file is open (with every table of this reader):
   * { password } for a password lock, { unlockToken } (jzf1-..., from the file owner's key service) for an online one,
   * both for one of both kinds. Throws JazminKeyError when they are wrong.
   */
  unlock(id, { password, unlockToken } = {}) {
    const lock = this.#lockRecord(id);
    if (!lock) throw new JazminValidationError(`No lock '${id}' is visible with this key`);
    if ((lock.kind !== 'online' && password === undefined) || (lock.kind !== 'password' && unlockToken === undefined)) {
      throw new JazminValidationError(`Lock '${id}' needs ${lockNeeds(lock.kind)}`);
    }
    if (this.#lockKeyOf(id)) return;
    checkLockIterations(lock);
    const secret = lock.kind === 'password' ? undefined : parseFileUnlockToken(unlockToken);
    const key = lockKey(lock, { password, secret });
    // Checked by opening what it seals: a stored file's key, or a masked column group's secret (spec 7.6.8).
    const masked = [...(this.#access.masks?.groups ?? [])].filter(([, e]) => e.lock === id);
    const [contentId, sealed] = lock.keys?.entries().next().value ?? [];
    if (sealed === undefined && !masked.length) throw new JazminFormatError(`Lock '${id}' has no sealed keys`);
    const opened = new Map();
    try {
      if (sealed !== undefined) openContentKey(key, id, contentId, Buffer.from(sealed, 'base64'));
      for (const [group, e] of masked) opened.set(group, openGroupSecret(key, id, group, Buffer.from(e.sealed, 'base64')));
    } catch {
      const what = lock.kind === 'password' ? 'password' : lock.kind === 'online' ? 'unlock token' : 'password or unlock token';
      throw new JazminKeyError(`Wrong ${what} for lock '${id}'`);
    }
    (this.#access.unlocked ??= new Map()).set(id, key);
    if (opened.size) {
      // The masked columns become columns the key sees, in every reader of the file's tables.
      for (const [group, groupSecret] of opened) this.#access.columns.set(group, groupSecret);
      this.#reopen();
      for (const reopen of this.#access.reopen ?? []) reopen();
    }
  }

  #fileContent(path) {
    const { entries, contents } = this.#files();
    const entry = entries.get(path);
    if (!entry) throw new JazminValidationError(`No file '${path}' is visible with this key`);
    return contents.get(entry.content);
  }

  /** A stored content's key K: from its directory, or (locked) unsealed with its lock's key; throws while locked. */
  #contentKey(content, path) {
    if (content.lock === undefined) {
      if (!content.key && (this.#keys || this.#access)) throw new JazminFormatError(`Embedded content ${content.id} has no key in an encrypted file`);
      return content.key ? Buffer.from(content.key, 'base64') : undefined;
    }
    const index = this.#files();
    const known = index.contentKeys.get(content.id);
    if (known) return known;
    const lock = index.locks.get(content.lock);
    if (!lock) {
      // Libraries before 1.7 don't check writer features: one that appended to the file wrote it without its locks.
      throw new JazminFormatError(`File '${path}' names lock '${content.lock}', which the file no longer has: its key is lost `
        + '(a JAZMIN library older than 1.7 may have appended to the file)');
    }
    const key = this.#lockKeyOf(content.lock);
    if (!key) {
      throw new JazminFileLockedError(`File '${path}' is locked (lock '${content.lock}'): unlock it with ${lockNeeds(lock.kind)}`,
        { path, lock: content.lock, kind: lock.kind });
    }
    const sealed = lock.keys.get(String(content.id));
    if (sealed === undefined) throw new JazminFormatError(`Embedded content ${content.id} has no key for lock '${content.lock}'`);
    const contentKey = openContentKey(key, content.lock, content.id, Buffer.from(sealed, 'base64'));
    index.contentKeys.set(content.id, contentKey);
    return contentKey;
  }

  #fileBlock(content, b, contentKey) {
    const block = content.blocks[b];
    const sectionId = `file/${content.id}/${b}`;
    const key = contentKey ? hkdf(contentKey, this.#salt, `JAZMIN/1/${sectionId}`) : undefined;
    const bytes = this.#read(block, sectionId, key);
    if (bytes.length !== Math.min(content.blockSize, content.size - b * content.blockSize)) {
      throw new JazminFormatError(`Section '${sectionId}' has the wrong length for its embedded file`);
    }
    return bytes;
  }

  /** Reads a whole embedded file (checked against its SHA-256). */
  readFile(path) {
    const content = this.#fileContent(path);
    const key = this.#contentKey(content, path);
    const bytes = Buffer.concat(content.blocks.map((_, b) => this.#fileBlock(content, b, key)));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== content.sha256) {
      throw new JazminFormatError(`File '${path}' does not match its SHA-256`);
    }
    return bytes;
  }

  /** Reads bytes [start, end) of an embedded file, decoding only the blocks involved. */
  readFileRange(path, start = 0, end) {
    const content = this.#fileContent(path);
    const key = this.#contentKey(content, path);
    const stop = Math.min(end ?? content.size, content.size);
    if (!Number.isInteger(start) || start < 0 || start > stop) throw new JazminValidationError('Invalid file range');
    const size = content.blockSize;
    const parts = [];
    for (let b = Math.floor(start / size); b * size < stop; b++) {
      const block = this.#fileBlock(content, b, key);
      parts.push(block.subarray(Math.max(0, start - b * size), Math.min(block.length, stop - b * size)));
    }
    return Buffer.concat(parts);
  }

  /** Streams an embedded file block by block (bounded memory); the stream errors if the SHA-256 does not match. */
  openFile(path) {
    const content = this.#fileContent(path);
    const key = this.#contentKey(content, path);
    const read = (b) => this.#fileBlock(content, b, key);
    return Readable.from((function* blocks() {
      const hash = crypto.createHash('sha256');
      for (let b = 0; b < content.blocks.length; b++) {
        const block = read(b);
        hash.update(block);
        yield block;
      }
      if (hash.digest('hex') !== content.sha256) throw new JazminFormatError(`File '${path}' does not match its SHA-256`);
    })(), { objectMode: false });
  }

  /** Internal: what update/append need to carry the files over (owner / single key only). */
  get [FILE_STATE]() {
    if (!this.#header.files) return null;
    const { entries, contents } = this.#files();
    const owner = this.#access?.isOwner;
    // The owner's locked contents with their keys, which the writer seals again (spec 6.8.1). One whose lock is lost
    // keeps none: an append refuses it, a rewrite can remove it.
    const opens = (c) => owner && c.lock !== undefined && this.#files().locks.has(c.lock) && this.#ownerLocks().has(c.lock);
    let paths;
    const pathOf = (id) => (paths ??= new Map([...entries.values()].map((e) => [e.content, e.path]))).get(id);
    return {
      entries: [...entries.values()].map((e) => ({ ...e, groups: e.groups ?? [EVERYONE] })),
      contents: [...contents.values()].map((c) => (opens(c) ? { ...c, key: this.#contentKey(c, pathOf(c.id)).toString('base64') } : c)),
      locks: owner ? [...this.#ownerLocks().values()] : [],
      nextId: this.#header.files.nextContent,
      package: this.package,
      shapes: [...this.#files().shapes.values()].map((s) => ({ ...s, groups: s.groups ?? [EVERYONE] })),
    };
  }

  /** Owner only: grants including access keys, used by update() to re-issue them. */
  get [OWNER_GRANTS]() {
    if (!this.#access?.isOwner) return null;
    const columnGroups = Object.fromEntries(this.#groups.map((g) => [g.name, g.cols.map((i) => this.#columns[i].name)]));
    // Each grant with its key parsed (accessKey: its id is worked out when first asked for), so callers need not parse
    // every key again.
    const limitsFile = this.#limitsFile();
    const grants = this.#ownerDirectory().grants.map(({ maskedColumns, allColumns, edit: stored, ...g }) => {
      const { edit, lost } = readEditLimit(stored, limitsFile);
      return {
        ...g, columns: grantColumns({ ...g, maskedColumns, allColumns }), accessKey: this.#grantKey(g.key),
        ...(edit ? { edit } : {}), ...(lost ? { editLost: true } : {}),
      };
    });
    return { partitionBy: this.#table.partitionBy || undefined, columnGroups, grants };
  }

  /** A grant's access key, parsed once per reader (a parse checks a hash, and the id is another). */
  #grantKey(text) {
    let key = this.#grantKeys.get(text);
    if (!key) {
      key = JazminAccessKey.fromOwnerDirectory(text);
      this.#grantKeys.set(text, key);
    }
    return key;
  }

  /** Reads and decodes a section by reference, checking its digest when it has one (spec 7.6.5). */
  #read(ref, sectionId, key, scratch) {
    if (!(ref.length >= ENVELOPE_SIZE)) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
    const section = this.#source.read(ref.offset, ref.length, scratch);
    // Bytes read ahead were counted when they were read.
    if (this.#cost && !this.#readAheads.some((r) => ref.offset >= r.start && ref.offset + ref.length <= r.start + r.buf.length)) this.#cost.bytesRead += ref.length;
    if (sectionPayloadLength(section) + ENVELOPE_SIZE !== ref.length) throw new JazminFormatError(`Section '${sectionId}' length mismatch`);
    if (ref.digest === undefined) {
      // Access-controlled files list every section with its digest (spec 7.6.5): one without is refused.
      if (this.#access) throw new JazminFormatError(`Section '${sectionId}' has no digest`);
    } else {
      const actual = digest(section);
      const matches = typeof ref.digest === 'string' ? actual.toString('base64') === ref.digest : actual.equals(ref.digest);
      if (!matches) throw new JazminFormatError(`Section '${sectionId}' does not match the owner's signature`);
    }
    this.#refuseBrotli(section, sectionId);
    return decodeSection(section, { key, fileId: this.#fileId, sectionId });
  }

  /**
   * Reads one chunk's payload (files with one column group), reading the file into a buffer reused from chunk
   * to chunk. Safe because every decoder copies what it keeps (strings, binary values).
   */
  #readChunk(ordinal) {
    const part = this.#part(ordinal, 0);
    const ahead = this.#ahead;
    const at = ahead ? ahead.ordinals.indexOf(ordinal) : -1;
    if (at >= 0) {
      for (let i = 0; i < at; i++) ahead.pool.takeDecoded(); // read ahead, then passed over by the query
      ahead.ordinals.splice(0, at + 1);
      const payload = ahead.pool.takeDecoded();
      if (payload) {
        if (this.#cost && !this.#readAheads.some((r) => part.offset >= r.start && part.offset + part.length <= r.start + r.buf.length)) this.#cost.bytesRead += part.length;
        return payload;
      }
      // A worker could not decode it: decode it here, which reports the error as a scan without read-ahead does.
    }
    if (this.#scratch.length < part.length) this.#scratch = Buffer.allocUnsafeSlow(Math.ceil(part.length * 1.25));
    const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${this.#groups[0].name}`;
    return this.#read(part, sectionId, this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId), this.#scratch);
  }

  /**
   * The items of a scan, in order. With priority 'speed' (files with one column group), the chunks of the next items
   * are read and decompressed ahead on worker threads while this thread builds rows; #readChunk takes them. `wanted`
   * (by column position) is what the scan decodes. A scan of more than a quarter of the columns uses 2 threads and
   * keeps 2 chunks in flight: building its rows here is the limit, and more would only add memory. A narrower one,
   * which mostly waits for decompression, uses every thread.
   */
  *#decodeAhead(items, ordinalOf, wanted) {
    const most = this.#access ? 0 : readThreads(this.#readOptions.priority ?? 'balanced');
    if (most === 0) {
      yield* items;
      return;
    }
    const wide = wanted.filter(Boolean).length * 4 > wanted.length;
    this.#dropAhead(); // what a scan left unfinished
    const iterator = items[Symbol.iterator]();
    const upcoming = []; // items whose chunks are being decoded ahead
    try {
      for (let n = 0; ; n++) {
        // Worker threads start from a scan's third chunk, so short scans never pay for them.
        const pool = n >= 2 ? this.#aheadPool(wide ? Math.min(2, most) : most) : null;
        const depth = pool && (wide ? 2 : pool.capacity);
        let next;
        while (pool && upcoming.length < depth && !(next = iterator.next()).done) {
          upcoming.push(next.value);
          this.#submitChunk(ordinalOf(next.value));
        }
        if (upcoming.length) yield upcoming.shift();
        else if ((next = iterator.next()).done) return;
        else yield next.value;
      }
    } finally {
      this.#dropAhead();
    }
  }

  /**
   * The worker threads of priority 'speed', at least `threads` of them: started on first use, and replaced by a
   * larger pool when a scan needs more. Null where worker threads are unavailable.
   */
  #aheadPool(threads) {
    const ahead = this.#ahead;
    if (ahead && (!ahead.pool || ahead.pool.size >= threads)) return ahead.pool;
    this.#dropAhead();
    ahead?.pool.close();
    let pool = null;
    try {
      pool = new SectionPool(threads);
    } catch {
      // no worker threads here: chunks are decoded on this thread
    }
    this.#ahead = { pool, ordinals: [] };
    return pool;
  }

  /**
   * Reads a chunk's section and hands it to a worker to decode. A section that fails a check here is not handed
   * over: #readChunk reads it again and reports the damage as a scan without read-ahead does.
   */
  #submitChunk(ordinal) {
    const part = this.#part(ordinal, 0);
    if (!(part.length >= ENVELOPE_SIZE)) return;
    if (this.#aheadBuffer.length < part.length) this.#aheadBuffer = Buffer.allocUnsafeSlow(Math.ceil(part.length * 1.25));
    const section = this.#source.read(part.offset, part.length, this.#aheadBuffer);
    if (sectionPayloadLength(section) + ENVELOPE_SIZE !== part.length) return;
    if (part.digest !== undefined) {
      const actual = digest(section);
      if (!(typeof part.digest === 'string' ? actual.toString('base64') === part.digest : actual.equals(part.digest))) return;
    }
    if (this.#noBrotli && section[0] === CODEC.brotli) return; // read when needed, and refused then
    const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${this.#groups[0].name}`;
    this.#ahead.pool.submit(section, { decode: true, key: this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId), fileId: this.#fileId, sectionId });
    this.#ahead.ordinals.push(ordinal);
  }

  /** Discards the chunks decoded ahead and not used (a scan ended early). */
  #dropAhead() {
    const ahead = this.#ahead;
    if (!ahead?.pool) return;
    for (; ahead.ordinals.length; ahead.ordinals.shift()) ahead.pool.takeDecoded();
  }

  /**
   * Reads and decodes one chunk's columns (files with one column group); `wanted` skips unneeded columns, and
   * `datesAsMs` gives datetimes as milliseconds instead of Date objects.
   */
  #decodeChunk(ordinal, wanted, datesAsMs = false) {
    const columns = decodeColumnar(this.#readChunk(ordinal), this.#streamTypes, this.#rowCount[ordinal], ordinal, wanted, datesAsMs);
    if (this.#cost) {
      this.#cost.chunksRead++;
      this.#cost.columnsDecoded += wanted ? wanted.filter(Boolean).length : this.#types.length;
    }
    return columns;
  }

  /**
   * A chunk decoded: its columns by position (null where not decoded) and the positions in it of rows that appends
   * deleted. `wanted` (by column position) limits the columns decoded, and a column group none of whose columns is
   * wanted is not read at all. Rows are built from the columns only for the rows a query looks at (chunkRow).
   */
  #chunk(ordinal, wanted = null, types = this.#streamTypes) {
    const cached = this.#cachedChunk;
    // A chunk decoded whole serves any query; one decoded with some nested fields left out serves only its own.
    if (cached.ordinal === ordinal && decodedAll(cached.wanted, wanted) && (cached.types === this.#streamTypes || cached.types === types)) return cached.chunk;
    const rowCount = this.#rowCount[ordinal];
    const columns = new Array(this.#columns.length).fill(null);
    const partitionSecret = this.#access ? this.#partitionSecret(this.#chunkPartition[ordinal]) : null;
    if (this.#access && !partitionSecret) throw new JazminKeyError(`Chunk ${ordinal} is not visible with this key`);
    this.#groups.forEach((group, g) => {
      if (!group.visible) return; // column group not granted: its columns stay hidden
      const groupWanted = wanted && group.cols.map((c) => wanted[c]);
      if (groupWanted && !groupWanted.includes(true)) return; // none of its columns is needed: its part is not read
      const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${group.name}`;
      const key = this.#access
        ? partKey(partitionSecret, this.#columnSecret(group.name), this.#salt, sectionId)
        : this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId);
      const raw = this.#read(this.#part(ordinal, g), sectionId, key);
      const decoded = decodeColumnar(raw, group.cols.map((c) => types[c]), rowCount, ordinal, groupWanted ?? undefined);
      if (this.#cost) this.#cost.columnsDecoded += groupWanted ? groupWanted.filter(Boolean).length : group.cols.length;
      group.cols.forEach((col, j) => {
        if (!groupWanted || groupWanted[j]) columns[col] = decoded[j];
      });
    });
    // Positions of deleted rows: a set as large as the deletions it holds, never as large as a (possibly damaged)
    // row count.
    const start = this.#rowStart[ordinal];
    let deleted = null;
    for (let i = lowerBound(this.#deleted, start); i < this.#deleted.length && this.#deleted[i] < start + rowCount; i++) {
      (deleted ??= new Set()).add(this.#deleted[i] - start);
    }
    const decodedCols = [];
    for (let c = 0; c < columns.length; c++) if (columns[c] !== null) decodedCols.push(c);
    const chunk = { columns, decoded: decodedCols, deleted, rowCount };
    this.#cachedChunk = { ordinal, wanted, types, chunk };
    if (this.#cost) this.#cost.chunksRead++;
    return chunk;
  }

  /** Loads (and caches) an index, or returns undefined if the file has none this reader may use. */
  #index(column, kind) {
    const cacheKey = `${column}/${kind}`;
    if (this.#indexes.has(cacheKey)) return this.#indexes.get(cacheKey);
    let index;
    // On the leading sortedBy column, chunk statistics already locate matches exactly, so loading the
    // (large) index would only cost time.
    const leadingSort = kind === 'sorted' && this.#table.sortedBy[0] === column;
    const descriptors = leadingSort ? [] : this.#indexList().filter((ix) => ix.column === column && ix.kind === kind);
    if (descriptors.length) {
      const type = this.#columns.find((c) => c.name === column)?.type;
      const read = (sectionId, ref) => {
        if (this.#cost) this.#cost.indexPagesRead++;
        return this.#read(ref, sectionId, this.#catalogKey(sectionId, this.#access?.secrets.owner, KEYRING_GROUPS.index));
      };
      // One segment for the original rows plus one per append (section id suffix "/<segment>").
      const sectionIdOf = (ix) => `${this.#tableIndex}/index/${column}/${kind}${ix.segment ? `/${ix.segment}` : ''}`;
      const combine = (parts) => (parts.length === 1 ? parts[0] : new CompositeIndex(parts));
      if (kind === 'trigram') {
        // Read only when a lookup is made: until then the planner knows its size, and may prefer a scan.
        const bytes = descriptors.reduce((sum, ix) => sum + ix.section.length, 0);
        index = new LazyTrigramIndex(bytes, () => combine(descriptors.map((ix) => TrigramIndex.decode(read(sectionIdOf(ix), ix.section)))));
      } else {
        // Only the directory is read now; pages are read (and a few kept) as lookups need them.
        index = combine(descriptors.map((ix) => {
          const sectionId = sectionIdOf(ix);
          return new PagedSortedIndex(decodeIndexDirectory(read(sectionId, ix.section)), type, (part, ref) => read(`${sectionId}/${part}`, ref),
            this.#header.readerFeatures.includes(INDEX_DELTAS));
        }));
      }
    }
    this.#indexes.set(cacheKey, index);
    return index;
  }

  /** Ordinal of the loaded, visible chunk holding a row id, or -1. */
  #chunkOrdinalFor(rowId) {
    const list = this.#visibleChunks;
    let lo = 0;
    let hi = list.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.#rowStart[list[mid]] <= rowId) lo = mid;
      else hi = mid - 1;
    }
    const o = list[lo];
    return rowId >= this.#rowStart[o] && rowId < this.#rowStart[o] + this.#rowCount[o] ? o : -1;
  }

  #isVisibleChunk(ordinal) {
    return ordinal >= 0 && this.#loaded[ordinal] === 1;
  }

  #toObject(row, select) {
    return this.#maker(select)(row);
  }

  /** Returns a cached function turning a row array into an object with the selected columns. */
  #maker(select) {
    const cacheKey = select.join(',');
    let make = this.#makers.get(cacheKey);
    if (!make) {
      make = objectMaker(select.map((i) => this.#columns[i].name), select);
      this.#makers.set(cacheKey, make);
    }
    return make;
  }

  #selection(select) {
    if (!select) return this.#visibleCols;
    return select.map((name) => this.#visibleIndex(name, 'select'));
  }

  #visibleIndex(name, where) {
    const i = this.#columns.findIndex((c) => c.name === name);
    if (i < 0) throw new JazminValidationError(`Unknown column '${name}' in ${where}`);
    return i;
  }

  #partitionCol() {
    const name = this.#table.partitionBy;
    return name ? this.#columns.findIndex((c) => c.name === name) : -1;
  }

  #plan(filter) {
    const plan = normalizeFilter(filter, this.#columns);
    if (!plan) {
      this.#ensureAllChunks();
      return plan;
    }
    // In access-controlled files a filter that pins the partition column selects whole partitions: the owner loads
    // only those, and the partition column's statistics are not needed.
    const partitionCol = this.#access ? this.#partitionCol() : -1;
    const names = partitionCol >= 0 ? partitionLookup(plan, partitionCol) : null;
    if (names && this.#access.isOwner && !this.#allLoaded) {
      this.#ensurePartitions(names.map((n) => this.#access.secrets.partitionId(n)));
    } else if (!names && this.#access?.isOwner && !this.#allLoaded) {
      // An index lookup: the chunk map says which partitions hold its rows, so only those are loaded.
      const map = this.#chunkMap();
      const lookup = map && indexPlan(plan, this.#indexProvider, ownerLookupBudget(map.partitions.length));
      if (lookup && this.#loadPartitionsOf(lookup.rows())) return plan;
      this.#ensureAllChunks();
    } else {
      this.#ensureAllChunks();
    }
    // An owner's statistics are one section per partition and column. An index lookup that costs less already narrows
    // the rows to check, so statistics would not narrow them further: they are not read.
    if (!names && this.#access?.isOwner && this.#partitions.size > 1 && indexPlan(plan, this.#indexProvider, ownerLookupBudget(this.#partitions.size))) return plan;
    const cols = planColumns(plan);
    const leading = this.#table.sortedBy[0];
    if (leading !== undefined) cols.add(this.#columns.findIndex((c) => c.name === leading));
    if (names) cols.delete(partitionCol);
    this.#ensureStats(cols);
    return plan;
  }

  /**
   * Chunks a scan must consider. A filter that pins the partition column to exact values selects whole
   * partitions; in a file sorted by `sortedBy`, chunk min/max values of the leading sort column are
   * non-decreasing, so a filter that bounds that column is answered by binary search.
   */
  #scanChunks(plan) {
    const byPartition = this.#access && plan ? this.#chunksForPartitions(plan) : null;
    if (byPartition) return byPartition;
    const visible = this.#visibleChunks;
    const leading = this.#table.sortedBy[0];
    if (!plan || !leading) return visible;
    const col = this.#columns.findIndex((c) => c.name === leading);
    const bounds = sortBounds(plan, col);
    if (!bounds) return visible;
    this.#sortStatsComplete ??= visible.every((ordinal) => {
      const s = this.#statAt(col, ordinal);
      return s !== undefined && s.min !== undefined && s.max !== undefined && s.nulls === 0;
    });
    if (!this.#sortStatsComplete) return visible; // e.g. nulls or truncated string statistics: check every chunk
    const stat = (i) => this.#statAt(col, visible[i]);
    const firstAtOrAfter = (test) => {
      let lo = 0;
      let hi = visible.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (test(stat(mid))) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const from = bounds.low === undefined ? 0
      : firstAtOrAfter((s) => (bounds.lowInclusive ? compareKeys(s.max, bounds.low) >= 0 : compareKeys(s.max, bounds.low) > 0));
    const to = bounds.high === undefined ? visible.length
      : firstAtOrAfter((s) => (bounds.highInclusive ? compareKeys(s.min, bounds.high) > 0 : compareKeys(s.min, bounds.high) >= 0));
    return visible.slice(from, Math.max(from, to));
  }

  /** Access-controlled files: ordinals of the partitions an exact filter on the partition column names. */
  #chunksForPartitions(plan) {
    const names = partitionLookup(plan, this.#partitionCol());
    if (!names) return null;
    const ids = this.#access.isOwner
      ? names.map((n) => this.#access.secrets.partitionId(n))
      : Object.entries(this.#access.partitionNames).filter(([, n]) => names.includes(n)).map(([id]) => id);
    const ordinals = [];
    for (const id of new Set(ids)) for (const o of this.#partitions.get(id)?.ordinals ?? []) if (this.#loaded[o]) ordinals.push(o);
    return ordinals.sort((a, b) => a - b);
  }

  /** Reads one row by its zero-based row id. */
  get(rowId) {
    if (!Number.isInteger(rowId) || rowId < 0 || rowId >= this.#table.rowCount) throw new JazminValidationError(`Row ${rowId} is out of range`);
    if (!(this.#access?.isOwner && !this.#allLoaded && this.#loadPartitionsOf([rowId]))) this.#ensureAllChunks();
    const ordinal = this.#chunkOrdinalFor(rowId);
    if (!this.#isVisibleChunk(ordinal) || this.#visibleCols.length === 0) throw new JazminKeyError(`Row ${rowId} is not visible with this key`);
    const chunk = this.#chunk(ordinal);
    const r = rowId - this.#rowStart[ordinal];
    if (chunk.deleted?.has(r)) throw new JazminValidationError(`Row ${rowId} was deleted`);
    return this.#toObject(chunkRow(chunk, r, new Array(this.#columns.length).fill(null)), this.#visibleCols);
  }

  /** Streams all visible rows (same as find() without a filter). */
  rows(options = {}) {
    return this.find(null, options);
  }

  /**
   * Streams visible rows matching a filter, in row order, or the last row first with `reverse: true` (in a file sorted
   * by date, the newest first, as fast as the oldest: the reader starts at the last chunk). `offset` and `limit` count
   * in that order. Uses indexes to read only candidate chunks; otherwise scans chunks, skipping those whose statistics
   * prove they cannot match.
   */
  find(filter, options) {
    const watch = this.#watch(filter, options);
    if (!watch) return this.#scan(filter, options, false);
    return (function* rows(scan) {
      for (const item of scan) if (item !== NEXT_CHUNK) yield item;
    })(this.#watched(this.#scan(filter, options, true), watch));
  }

  /** #find, or with `reverse: true` #findReversed. */
  #scan(filter, options, ticks) {
    const reverse = options?.reverse ?? false;
    if (typeof reverse !== 'boolean') throw new JazminValidationError('reverse must be true or false');
    return reverse ? this.#findReversed(filter, options, ticks) : this.#find(filter, options, ticks);
  }

  /**
   * Rows last first: the chunks the query reads, from the last; each one's matching rows read as #find reads them and
   * given last first, so memory is one chunk's rows. Chunks an offset passes over whole are counted, not read.
   */
  *#findReversed(filter, { select, limit = Infinity, offset = 0 } = {}, ticks) {
    const plan = this.#plan(filter);
    const rowIds = this.#candidates(plan);
    const runs = [...this.#chunkRuns(plan, rowIds)];
    const whole = this.#wholeChunkTest(plan);
    let skipped = 0;
    let yielded = 0;
    for (let i = runs.length - 1; i >= 0 && yielded < limit; i--) {
      const { ordinal } = runs[i];
      if (rowIds === null && skipped < offset && offset - skipped >= this.#liveRows(ordinal) && whole(ordinal)) {
        skipped += this.#liveRows(ordinal);
        continue;
      }
      if (ticks) yield NEXT_CHUNK;
      const rows = [...this.#find(filter, { select }, false, undefined, { plan, rowIds, runs: [runs[i]] })];
      for (let k = rows.length - 1; k >= 0 && yielded < limit; k--) {
        if (skipped < offset) {
          skipped++;
          continue;
        }
        yielded++;
        yield rows[k];
      }
    }
  }

  /**
   * Progress and stopping for a read, when its options ask for them (`onProgress`, `signal`): null otherwise, so a
   * read without them is as before. A signal already aborted stops the read before it starts.
   */
  #watch(filter, { onProgress, signal, offset = 0 } = {}) {
    if (!onProgress && !signal) return null;
    signal?.throwIfAborted();
    return { onProgress, signal, total: onProgress ? this.#plannedChunks(filter, offset).length : 0, started: 0 };
  }

  /** A scan with ticks (NEXT_CHUNK before each chunk), passed through with progress and stopping. */
  *#watched(scan, watch, matched = null) {
    let matches = 0;
    for (const item of scan) {
      if (item === NEXT_CHUNK) chunkStarts(watch, matched ? matched() : matches);
      else matches++;
      yield item;
    }
    chunksDone(watch, matched ? matched() : matches);
  }

  /**
   * find() for async code. Chunks are read with non-blocking reads, up to READ_AHEAD chunks ahead of the
   * decoding, and other work gets the event loop between chunks, so a long scan does not hold up a server.
   * Rows and their order are the same as find(). Run one query at a time per reader while it is in progress.
   */
  findAsync(filter, options) {
    return this.#findAsync(filter, options, false);
  }

  /**
   * findAsync() that yields the rows of each chunk as one array: the cost of async iteration is paid per chunk
   * instead of per row, which matters when the work per row is small.
   */
  findBatchesAsync(filter, options) {
    return this.#findAsync(filter, options, true);
  }

  async *#findAsync(filter, options, batched) {
    const source = this.#source;
    const watch = this.#watch(filter, options);
    const scan = watch ? this.#watched(this.#scan(filter, options, true), watch) : this.#scan(filter, options, true);
    let batch = [];
    if (!source.load) {
      // In memory: nothing to read, but still let other work run between chunks.
      for (const item of scan) {
        if (item !== NEXT_CHUNK) {
          if (batched) batch.push(item);
          else yield item;
          continue;
        }
        if (batch.length) {
          yield batch;
          batch = [];
        }
        await nextTurn();
      }
      if (batch.length) yield batch;
      return;
    }
    const planned = this.#plannedChunks(filter, options?.offset ?? 0, options?.reverse === true);
    const position = new Map(Array.from(planned, (ordinal, i) => [this.#span(ordinal).offset, i]));
    const loads = new Map(); // planned index -> pending read
    let requested = 0;
    let current = -1; // planned index of the chunk being decoded
    const fill = () => {
      for (; requested < planned.length && requested <= current + 1 + READ_AHEAD; requested++) {
        const span = this.#span(planned[requested]);
        const pending = source.load(span.offset, span.length);
        pending.catch(() => {}); // awaited when needed; a read nobody waits for must not crash the process
        loads.set(requested, pending);
      }
    };
    source.onRead = (start) => {
      const i = position.get(start);
      if (i !== undefined && i > current) current = i;
    };
    try {
      fill();
      for (const item of scan) {
        if (item !== NEXT_CHUNK) {
          if (batched) batch.push(item);
          else yield item;
          continue;
        }
        if (batch.length) {
          yield batch;
          batch = [];
        }
        // The scan is about to read its next chunk: free the one it finished, keep the window full and wait
        // for the next chunk's bytes, so the read is served from memory.
        if (current >= 0) source.release(this.#span(planned[current]).offset);
        fill();
        const next = loads.get(current + 1);
        if (next) {
          loads.delete(current + 1);
          await next;
        }
        await nextTurn();
      }
      if (batch.length) yield batch;
    } finally {
      source.onRead = null;
      source.drop();
    }
  }

  /** rows() for async code (see findAsync). */
  rowsAsync(options) {
    return this.findAsync(null, options);
  }

  /** The chunks a scan reads for a filter: those its partition, sort range and statistics leave. */
  #scanList(plan) {
    return Array.from(this.#scanChunks(plan)).filter((o) => !plan || this.#mayMatch(plan, o));
  }

  /**
   * Row ids indexes narrow a filter to (sorted), or null to scan. Index lookups are planned against what a scan would
   * read: small lookups (SMALL_LOOKUP_BYTES) are always made, and costlier ones only while they read less than the
   * scan's chunks, less one chunk (an index answer still reads at least one). A text search scans when its text is
   * common (LazyTrigramIndex.rows). Rows are kept only in the chunks a scan would read (a sort range, a pinned partition,
   * chunk statistics): nowhere else can a row match.
   */
  #candidates(plan) {
    if (!plan) return null;
    const scan = this.#scanList(plan);
    let scanBytes = 0;
    let scanRows = 0;
    let smallest = Infinity;
    for (const ordinal of scan) {
      const { length } = this.#span(ordinal);
      scanBytes += length;
      scanRows += this.#rowCount[ordinal];
      smallest = Math.min(smallest, length);
    }
    const lookup = indexPlan(plan, this.#indexProvider, Math.max(scan.length ? scanBytes - smallest : 0, SMALL_LOOKUP_BYTES), scanRows);
    const rows = lookup?.rows() ?? null;
    if (rows === null) return null;
    const inScan = new Uint8Array(this.#rowCount.length);
    for (const ordinal of scan) inScan[ordinal] = 1;
    return rows.filter((rowId) => {
      const ordinal = this.#chunkOrdinalFor(rowId);
      return ordinal >= 0 && inScan[ordinal] === 1;
    });
  }

  /**
   * The chunks a filtered query reads, in order, each with its index candidates: `from` to `to` (exclusive) in
   * `rowIds` (see #candidates). Without candidates, the chunks a scan reads (every row checked).
   */
  *#chunkRuns(plan, rowIds) {
    if (rowIds === null) {
      for (const ordinal of this.#scanChunks(plan)) if (!plan || this.#mayMatch(plan, ordinal)) yield { ordinal, from: 0, to: 0 };
      return;
    }
    for (let i = 0; i < rowIds.length;) {
      const ordinal = this.#chunkOrdinalFor(rowIds[i]);
      const end = this.#rowStart[ordinal] + this.#rowCount[ordinal];
      let j = i + 1;
      while (j < rowIds.length && rowIds[j] < end) j++;
      yield { ordinal, from: i, to: j };
      i = j;
    }
  }

  /**
   * The chunks a query reads, in the order it reads them (for reading ahead): leading chunks an offset skips whole
   * (see #iterate) are left out.
   */
  #plannedChunks(filter, offset = 0, reverse = false) {
    const plan = this.#plan(filter);
    const rowIds = this.#candidates(plan);
    const whole = this.#wholeChunkTest(plan);
    const ordinals = [];
    let skipped = 0;
    const runs = reverse ? [...this.#chunkRuns(plan, rowIds)].reverse() : this.#chunkRuns(plan, rowIds);
    for (const { ordinal } of runs) {
      if (!ordinals.length && rowIds === null && offset - skipped >= this.#liveRows(ordinal) && whole(ordinal)) skipped += this.#liveRows(ordinal);
      else ordinals.push(ordinal);
    }
    return ordinals;
  }

  /**
   * find(); with `ticks`, NEXT_CHUNK is yielded before each chunk is read (for findAsync). With `sink`, no row is built
   * or yielded: sink(columns, from, to) is called instead for rows from..to-1 of a chunk, with its decoded columns by
   * position (dates as milliseconds where the chunk is decoded for this query alone), which is all columnArrays()
   * needs. A full read passes each chunk's unbroken runs of rows at once.
   */
  // `only` (internal, #findReversed): the query's plan and candidates, worked out already, and the chunk runs to read.
  *#find(filter, { select, limit = Infinity, offset = 0 } = {}, ticks, sink, only) {
    const plan = only ? only.plan : this.#plan(filter);
    const selection = this.#selection(select);
    const singleGroup = !this.#access;
    const rowIds = only ? only.rowIds : this.#candidates(plan);
    const runs = only?.runs;
    if (singleGroup && plan) {
      // Decode only the filter's and the selected columns, of the chunks the index candidates (or the scan) name.
      yield* this.#scanColumns(plan, selection, offset, limit, ticks, rowIds, sink, runs);
      return;
    }
    const wanted = this.#wantedColumns(plan, selection); // only the filter's and the selected columns are decoded
    const decode = plan || sink ? null : this.#directDecoder(selection);
    if (decode || (sink && !plan)) {
      // Full scan: each chunk's columns are decoded and rows built from them one at a time (in access-controlled
      // files through #chunk, which reads each column group's part). Chunks wholly before the offset are counted,
      // not read.
      let skipped = 0;
      let yielded = 0;
      let deleted = 0;
      for (const ordinal of this.#decodeAhead(runs ? runs.map((run) => run.ordinal) : this.#visibleChunks, (o) => o, wanted)) {
        if (yielded >= limit) return;
        if (skipped < offset && offset - skipped >= this.#liveRows(ordinal)) {
          skipped += this.#liveRows(ordinal);
          continue;
        }
        const rowCount = this.#rowCount[ordinal];
        if (ticks) yield NEXT_CHUNK;
        const columns = singleGroup ? this.#decodeChunk(ordinal, wanted, sink !== undefined) : this.#chunk(ordinal, wanted).columns;
        if (sink) {
          // Unbroken runs of rows go to the sink together: deleted rows, the offset and the limit end a run.
          let from = -1;
          let to = -1;
          for (let r = 0; r < rowCount && yielded < limit; r++) {
            const rowId = this.#rowStart[ordinal] + r;
            while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
            if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue;
            if (skipped < offset) {
              skipped++;
              continue;
            }
            yielded++;
            if (r !== to) {
              if (from >= 0) sink(columns, from, to);
              from = r;
            }
            to = r + 1;
          }
          if (from >= 0) sink(columns, from, to);
          continue;
        }
        for (let r = 0; r < rowCount; r++) {
          if (yielded >= limit) return;
          const rowId = this.#rowStart[ordinal] + r;
          while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
          if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue; // removed by an append
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yielded++;
          yield decode(columns, r);
        }
      }
      return;
    }
    const make = sink ? null : this.#maker(selection);
    for (const item of this.#iterate(plan, offset, limit, ticks, wanted, rowIds, sink, runs)) yield item === NEXT_CHUNK ? item : make(item[1]);
  }

  /**
   * The definitions a query's filter columns are decoded with: a nested column the filter checks and the rows don't
   * return, with only the fields the filter reads (the others' streams are passed over). The file's otherwise.
   */
  #filterTypes(plan, selection) {
    let types = this.#streamTypes;
    for (const c of planColumns(plan)) {
      const column = this.#columns[c];
      if (selection.includes(c) || (column.type !== 'list' && column.type !== 'object')) continue;
      const read = filterReads(column, c, plan);
      if (read === column) continue;
      if (types === this.#streamTypes) types = [...types];
      types[c] = read;
    }
    return types;
  }

  /** By column position: the columns a query decodes - those its filter reads and those it returns. */
  #wantedColumns(plan, selection) {
    const used = plan ? planColumns(plan) : new Set();
    for (const c of selection) used.add(c);
    return this.#columns.map((_, i) => used.has(i));
  }

  /**
   * A filtered query on a file with one column group: only the columns the filter and the selection use are decoded,
   * and with index candidates (`rowIds`) only their chunks are read and only their rows checked. The filter's columns
   * are decoded first. The others are decoded only for chunks with matching rows, and of those only the matching rows'
   * text, decimal, json and binary values, so a selective scan makes few values it would throw away.
   */
  *#scanColumns(plan, selection, offset, limit, ticks, rowIds, sink, runs) {
    const wanted = this.#wantedColumns(plan, selection);
    const make = sink ? null : this.#maker(selection);
    const row = new Array(this.#columns.length);
    const wantedAt = wanted.flatMap((w, c) => (w ? [c] : []));
    const filterCols = plan ? this.#wantedColumns(plan, []) : null;
    const filterAt = filterCols ? filterCols.flatMap((w, c) => (w ? [c] : [])) : [];
    const rest = filterCols ? wanted.map((w, c) => w && !filterCols[c]) : null;
    const restCount = rest ? rest.filter(Boolean).length : 0;
    const filterTypes = plan ? this.#filterTypes(plan, selection) : null;
    const whole = this.#wholeChunkTest(plan);
    const datesAsMs = sink !== undefined; // column arrays take dates as milliseconds
    let skipped = 0;
    let yielded = 0;
    let deleted = 0;
    for (const { ordinal, from, to } of this.#decodeAhead(runs ?? this.#chunkRuns(plan, rowIds), (run) => run.ordinal, wanted)) {
      if (yielded >= limit) return;
      if (rowIds === null && skipped < offset && offset - skipped >= this.#liveRows(ordinal) && whole(ordinal)) {
        skipped += this.#liveRows(ordinal); // every row matches and lies before the offset: no need to read it
        continue;
      }
      if (ticks) yield NEXT_CHUNK;
      const start = this.#rowStart[ordinal];
      const count = rowIds === null ? this.#rowCount[ordinal] : to - from;
      let columns;
      let matches = null;
      let hits = null; // when few rows of the chunk match: their positions in it,
      let found = null; // and by column, their values (one per hit)
      if (!plan) columns = this.#decodeChunk(ordinal, wanted, datesAsMs); // filters compare dates as milliseconds
      else {
        const raw = this.#readChunk(ordinal);
        const rowCount = this.#rowCount[ordinal];
        const few = rowCount * FEW_ROWS;
        found = new Array(this.#columns.length);
        if (rowIds !== null && count <= few) {
          // A few index candidates: only their values of the filter's columns are decoded.
          const positions = new Array(count);
          for (let k = 0; k < count; k++) positions[k] = rowIds[from + k] - start;
          const values = decodeColumnarAt(raw, filterTypes, rowCount, ordinal, filterCols, positions, datesAsMs);
          hits = [];
          for (const c of filterAt) found[c] = [];
          for (let k = 0; k < count; k++) {
            for (const c of filterAt) row[c] = values[c][k];
            if (!evaluate(plan, row)) continue;
            hits.push(positions[k]);
            for (const c of filterAt) found[c].push(row[c]);
          }
        } else {
          columns = decodeColumnar(raw, filterTypes, rowCount, ordinal, filterCols, datesAsMs);
          matches = new Uint8Array(rowCount);
          let matched = 0;
          for (let k = 0; k < count; k++) {
            const r = rowIds === null ? k : rowIds[from + k] - start;
            for (const c of filterAt) row[c] = columns[c][r];
            if (evaluate(plan, row)) {
              matches[r] = 1;
              matched++;
            }
          }
          if (matched <= few) {
            hits = [];
            for (const c of filterAt) found[c] = [];
            for (let r = 0; r < rowCount; r++) {
              if (!matches[r]) continue;
              hits.push(r);
              for (const c of filterAt) found[c].push(columns[c][r]);
            }
          } else if (restCount) {
            const more = decodeColumnar(raw, this.#streamTypes, rowCount, ordinal, rest, datesAsMs, matches);
            for (let c = 0; c < more.length; c++) if (rest[c]) columns[c] = more[c];
          }
        }
        // Few rows match: the other columns are decoded for them alone (the values between them are passed over).
        if (hits?.length && restCount) {
          const more = decodeColumnarAt(raw, filterTypes, rowCount, ordinal, rest, hits, datesAsMs);
          for (let c = 0; c < more.length; c++) if (rest[c]) found[c] = more[c];
        }
        if (this.#cost) {
          this.#cost.chunksRead++;
          this.#cost.columnsDecoded += filterAt.length + (!hits || hits.length ? restCount : 0);
        }
      }
      if (hits) {
        for (let h = 0; h < hits.length; h++) {
          if (yielded >= limit) return;
          const rowId = start + hits[h];
          while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
          if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue;
          for (const c of wantedAt) row[c] = found[c][h];
          if (skipped < offset) {
            skipped++;
            continue;
          }
          yielded++;
          if (sink) sink(found, h, h + 1);
          else yield make(row);
        }
        continue;
      }
      for (let k = 0; k < count; k++) {
        if (yielded >= limit) return;
        const r = rowIds === null ? k : rowIds[from + k] - start;
        const rowId = start + r;
        while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
        if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue;
        if (matches && !matches[r]) continue; // the filter, checked as the chunk was decoded
        for (const c of wantedAt) row[c] = columns[c][r];
        if (skipped < offset) {
          skipped++;
          continue;
        }
        yielded++;
        if (sink) sink(columns, r, r + 1);
        else yield make(row);
      }
    }
  }

  /** Cached generated row builder for a column selection (null where code generation is unavailable). */
  #directDecoder(select) {
    const cacheKey = 'direct:' + select.join(',');
    if (!this.#makers.has(cacheKey)) this.#makers.set(cacheKey, columnsToObject(this.#columns, select));
    return this.#makers.get(cacheKey);
  }

  /**
   * Internal: every visible row, partition by partition (in directory order) and in file order within each, a chunk at
   * a time: compact({ regroup: true }) writes each partition's rows together.
   */
  *[ROWS_BY_PARTITION]() {
    this.#ensureAllChunks();
    const make = this.#maker(this.#visibleCols);
    const row = new Array(this.#columns.length).fill(null);
    for (const { ordinals } of this.#partitions.values()) {
      for (const ordinal of [...ordinals].sort((a, b) => a - b)) {
        if (!this.#loaded[ordinal]) continue;
        const chunk = this.#chunk(ordinal);
        for (let r = 0; r < chunk.rowCount; r++) if (!chunk.deleted?.has(r)) yield make(chunkRow(chunk, r, row));
      }
    }
  }

  /** Internal: [rowId, row object with every visible column] for matching rows. */
  *[ROWS_WITH_IDS](filter) {
    const make = this.#maker(this.#visibleCols);
    const plan = this.#plan(filter);
    for (const [rowId, row] of this.#iterate(plan, 0, Infinity, false, null, this.#candidates(plan))) yield [rowId, make(row)];
  }

  /**
   * Yields [rowId, row array] for visible, non-deleted rows matching a normalized filter, in the chunks of the
   * candidate `rowIds` (see #candidates) or of a scan when null. `wanted` (by column position, null: all) limits
   * the columns decoded. The row array is reused for the next row: copy what you keep.
   */
  *#iterate(plan, offset, limit, ticks, wanted, rowIds, sink, runs) {
    let skipped = 0;
    let yielded = 0;
    const row = new Array(this.#columns.length).fill(null);

    const accept = (chunk, r) => {
      if (chunk.deleted?.has(r)) return false;
      chunkRow(chunk, r, row);
      if (plan && !evaluate(plan, row)) return false;
      if (skipped < offset) {
        skipped++;
        return false;
      }
      return true;
    };

    const whole = this.#wholeChunkTest(plan);
    for (const { ordinal, from, to } of runs ?? this.#chunkRuns(plan, rowIds)) {
      if (yielded >= limit) return;
      if (rowIds === null && skipped < offset && offset - skipped >= this.#liveRows(ordinal) && whole(ordinal)) {
        skipped += this.#liveRows(ordinal); // every row matches and lies before the offset: no need to read it
        continue;
      }
      if (ticks) yield NEXT_CHUNK;
      const chunk = this.#chunk(ordinal, wanted);
      const start = this.#rowStart[ordinal];
      const count = rowIds === null ? chunk.rowCount : to - from;
      for (let k = 0; k < count; k++) {
        if (yielded >= limit) return;
        const r = rowIds === null ? k : rowIds[from + k] - start;
        if (accept(chunk, r)) {
          yielded++;
          if (sink) sink(chunk.columns, r, r + 1);
          else yield [start + r, row];
        }
      }
    }
  }

  /**
   * Internal (key rotation, TASKS S-2), for a file encrypted with a key or password: its preamble values, its decoded
   * header and where the header is, and every other section it references, as { offset, length, sectionId, key } with
   * either `group` (the keyring group that keys it) or `contentKey` (an embedded-file block, keyed by its content key
   * and the file's salt). `key` decrypts the section now.
   */
  get [KEY_ROTATION]() {
    if (!this.#keys || this.#access) throw new JazminValidationError('Only a file encrypted with a key or password has its key rotated this way');
    const sections = [];
    const add = (ref, sectionId, group) => {
      sections.push({ offset: ref.offset, length: ref.length, sectionId, key: this.#keys.sectionKey(group, sectionId), group });
    };
    this.#header.deltas.forEach((ref, i) => add(ref, `delta/${i}`, KEYRING_GROUPS.data));
    const files = this.#header.files;
    if (files) {
      const suffix = files.segment ? `/${files.segment}` : '';
      for (const dir of files.directories) add(dir.section, `files/dir${suffix}`, KEYRING_GROUPS.files);
      for (const content of this.#files().contents.values()) {
        if (!content.key) throw new JazminFormatError(`Embedded content ${content.id} has no key in an encrypted file`);
        const contentKey = Buffer.from(content.key, 'base64');
        content.blocks.forEach((block, b) => {
          const sectionId = `file/${content.id}/${b}`;
          sections.push({ offset: block.offset, length: block.length, sectionId, key: hkdf(contentKey, this.#salt, `JAZMIN/1/${sectionId}`), contentKey });
        });
      }
    }
    this.#header.tables.forEach((table, t) => {
      const reader = t === this.#tableIndex ? this : new JazminReader(SHARED, { table: table.name, [SHARED]: this });
      try {
        reader.#tableSections(add);
      } finally {
        if (reader !== this) reader.close();
      }
    });
    return { flags: this.#flags, fileId: this.#fileId, header: this.#header, headerRef: this.#headerRef, end: this.#validEnd, recovered: this.#recovered, sections };
  }

  /**
   * The sections of this reader's table, for KEY_ROTATION: `add(ref, sectionId, keyring group)`. Without `chunks`,
   * the chunk parts are left out (storage() sums them from the chunk directories).
   */
  #tableSections(add, { chunks = true } = {}) {
    const t = this.#tableIndex;
    const table = this.#table;
    const { data, index } = KEYRING_GROUPS;
    for (const g of table.columnGroups) {
      if (!g.definitions) continue;
      if (!this.#access) throw new JazminFormatError('Catalog: only access-controlled files keep column definitions in their own section');
      add(g.definitions, `${t}/columns/${g.name}`, data);
    }
    if (table.partitionTable) add(table.partitionTable, `${t}/partitions`, data);
    if (table.deletes) add(table.deletes, `${t}/deletes/${table.deletedCount}`, data);
    this.#ensureAllChunks();
    for (const [id, p] of this.#partitions) p.segments.forEach((ref, s) => add(ref, `${t}/dir/${id}${s ? `/${s}` : ''}`, data));
    for (const segment of this.#segments) {
      segment.statistics.forEach((block, b) => add(block.section, `${t}/stats/${segment.partition}/${b}${segment.suffix}`, data));
    }
    for (let o = 0; o < this.#loaded.length; o++) {
      if (!this.#loaded[o]) throw new JazminFormatError(`Chunk ${o} is in no chunk directory`);
      if (chunks) this.#groups.forEach((group, g) => add(this.#part(o, g), `${t}/chunk/${o}/${group.name}`, data));
    }
    for (const ix of this.#indexList()) {
      const base = `${t}/index/${ix.column}/${ix.kind}${ix.segment ? `/${ix.segment}` : ''}`;
      add(ix.section, base, index);
      if (ix.kind !== 'sorted') continue;
      const directory = decodeIndexDirectory(this.#read(ix.section, base, this.#catalogKey(base, this.#access?.secrets.owner, index)));
      directory.pages.forEach((page, n) => add(page, `${base}/page/${n}`, index));
      if (directory.nulls) add(directory.nulls, `${base}/nulls`, index);
    }
  }

  /**
   * Checks every section of the file's current version, not only those queries read (issue #275): in a shared file
   * each section's SHA-256 against the owner's signature, in a file with a key or password each section's CRC-32 and
   * authentication tag (a change to any section is caught), in a plain file each CRC-32 (accidental damage only). One section at a
   * time. Also the preamble and trailer values no checksum covers, and a publisher signature block (whole, not who signed it).
   * Throws a JazminFormatError naming the first section that fails. Bytes the current
   * version doesn't use (replaced by appends) are counted, not checked: compact() removes them. Needs the whole file:
   * an owner key, or the key or password of a file that isn't shared.
   *
   * options.quick (a plain file only; other files are checked the same either way): each section's CRC-32 and envelope,
   * without decompressing it, several times faster. The decompressed length a compressed section's envelope gives
   * isn't in its CRC-32, so a change to it is left to the query that reads the section.
   */
  verify({ quick = false } = {}) {
    if (typeof quick !== 'boolean') throw new JazminValidationError('verify: quick must be true or false');
    try {
      return this.#verifyWhole(quick);
    } catch (error) {
      // The file opened with this key, so a section it can't decrypt was changed: say so, as for any other section.
      if (!(error instanceof JazminKeyError)) throw error;
      const changed = new JazminFormatError(`A section could not be decrypted with the key the file opened with - the file was modified (${error.message})`);
      changed.cause = error;
      throw changed;
    }
  }

  #verifyWhole(quick) {
    if (this.#closed) throw new JazminValidationError('This reader is closed');
    if (this.#access && !this.#access.isOwner) throw new JazminValidationError('A shared file is checked whole with its owner key');
    if (this.#recovered) {
      throw new JazminFormatError('The file ends in an append that did not finish, or whose end was changed: this reader opened '
        + 'the version before it. compact() keeps that version and removes the rest');
    }
    const preamble = this.#source.read(0, PREAMBLE_SIZE);
    // Fields no checksum or tag covers (appends change the flags in place), checked for the values the format allows
    // (4.1, 4.2, 7.6, 11.2): reserved bytes; no salt in a plain file; PASSWORD only on a file encrypted with a password,
    // with an iteration count readers accept, and iterations only then; APPENDED on a file that was appended to (a file
    // that wasn't may have it: an append cut short leaves it); the trailer's key-slot and signature fields only in a
    // shared file.
    const iterations = preamble.readUInt32LE(56);
    const password = (this.#flags & FLAG_PASSWORD) !== 0;
    const trailer = this.#source.read(this.#validEnd - TRAILER_SIZE, TRAILER_SIZE);
    const fixed = preamble.readUInt16LE(6) === 0 && preamble.readUInt32LE(60) === 0
      && (this.encrypted || preamble.subarray(24, 56).every((b) => b === 0))
      && (password ? this.encrypted && !this.#access && iterations >= MIN_KDF_ITERATIONS && iterations <= MAX_KDF_ITERATIONS : iterations === 0)
      && (!this.#header.appendCount || (this.#flags & FLAG_APPENDED) !== 0)
      && (this.#access || trailer.subarray(12, 36).every((b) => b === 0));
    if (!fixed) throw new JazminFormatError('The preamble or trailer has values the format does not allow - the file was modified');

    const end = this.#validEnd - TRAILER_SIZE; // sections lie between the preamble and the trailer
    const sections = new Map(); // offset -> { ref, sectionId, key }: each section once, however often it is referenced
    const add = (ref, sectionId, key) => {
      if (!ref?.length || sections.has(ref.offset)) return;
      if (!(ref.offset >= PREAMBLE_SIZE && ref.offset + ref.length <= end)) throw new JazminFormatError(`Section '${sectionId}' lies outside the file`);
      sections.set(ref.offset, { ref, sectionId, key });
    };
    const keyOf = (group, sectionId) => this.#keys?.sectionKey(group, sectionId);
    let bytes = 0;
    if (this.#access) {
      // The signature covers the header and the key-slot list; the list holds every page's digest (spec 7.6.4).
      const { keySlots, signature } = this.#access;
      const slotsSection = this.#source.read(keySlots.offset, keySlots.length);
      const signatureSection = this.#source.read(signature.offset, signature.length);
      // Its envelope's reserved bytes are in neither its CRC nor the signed message.
      if (signatureSection[2] !== 0 || signatureSection[3] !== 0) throw new JazminFormatError("Section 'signature' has an invalid envelope");
      const signatureRaw = decodeSection(plainSection(signatureSection, 'signature'), { key: undefined, fileId: this.#fileId, sectionId: 'signature' });
      const headerSection = this.#source.read(this.#headerRef.offset, this.#headerRef.length);
      verifySignedBy(signatureRaw, this.#fileId, slotsSection, headerSection, this.#access.signedBy);
      bytes += keySlots.length + signature.length + this.#headerRef.length;
      const list = decodeSection(plainSection(slotsSection, 'keyslots'), { key: undefined, fileId: this.#fileId, sectionId: 'keyslots' });
      keySlotPages(list).forEach((page, n) => add(page, `keyslots/${n}`));
      add(this.#header.access.ownerDirectory, 'owner');
      add(this.#header.access.ownerCatalog, 'owner/catalog');
    } else {
      add(this.#headerRef, 'header', this.#keys?.headerKey);
    }
    this.#header.deltas.forEach((ref, i) => add(ref, `delta/${i}`, keyOf(KEYRING_GROUPS.data, `delta/${i}`)));
    const files = this.#header.files;
    if (files) {
      const suffix = files.segment ? `/${files.segment}` : '';
      for (const dir of files.directories) add(dir.section, `files/dir${suffix}`, keyOf(KEYRING_GROUPS.files, `files/dir${suffix}`));
      for (const content of this.#files().contents.values()) {
        content.blocks.forEach((block, b) => {
          const sectionId = `file/${content.id}/${b}`;
          add(block, sectionId, content.key && !this.#access ? hkdf(Buffer.from(content.key, 'base64'), this.#salt, `JAZMIN/1/${sectionId}`) : undefined);
        });
      }
    }
    this.#header.tables.forEach((table, t) => {
      const reader = t === this.#tableIndex ? this : new JazminReader(SHARED, { table: table.name, [SHARED]: this });
      try {
        reader.#tableSections((ref, sectionId, group) => add(ref, sectionId, keyOf(group, sectionId)));
        if (this.#access) {
          const entry = this.#ownerCatalog().find((e) => e.table === t);
          add(entry?.chunkMap, `${t}/chunkmap`);
          add(entry?.chunkMapAppended, `${t}/chunkmap/${entry?.chunkMapSegment}`);
        }
      } finally {
        if (reader !== this) reader.close();
      }
    });

    let largest = 0;
    for (const { ref } of sections.values()) largest = Math.max(largest, ref.length);
    const scratch = Buffer.allocUnsafeSlow(largest); // one buffer, one section at a time
    for (const offset of [...sections.keys()].sort((a, b) => a - b)) {
      const { ref, sectionId, key } = sections.get(offset);
      if (!(ref.length >= ENVELOPE_SIZE)) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
      const section = this.#source.read(ref.offset, ref.length, scratch);
      if (sectionPayloadLength(section) + ENVELOPE_SIZE !== ref.length) throw new JazminFormatError(`Section '${sectionId}' length mismatch`);
      if (this.#access) {
        if (ref.digest === undefined) throw new JazminFormatError(`Section '${sectionId}' has no digest`);
        const actual = digest(section);
        const matches = typeof ref.digest === 'string' ? actual.toString('base64') === ref.digest : actual.equals(ref.digest);
        if (!matches) throw new JazminFormatError(`Section '${sectionId}' does not match the owner's signature`);
      } else if (!this.encrypted) {
        // The CRC-32 covers the payload, not the envelope: check its fixed bytes, and its codec and length by decoding
        // (quick: by the codec and, stored as is, the length; the decompressed length is left to the query that reads it).
        if (section[1] !== 0 || section[2] !== 0 || section[3] !== 0) throw new JazminFormatError(`Section '${sectionId}' has an invalid envelope`);
        if (!quick) decodeSection(section, { key: undefined, fileId: this.#fileId, sectionId });
        else if (crc32(section.subarray(ENVELOPE_SIZE)) !== section.readUInt32LE(12)) throw new JazminFormatError(`Section '${sectionId}' failed its CRC-32 check`);
        else if (!Object.values(CODEC).includes(section[0])) throw new JazminFormatError(`Section '${sectionId}' has an unknown codec`);
        else if (section[0] === CODEC.none && section.readUInt32LE(4) !== section.readUInt32LE(8)) throw new JazminFormatError(`Section '${sectionId}' length mismatch`);
      } else {
        const opens = sectionKeyCheck(section, { fileId: this.#fileId, sectionId }); // checks the CRC-32 first
        if (opens === null && this.encrypted) throw new JazminFormatError(`Section '${sectionId}' is not encrypted but the file is`);
        if (opens !== null && !(key && opens(key))) throw new JazminFormatError(`Section '${sectionId}' failed its authentication check - the file was modified`);
      }
      bytes += ref.length;
    }
    const publisherBytes = this.#publisherBlockBytes();
    const unusedBytes = end - PREAMBLE_SIZE - bytes - publisherBytes;
    // Only appends leave bytes behind: in a file never appended to, every byte is a section, the trailer or the block.
    if (unusedBytes !== 0 && !this.#header.appendCount) {
      throw new JazminFormatError(`${unusedBytes} bytes are not part of the file, which was never appended to - the file was modified`);
    }
    return {
      checkedBy: this.#access ? 'signature' : this.encrypted ? 'encryption' : 'checksum',
      sections: sections.size + (this.#access ? 3 : 0),
      bytes,
      unusedBytes,
      publisherBytes,
    };
  }

  /**
   * The length of the publisher signature block just before the header (spec 6.9.1), or 0 without one. verify() checks
   * that it is whole (its footer and CRC); who signed it, and what it covers, is verifyPublisher()'s to check.
   */
  #publisherBlockBytes() {
    const end = this.#headerRef.offset;
    if (end < PREAMBLE_SIZE + PUBLISHER_FOOTER_SIZE) return 0;
    const footer = this.#source.read(end - PUBLISHER_FOOTER_SIZE, PUBLISHER_FOOTER_SIZE);
    if (footer.readUInt32LE(12) !== PUBLISHER_MAGIC) return 0;
    const length = footer.readUInt32LE(0);
    const start = end - PUBLISHER_FOOTER_SIZE - length;
    if (start < PREAMBLE_SIZE || footer.readUInt16LE(8) !== 1 || footer.readUInt16LE(10) !== 0
      || crc32(this.#source.read(start, length)) !== footer.readUInt32LE(4)) {
      throw new JazminFormatError('The publisher signature block before the header is damaged - the file was modified');
    }
    return PUBLISHER_FOOTER_SIZE + length;
  }

  /**
   * How the file's bytes are used, for deciding whether to compact it: the bytes the current version uses, those it
   * no longer does (headers and sections that appends replaced, embedded files replaced or removed, an interrupted
   * append), and per table the rows deleted but still stored (with an estimate of their bytes), its chunks and its
   * index segments (one per index after a full write, and one more per append). compact() removes the unused bytes
   * and the deleted rows, and merges the segments; compact({ regroup: true }) also merges the small chunks appends
   * add. Reads directories, not rows. Needs the whole file: an owner key, or the key or password of a file that isn't
   * shared.
   */
  storage() {
    if (this.#closed) throw new JazminValidationError('This reader is closed');
    if (this.#access && !this.#access.isOwner) throw new JazminValidationError("A shared file's storage is measured with its owner key");
    const used = new Map(); // offset -> length: each section once, however often it is referenced
    const add = (ref) => {
      if (ref && ref.length) used.set(ref.offset, Math.max(used.get(ref.offset) ?? 0, ref.length));
    };
    add(this.#headerRef);
    if (this.#access) {
      add(this.#access.keySlots);
      for (const page of keySlotPages(decodeSection(plainSection(this.#access.keySlots.section, 'keyslots'), { key: undefined, fileId: this.#fileId, sectionId: 'keyslots' }))) add(page);
      add(this.#access.signature);
      add(this.#header.access.ownerDirectory);
      add(this.#header.access.ownerCatalog);
    }
    this.#header.deltas.forEach((ref) => add(ref));
    if (this.#header.files) {
      for (const dir of this.#header.files.directories) add(dir.section);
      for (const content of this.#files().contents.values()) content.blocks.forEach((block) => add(block));
    }
    const tables = this.#header.tables.map((table, t) => { // chunkBytes: the table's chunk parts, each used once
      const reader = t === this.#tableIndex ? this : new JazminReader(SHARED, { table: table.name, [SHARED]: this });
      try {
        return reader.#tableStorage(add);
      } finally {
        if (reader !== this) reader.close();
      }
    });
    let usedBytes = PREAMBLE_SIZE + TRAILER_SIZE + tables.reduce((n, t) => n + t.chunkBytes, 0);
    for (const length of used.values()) usedBytes += length;
    const fileBytes = this.#source.size;
    return {
      fileBytes,
      usedBytes,
      unusedBytes: fileBytes - usedBytes,
      deletedRows: tables.reduce((n, t) => n + t.deletedRows, 0),
      deletedBytes: tables.reduce((n, t) => n + t.deletedBytes, 0),
      appendCount: this.#header.appendCount ?? 0,
      tables: tables.map(({ chunkBytes, ...t }) => t),
    };
  }

  /** This table's sections (to `add`), and its rows, deleted rows, chunks and index segments, for storage(). */
  #tableStorage(add) {
    this.#tableSections((ref) => add(ref), { chunks: false });
    // Chunk parts are many (one per chunk and column group) and each used once: summed, not listed.
    let chunkBytes = 0;
    for (let k = 0; k < this.#partLength.length; k++) chunkBytes += this.#partLength[k];
    const t = this.#tableIndex;
    if (this.#access) {
      const entry = this.#ownerCatalog().find((e) => e.table === t);
      add(entry?.chunkMap);
      add(entry?.chunkMapAppended);
    }
    // Deleted rows' bytes, estimated: each chunk's bytes in proportion to the rows of it deleted.
    let deletedBytes = 0;
    let d = 0;
    for (let o = 0; o < this.#loaded.length && d < this.#deleted.length; o++) {
      const start = this.#rowStart[o];
      const end = start + this.#rowCount[o];
      let n = 0;
      while (d < this.#deleted.length && this.#deleted[d] < end) {
        if (this.#deleted[d] >= start) n++;
        d++;
      }
      if (!n) continue;
      let bytes = 0;
      for (let k = o * this.#groups.length, end = k + this.#groups.length; k < end; k++) bytes += this.#partLength[k];
      deletedBytes += Math.round((bytes * n) / this.#rowCount[o]);
    }
    const segments = new Map();
    for (const ix of this.#indexList()) {
      const name = `${ix.column}/${ix.kind}`;
      segments.set(name, { column: ix.column, kind: ix.kind, segments: (segments.get(name)?.segments ?? 0) + 1 });
    }
    const stored = this.#table.rowCount;
    const chunks = this.#table.chunkCount;
    return {
      chunkBytes,
      name: this.#table.name,
      rows: stored - this.#deleted.length,
      deletedRows: this.#deleted.length,
      deletedBytes,
      chunks,
      rowsPerChunk: chunks ? Math.round(stored / chunks) : 0,
      indexes: [...segments.values()],
    };
  }

  /** Internal: whether the file's sorted indexes may use keys as differences (reader feature 'index-deltas'). */
  get [COMPACT_INDEXES]() {
    return this.#header.readerFeatures.includes(INDEX_DELTAS);
  }

  /** Internal: what the appender needs to continue this file. Owner (or the single key / password) only. */
  get [APPEND_STATE]() {
    // An append needs every partition listed (for their segment counts), not every chunk directory read: with many
    // partitions, reading them all would cost more than the append. In a sorted table it also needs the last chunk's
    // last row, which bounds the sort order: only that chunk's partition is read when the chunk map names it.
    this.#listAllPartitions();
    let last = null;
    if ((this.#table.sortedBy.length || this.#table.sort?.length) && this.#table.chunkCount > 0) {
      const lastOrdinal = this.#table.chunkCount - 1;
      const map = this.#access?.isOwner && !this.#allLoaded ? this.#chunkMap() : null;
      if (!(map && this.#loadPartitionsOf([map.rowStarts[lastOrdinal]]))) this.#ensureAllChunks();
      if (this.#loaded[lastOrdinal]) last = this.#chunk(lastOrdinal); // its last row, even if deleted, bounds the sort order
    }
    const isOwner = this.#access?.isOwner;
    return {
      header: this.#header,
      table: this.#table,
      tableIndex: this.#tableIndex,
      ownerCatalog: isOwner ? this.#ownerCatalog() : null,
      chunkMap: isOwner ? this.#chunkMapState() : null,
      fileId: this.#fileId,
      salt: this.#salt,
      flags: this.#flags,
      keys: this.#keys,
      ownerSecrets: this.#access?.secrets ?? null,
      directory: isOwner ? this.#ownerDirectory() : null,
      directoryText: isOwner ? this.#access.directoryText : null,
      directoryRef: isOwner ? this.#header.access.ownerDirectory : null,
      keySlots: isOwner ? this.#access.keySlots : null,
      indexes: this.#indexList(),
      segmentCounts: new Map([...this.#partitions.values()].map((p) => [p.id, p.segments.length])),
      deleted: this.#deleted,
      files: this[FILE_STATE],
      validEnd: this.#validEnd,
      lastRow: last && last.rowCount ? Object.fromEntries(this.#columns.map((c, i) => [c.name, chunkRow(last, last.rowCount - 1, new Array(this.#columns.length).fill(null))[i]])) : null,
    };
  }

  /**
   * Counts matching visible rows. Without a filter this reads only the header. When sorted indexes answer the filter
   * exactly (one condition, or a range on one column), their row count is the answer and no rows are read. Otherwise
   * chunks whose statistics prove every row matches are counted by their row counts without being read, and in the
   * others only the filter's columns are decoded.
   * `onProgress` and `signal` (an AbortSignal) report each chunk and stop the count, as for find(); a count that
   * chunk statistics or indexes answer reads no chunk and reports nothing.
   */
  count(filter, options) {
    const counting = this.#counting(filter, options);
    let step;
    while (!(step = counting.next()).done); // eslint-disable-line no-empty
    return step.value;
  }

  /**
   * count() for async code: other work gets the event loop between chunks, so a long count does not hold up a server,
   * and a signal aborted meanwhile (a Stop button, a timeout) stops it before its next chunk.
   */
  async countAsync(filter, options) {
    const counting = this.#counting(filter, options);
    let step;
    while (!(step = counting.next()).done) await nextTurn();
    return step.value;
  }

  /** count(), yielding between the chunks it reads; returns the count. */
  *#counting(filter, { onProgress, signal } = {}) {
    signal?.throwIfAborted();
    if (filter == null) return this.rowCount;
    const plan = this.#plan(filter);
    if (!plan) return this.rowCount;
    const rowIds = this.#candidates(plan);
    if (rowIds !== null && answeredExactly(plan)) return rowIds.length - this.#deletedAmong(rowIds);
    const whole = this.#wholeChunkTest(plan);
    const wanted = this.#wantedColumns(plan, []);
    const types = this.#filterTypes(plan, []);
    const row = new Array(this.#columns.length).fill(null);
    let n = 0;
    const runs = onProgress ? [...this.#chunkRuns(plan, rowIds)] : this.#chunkRuns(plan, rowIds);
    const watch = onProgress || signal ? { onProgress, signal, total: onProgress ? runs.length : 0, started: 0 } : null;
    for (const { ordinal, from, to } of runs) {
      if (watch) chunkStarts(watch, n);
      if (rowIds === null && whole(ordinal)) {
        n += this.#liveRows(ordinal);
        continue;
      }
      n += this.#countIn(ordinal, from, to, rowIds, plan, wanted, types, row);
      yield NEXT_CHUNK;
    }
    if (watch) chunksDone(watch, n);
    return n;
  }

  /** The matching rows of one chunk (of its candidates `from`..`to`, with index candidates). Kept out of the
   * generator above: V8 optimizes the per-row loop better in a plain method. */
  #countIn(ordinal, from, to, rowIds, plan, wanted, types, row) {
    const chunk = this.#chunk(ordinal, wanted, types);
    const start = this.#rowStart[ordinal];
    const count = rowIds === null ? chunk.rowCount : to - from;
    let n = 0;
    for (let k = 0; k < count; k++) {
      const r = rowIds === null ? k : rowIds[from + k] - start;
      if (chunk.deleted?.has(r)) continue;
      chunkRow(chunk, r, row);
      if (evaluate(plan, row)) n++;
    }
    return n;
  }

  /**
   * Column values as arrays, for charts and totals: far less memory than an object per row. `select` picks the
   * columns (default: every visible one); filter, offset and limit work as in find(). Returns { rowCount, values,
   * nulls }: numbers and dates (as milliseconds) in a Float64Array, bools in a Uint8Array (1 = true), other types in
   * plain arrays (where null stays null). Typed arrays cannot hold null: those rows hold NaN (0 for bools), and
   * `nulls[column]`, present when the column has nulls, is a bitmap with bit i & 7 of byte i >> 3 set for row i.
   * Integers beyond ±2^53 are refused: a Float64Array cannot hold them exactly.
   */
  columnArrays(filter, { select, offset, limit, onProgress, signal } = {}) {
    const names = select ?? this.columns.map((c) => c.name);
    const positions = this.#selection(names);
    const collectors = positions.map((i) => columnCollector(this.#columns[i]));
    let rowCount = 0;
    // Values go from the decoded columns straight into the arrays: no object per row, and no Date per datetime.
    const sink = (columns, from, to) => {
      for (let i = 0; i < positions.length; i++) collectors[i].add(columns[positions[i]], from, to);
      rowCount += to - from;
    };
    const options = { select: names, offset, limit };
    const watch = this.#watch(filter, { offset, onProgress, signal });
    const scan = watch ? this.#watched(this.#find(filter, options, true, sink), watch, () => rowCount) : this.#find(filter, options, false, sink);
    for (const _ of scan); // eslint-disable-line no-unused-vars
    const values = {};
    const nulls = {};
    names.forEach((name, i) => {
      const column = collectors[i].finish();
      setField(values, name, column.values);
      if (column.nulls) setField(nulls, name, column.nulls);
    });
    return { rowCount, values, nulls };
  }

  /**
   * Describes how a filter executes: 'index' (with the candidate row count) or 'scan' (with chunks skipped).
   * With `{ analyze: true }` (and any find() options) it also runs the query and reports what it read: rows,
   * bytesRead, chunksRead, indexPagesRead, columnsDecoded and ms. Indexes and the last chunk this reader already
   * holds are not read again, so analyze a query on a freshly opened reader to see its full cost.
   */
  explain(filter, { analyze = false, ...options } = {}) {
    if (!analyze) return this.#describe(filter);
    const cost = { rows: 0, bytesRead: 0, chunksRead: 0, indexPagesRead: 0, columnsDecoded: 0, ms: 0 };
    const start = performance.now();
    this.#cost = cost;
    try {
      for (const _ of this.find(filter, options)) cost.rows++;
    } finally {
      this.#cost = null;
    }
    cost.ms = performance.now() - start;
    return { ...this.#describe(filter), ...cost };
  }

  /**
   * What a read would cost, known before it starts: from directories, chunk statistics and indexes only, no rows read.
   * `chunks`, `rows` and `bytes` are what find() reads at most (a limit can end it sooner; chunks an `offset` skips
   * whole are left out); `countChunks`, `countRows` and `countBytes` what count() reads (0 when indexes or chunk
   * statistics answer it). `bytes` are the chunks' stored bytes, before decompressing.
   */
  estimate(filter, { offset = 0 } = {}) {
    const plan = this.#plan(filter);
    const rowIds = this.#candidates(plan);
    const whole = this.#wholeChunkTest(plan);
    const counted = !plan || (rowIds !== null && answeredExactly(plan)); // count() needs no chunk
    const result = { chunks: 0, rows: 0, bytes: 0, countChunks: 0, countRows: 0, countBytes: 0 };
    let skipped = 0;
    for (const { ordinal, from, to } of this.#chunkRuns(plan, rowIds)) {
      const live = this.#liveRows(ordinal);
      const rows = rowIds === null ? live : to - from;
      const { length } = this.#span(ordinal);
      // As #plannedChunks: leading chunks an offset skips whole are counted, not read.
      if (!result.chunks && rowIds === null && offset - skipped >= live && whole(ordinal)) skipped += live;
      else {
        result.chunks++;
        result.rows += rows;
        result.bytes += length;
      }
      if (!counted && !(rowIds === null && whole(ordinal))) {
        result.countChunks++;
        result.countRows += rows;
        result.countBytes += length;
      }
    }
    return result;
  }

  #describe(filter) {
    const plan = this.#plan(filter);
    const ids = this.#candidates(plan);
    if (ids !== null) return { strategy: 'index', candidateRows: ids.length };
    const scanned = this.#scanChunks(plan);
    const matching = plan ? Array.from(scanned).filter((i) => this.#mayMatch(plan, i)).length : scanned.length;
    return { strategy: 'scan', chunks: this.#visibleChunks.length, chunksSkipped: this.#visibleChunks.length - matching };
  }

  /**
   * Layout advice, from chunk directories and statistics only (no rows are decoded): how the file is laid out, for
   * each of `columns` how many chunks the rows of one value lie in (and so what reading one value costs), each
   * partition's chunks (access-controlled files), and suggestions: a sortedBy or chunkRows that would make lookups of
   * those columns read less, or partitions that compact({ regroup: true }) would merge.
   */
  advise({ columns = [] } = {}) {
    this.#ensureAllChunks();
    const positions = columns.map((name) => this.#visibleIndex(name, 'advise'));
    this.#ensureStats(new Set(positions));
    const visible = this.#visibleChunks;
    const rows = visible.reduce((n, o) => n + this.#liveRows(o), 0);
    const bytes = visible.reduce((n, o) => n + this.#span(o).length, 0);
    const largest = visible.reduce((n, o) => Math.max(n, this.#rowCount[o]), 0); // close to the chunkRows written with
    const bytesPerChunk = visible.length ? bytes / visible.length : 0;
    const kb = (b) => `${Math.round(b / 1024).toLocaleString('en-US')} KB`;
    const report = {
      rows, chunks: visible.length, rowsPerChunk: visible.length ? Math.round(rows / visible.length) : 0, bytesPerChunk: Math.round(bytesPerChunk),
      sortedBy: this.#table.sortedBy, columns: [], partitions: [], suggestions: [],
    };
    for (const [k, col] of positions.entries()) {
      const name = columns[k];
      const spread = this.#valueSpread(col);
      const distinct = this.#table.sortedBy[0] === name ? null : (this.#index(name, 'sorted')?.keyCount ?? null);
      const rowsPerValue = distinct ? rows / distinct : null;
      // With an index, a lookup reads only the chunks holding the value's rows: never more chunks than it has rows.
      const chunksPerValue = spread === null ? null : rowsPerValue === null ? spread : Math.min(spread, Math.max(1, rowsPerValue));
      report.columns.push({
        column: name, indexed: distinct !== null, chunksPerValue: chunksPerValue === null ? null : Number(chunksPerValue.toFixed(1)),
        bytesPerValue: chunksPerValue === null ? null : Math.round(chunksPerValue * bytesPerChunk), distinctValues: distinct,
      });
      if (chunksPerValue === null) continue;
      if (this.#table.sortedBy[0] !== name && chunksPerValue > Math.max(2, visible.length * 0.1)) {
        const sortedBy = [name, ...this.#table.sortedBy.filter((c) => c !== name)];
        const after = rowsPerValue === null ? 'a few' : `about ${Math.ceil(rowsPerValue / Math.max(1, largest)) + 1}`;
        report.suggestions.push(`The rows of one '${name}' value lie in about ${chunksPerValue.toFixed(1)} of ${visible.length} chunks: `
          + `a lookup reads about ${kb(chunksPerValue * bytesPerChunk)}. Writing the file with sortedBy: ${JSON.stringify(sortedBy)} `
          + `would put them in ${after} chunks.`);
      }
      // In access-controlled files, chunks follow partitions: the largest chunk says nothing about chunkRows.
      if (!this.#access && rowsPerValue !== null && rowsPerValue * 4 < largest) {
        const smaller = Math.max(256, 2 ** Math.ceil(Math.log2(rowsPerValue * 2)));
        if (smaller < largest) {
          report.suggestions.push(`One '${name}' value has about ${Math.round(rowsPerValue).toLocaleString('en-US')} rows, and a chunk holds `
            + `${largest.toLocaleString('en-US')}: chunkRows: ${smaller} would cut the chunk data a lookup reads to about `
            + `${kb(bytesPerChunk * (smaller / largest) * 2)} (files grow a little: smaller chunks compress slightly less well).`);
        }
      }
    }
    if (this.#access) {
      const names = this.#access.isOwner
        ? new Map(this.#ownerDirectory().partitions.map((n) => [this.#access.secrets.partitionId(n), n]))
        : new Map(Object.entries(this.#access.partitionNames));
      const scattered = [];
      for (const [id, partition] of this.#partitions) {
        const ordinals = partition.ordinals.filter((o) => this.#loaded[o]).sort((x, y) => x - y);
        if (!ordinals.length) continue;
        const partRows = ordinals.reduce((n, o) => n + this.#liveRows(o), 0);
        const entry = { partition: names.get(id) ?? id, chunks: ordinals.length, rows: partRows };
        report.partitions.push(entry);
        // Appends put each partition's new rows after everyone else's: its chunks end up apart, in many places.
        const places = ordinals.filter((o, i) => i === 0 || o !== ordinals[i - 1] + 1).length;
        if (places > 2) scattered.push(entry);
      }
      if (scattered.length) {
        const { partitionBy, sortedBy } = this.#table;
        const regroup = !sortedBy.length || sortedBy[0] === partitionBy
          ? "compact({ regroup: true }) puts each partition's rows together (and write() with regroup: true writes them so)."
          : `compact({ regroup: true }) would put each partition's rows together, but needs a file without sortedBy, or sorted by '${partitionBy}' first.`;
        report.suggestions.push(`${scattered.length} of ${report.partitions.length} partitions are spread through the file in separate chunks `
          + `(for example '${scattered[0].partition}': ${scattered[0].rows} rows in ${scattered[0].chunks} chunks): ${regroup}`);
      }
    }
    return report;
  }

  /**
   * About how many chunks the rows of one value of a column lie in: at each chunk's smallest value, the number of
   * chunks whose statistics range holds it, averaged. Null without statistics.
   */
  #valueSpread(col) {
    const ranges = [];
    for (const o of this.#visibleChunks) {
      const s = this.#statAt(col, o);
      if (s && s.nulls < this.#rowCount[o]) ranges.push({ min: s.min, max: s.max });
    }
    if (!ranges.length) return null;
    const mins = ranges.map((r) => r.min).filter((v) => v !== undefined).sort(compareKeys);
    const maxs = ranges.map((r) => r.max).filter((v) => v !== undefined).sort(compareKeys);
    const openLow = ranges.length - mins.length; // ranges with no lower bound hold every value from below
    const count = (sorted, test) => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (test(sorted[mid])) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let total = 0;
    for (const value of mins) {
      const startedBy = count(mins, (v) => compareKeys(v, value) <= 0) + openLow;
      const endedBefore = count(maxs, (v) => compareKeys(v, value) < 0);
      total += startedBy - endedBefore;
    }
    return mins.length ? total / mins.length : ranges.length;
  }

  /** Releases the file. Safe to call more than once. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#access?.reopen?.delete(this.#reopen);
    this.#ahead?.pool?.close();
    this.#ahead = null;
    release(this.#source);
    this.#cachedChunk = { ordinal: -1, wanted: null, types: null, chunk: null };
    this.#indexes.clear();
  }

  [Symbol.iterator]() {
    return this.rows();
  }
}

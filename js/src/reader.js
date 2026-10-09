// Reads JAZMIN format 1.0 files (docs/rfc/draft-jazmin-format-03.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  FileSecrets, digest, findKeySlotPage, headerKey, ownerDirectoryKey, parseKeySlots, partKey, partitionName, sectionKeyFrom, unsealSlot,
  verifyOwner,
} from './access.js';
import { crc32, parseJsonText } from './binary.js';
import {
  decodeChunkDirectoryLists, decodeChunkMap, decodeColumnDefinitions, decodeDelta, decodeHeader, decodeIndexDirectory, decodeOwnerCatalog, joinChunkMaps,
  decodePartitionTable, decodeStatistics, findPartitions,
} from './catalog.js';
import { decodeColumnar } from './columnar.js';
import {
  CODEC, DRAFT_MAGIC, ENVELOPE_SIZE, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, KEYRING_GROUPS,
  INDEX_DELTAS, KNOWN_FLAGS, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, SUPPORTED_READER_FEATURES, TRAILER_SIZE, WHOLE_TABLE,
} from './constants.js';
import { JazminFormatError, JazminKeyError, JazminValidationError } from './errors.js';
import { enforceExpiry, toMs } from './expiry.js';
import { EVERYONE, readActions } from './files.js';
import { answeredExactly, evaluate, filterReads, indexPlan, mayMatch, mustMatch, normalizeFilter } from './filter.js';
import { CompositeIndex, LazyTrigramIndex, PagedSortedIndex, TrigramIndex, decodePostingsSection } from './indexes.js';
import { JazminAccessKey, JazminKey, KeySchedule, deriveFromPassword, hkdf, parseAnyKey, parseUnlockToken, slotId } from './keys.js';
import { checkPriority, readThreads } from './priority.js';
import { setField } from './schema.js';
import { SectionPool } from './section-pool.js';
import { decodeSection, sectionPayloadLength } from './section.js';
import { decodeBound } from './stats.js';
import { compareKeys } from './types.js';


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

const NEXT_CHUNK = Symbol('jazmin.nextChunk'); // yielded by internal scans before each chunk is read (findAsync)
const READ_AHEAD = 2; // chunks read ahead by findAsync
const SMALL_LOOKUP_BYTES = 8 * 1024; // index lookups this small are always made: the bytes are negligible, and rows are not decoded
/**
 * What an owner's index lookup may cost (bytes of index pages) to be made before reading every partition: the
 * alternative reads at least a section per partition (chunk directories, statistics).
 */
const ownerLookupBudget = (partitions) => SMALL_LOOKUP_BYTES * Math.max(1, partitions);
// Many catalog sections read together (an owner's chunk directories and statistics: one per partition) are read in
// ranges: from READ_AHEAD_SECTIONS sections, those at most READ_AHEAD_GAP apart share a read of at most READ_AHEAD_MAX
// bytes. A read is a system call; the gaps are other small catalog sections.
const READ_AHEAD_SECTIONS = 16;
const READ_AHEAD_GAP = 4 * 1024;
const READ_AHEAD_MAX = 8 * 1024 * 1024;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve)); // lets timers and I/O callbacks run

/** Internal: openTable() passes this as the source, with the reader it shares the open file with. */
const SHARED = Symbol('jazmin.shared');
/** Internal: the priority a reader was opened with ('memory', 'balanced' or 'speed'), for exports that batch. */
export const READ_PRIORITY = Symbol('jazmin.readPriority');

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
function openSource(source) {
  if (source?.[SOURCE]) return source;
  if (typeof source === 'string') {
    const fd = fs.openSync(source, 'r');
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
    for (const b of c.blocks) ok(b && count(b.offset) && count(b.length) && (b.digest === undefined || typeof b.digest === 'string'));
  }
  for (const f of d.files) {
    ok(f && typeof f.path === 'string' && typeof f.type === 'string' && count(f.content));
    ok(f.groups === undefined || (Array.isArray(f.groups) && f.groups.every((g) => typeof g === 'string')));
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
  #partDigest = null; // access-controlled files
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
  // The last chunk decoded, the columns decoded (null: all) and the definitions they were decoded with.
  #cachedChunk = { ordinal: -1, wanted: null, types: null, chunk: null };
  #sortStatsComplete; // computed on first sorted scan
  #flags = 0;
  #deleted = []; // sorted row ids removed by appends
  #deletedVisible; // computed on first use
  #validEnd = 0; // end of the trailer in use (an interrupted append may have left bytes after it)
  #headerRef = null; // where the header section is ({ offset, length }), from the trailer
  #recovered = false;
  #closed = false;
  #readOptions;
  #makers = new Map(); // selected column indexes -> row-object builder
  #fileIndex = null; // embedded files visible to this key: { entries: Map(path -> entry), contents: Map(id -> content) }
  #scratch = Buffer.alloc(0); // file-read buffer reused across chunks (see #readChunk)
  #ahead = null; // priority 'speed': { pool, ordinals } - chunks being decoded on worker threads, in the order submitted
  #aheadBuffer = Buffer.alloc(0); // file-read buffer of chunks read ahead (the pool copies what it is given)
  #cost = null; // while explain({ analyze: true }) runs a query: what it reads (see QueryCost in index.d.ts)

  /**
   * options: key | password; for online access keys `unlockToken` (from the owner's key service);
   * `now` (Date / ms, default the system clock) and `accessState` ({ dir } | custom store | false)
   * for expiring keys - see enforceExpiry; `table`: the name of the table to read (default: the first).
   */
  constructor(source, { key, password, unlockToken, now, accessState, table, priority = 'balanced', [SHARED]: from } = {}) {
    if (source === SHARED) {
      this.#share(from, table);
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
    this.#source.refs = (this.#source.refs ?? 1) + 1;
    this.#readOptions = { ...from.#readOptions, table };
    this.#header = from.#header;
    this.#metadata = from.#metadata;
    this.#fileId = from.#fileId;
    this.#salt = from.#salt;
    this.#keys = from.#keys;
    this.#access = from.#access;
    this.#flags = from.#flags;
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
      keySecret: secret,
      directory: null,
      keySlots: { ...trailer.keySlots, section: slotsSection },
    };
    return decodeSection(headerSection, { key: headerKey(b(bundle.header), this.#salt), fileId: this.#fileId, sectionId: 'header' });
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
   * and read now.
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
    if (!this.#access?.isOwner) this.#ensureAllChunks(); // one partition, or only this key's own
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
            this.#partDigest ??= new Array(this.#loaded.length * g);
            for (let k = 0; k < g; k++) this.#partDigest[o * g + k] = d.digests.subarray((i * g + k) * 32, (i * g + k + 1) * 32);
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
    return { offset: this.#partOffset[k], length: this.#partLength[k], ...(this.#partDigest ? { digest: this.#partDigest[k] } : {}) };
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
    }
    if (isOwner) {
      info.grants = this.#ownerDirectory().grants.map((g) => ({
        keyId: this.#grantKey(g.key).id, rows: g.rows, columns: g.columns, ...(g.label === undefined ? {} : { label: g.label }),
        mode: g.mode ?? 'offline',
        ...(g.expires ? { expires: g.expires } : {}),
      }));
      info.groupColumns = Object.fromEntries(this.#groups.map((g) => [g.name, g.cols.map((i) => this.#columns[i].name)]));
    }
    return info;
  }

  // ---- embedded files (spec 6.8) ---------------------------------------------------------------

  /** Loads the file directories this key can open, merged by path (once). */
  #files() {
    if (this.#fileIndex) return this.#fileIndex;
    const index = { entries: new Map(), contents: new Map() };
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
        for (const f of directory.files) {
          const known = index.entries.get(f.path);
          const groups = f.groups ?? (ownerNames ? [ownerNames.get(dir.group)] : undefined);
          if (known) {
            if (known.groups && groups) known.groups = [...new Set([...known.groups, ...groups])].sort();
          } else {
            const actions = readActions(f.actions);
            index.entries.set(f.path, { path: f.path, type: f.type, content: f.content, ...(groups ? { groups } : {}), ...(actions ? { actions } : {}) });
          }
        }
      }
      for (const e of index.entries.values()) {
        if (!index.contents.has(e.content)) throw new JazminFormatError(`Embedded file '${e.path}' refers to missing content`);
        if (e.groups?.includes(EVERYONE)) e.groups = [EVERYONE];
      }
    }
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
      };
    });
  }

  /** Package settings for viewers ({ entry, title, allowedOrigins, allowWasm }), or undefined. */
  get package() {
    const settings = this.#header.files?.package;
    return settings ? parseJsonText(settings, 'Package settings', true) : undefined;
  }

  #fileContent(path) {
    const { entries, contents } = this.#files();
    const entry = entries.get(path);
    if (!entry) throw new JazminValidationError(`No file '${path}' is visible with this key`);
    return contents.get(entry.content);
  }

  #fileBlock(content, b) {
    const block = content.blocks[b];
    const sectionId = `file/${content.id}/${b}`;
    if (!content.key && (this.#keys || this.#access)) throw new JazminFormatError(`Embedded content ${content.id} has no key in an encrypted file`);
    const key = content.key ? hkdf(Buffer.from(content.key, 'base64'), this.#salt, `JAZMIN/1/${sectionId}`) : undefined;
    const bytes = this.#read(block, sectionId, key);
    if (bytes.length !== Math.min(content.blockSize, content.size - b * content.blockSize)) {
      throw new JazminFormatError(`Section '${sectionId}' has the wrong length for its embedded file`);
    }
    return bytes;
  }

  /** Reads a whole embedded file (checked against its SHA-256). */
  readFile(path) {
    const content = this.#fileContent(path);
    const bytes = Buffer.concat(content.blocks.map((_, b) => this.#fileBlock(content, b)));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== content.sha256) {
      throw new JazminFormatError(`File '${path}' does not match its SHA-256`);
    }
    return bytes;
  }

  /** Reads bytes [start, end) of an embedded file, decoding only the blocks involved. */
  readFileRange(path, start = 0, end) {
    const content = this.#fileContent(path);
    const stop = Math.min(end ?? content.size, content.size);
    if (!Number.isInteger(start) || start < 0 || start > stop) throw new JazminValidationError('Invalid file range');
    const size = content.blockSize;
    const parts = [];
    for (let b = Math.floor(start / size); b * size < stop; b++) {
      const block = this.#fileBlock(content, b);
      parts.push(block.subarray(Math.max(0, start - b * size), Math.min(block.length, stop - b * size)));
    }
    return Buffer.concat(parts);
  }

  /** Streams an embedded file block by block (bounded memory); the stream errors if the SHA-256 does not match. */
  openFile(path) {
    const content = this.#fileContent(path);
    const read = (b) => this.#fileBlock(content, b);
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
    return {
      entries: [...entries.values()].map((e) => ({ ...e, groups: e.groups ?? [EVERYONE] })),
      contents: [...contents.values()],
      nextId: this.#header.files.nextContent,
      package: this.package,
    };
  }

  /** Owner only: grants including access keys, used by update() to re-issue them. */
  get [OWNER_GRANTS]() {
    if (!this.#access?.isOwner) return null;
    const columnGroups = Object.fromEntries(this.#groups.map((g) => [g.name, g.cols.map((i) => this.#columns[i].name)]));
    // Each grant with its key parsed (accessKey: its id is worked out when first asked for), so callers need not parse
    // every key again.
    const grants = this.#ownerDirectory().grants.map((g) => ({ ...g, accessKey: this.#grantKey(g.key) }));
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
   * Streams visible rows matching a filter, in row order.
   * Uses indexes to read only candidate chunks; otherwise scans chunks, skipping
   * those whose statistics prove they cannot match.
   */
  find(filter, options) {
    return this.#find(filter, options, false);
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
    const scan = this.#find(filter, options, true);
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
    const planned = this.#plannedChunks(filter, options?.offset ?? 0);
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
   * scan's chunks, less one chunk (an index answer still reads at least one). Rows are kept only in the chunks a
   * scan would read (a sort range, a pinned partition, chunk statistics): nowhere else can a row match.
   */
  #candidates(plan) {
    if (!plan) return null;
    const scan = this.#scanList(plan);
    let scanBytes = 0;
    let smallest = Infinity;
    for (const ordinal of scan) {
      const { length } = this.#span(ordinal);
      scanBytes += length;
      smallest = Math.min(smallest, length);
    }
    const lookup = indexPlan(plan, this.#indexProvider, Math.max(scan.length ? scanBytes - smallest : 0, SMALL_LOOKUP_BYTES));
    if (!lookup) return null;
    const inScan = new Uint8Array(this.#rowCount.length);
    for (const ordinal of scan) inScan[ordinal] = 1;
    return lookup.rows().filter((rowId) => {
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
  #plannedChunks(filter, offset = 0) {
    const plan = this.#plan(filter);
    const rowIds = this.#candidates(plan);
    const whole = this.#wholeChunkTest(plan);
    const ordinals = [];
    let skipped = 0;
    for (const { ordinal } of this.#chunkRuns(plan, rowIds)) {
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
  *#find(filter, { select, limit = Infinity, offset = 0 } = {}, ticks, sink) {
    const plan = this.#plan(filter);
    const selection = this.#selection(select);
    const singleGroup = !this.#access;
    const rowIds = this.#candidates(plan);
    if (singleGroup && plan) {
      // Decode only the filter's and the selected columns, of the chunks the index candidates (or the scan) name.
      yield* this.#scanColumns(plan, selection, offset, limit, ticks, rowIds, sink);
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
      for (const ordinal of this.#decodeAhead(this.#visibleChunks, (o) => o, wanted)) {
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
    for (const item of this.#iterate(plan, offset, limit, ticks, wanted, rowIds, sink)) yield item === NEXT_CHUNK ? item : make(item[1]);
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
  *#scanColumns(plan, selection, offset, limit, ticks, rowIds, sink) {
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
    let skipped = 0;
    let yielded = 0;
    let deleted = 0;
    for (const { ordinal, from, to } of this.#decodeAhead(this.#chunkRuns(plan, rowIds), (run) => run.ordinal, wanted)) {
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
      if (!plan) columns = this.#decodeChunk(ordinal, wanted, sink !== undefined); // filters compare dates as milliseconds
      else {
        const raw = this.#readChunk(ordinal);
        const rowCount = this.#rowCount[ordinal];
        columns = decodeColumnar(raw, filterTypes, rowCount, ordinal, filterCols, sink !== undefined);
        matches = new Uint8Array(rowCount);
        let any = false;
        for (let k = 0; k < count; k++) {
          const r = rowIds === null ? k : rowIds[from + k] - start;
          for (const c of filterAt) row[c] = columns[c][r];
          if (evaluate(plan, row)) any = matches[r] = 1;
        }
        if (any && restCount) {
          const more = decodeColumnar(raw, this.#streamTypes, rowCount, ordinal, rest, sink !== undefined, matches);
          for (let c = 0; c < more.length; c++) if (rest[c]) columns[c] = more[c];
        }
        if (this.#cost) {
          this.#cost.chunksRead++;
          this.#cost.columnsDecoded += filterAt.length + (any ? restCount : 0);
        }
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
  *#iterate(plan, offset, limit, ticks, wanted, rowIds, sink) {
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
    for (const { ordinal, from, to } of this.#chunkRuns(plan, rowIds)) {
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

  /** The sections of this reader's table, for KEY_ROTATION: `add(ref, sectionId, keyring group)`. */
  #tableSections(add) {
    const t = this.#tableIndex;
    const table = this.#table;
    const { data, index } = KEYRING_GROUPS;
    if (table.columnGroups.some((g) => g.definitions)) throw new JazminFormatError('Catalog: only access-controlled files keep column definitions in their own section');
    if (table.partitionTable) add(table.partitionTable, `${t}/partitions`, data);
    if (table.deletes) add(table.deletes, `${t}/deletes/${table.deletedCount}`, data);
    this.#ensureAllChunks();
    for (const [id, p] of this.#partitions) p.segments.forEach((ref, s) => add(ref, `${t}/dir/${id}${s ? `/${s}` : ''}`, data));
    for (const segment of this.#segments) {
      segment.statistics.forEach((block, b) => add(block.section, `${t}/stats/${segment.partition}/${b}${segment.suffix}`, data));
    }
    for (let o = 0; o < this.#loaded.length; o++) {
      if (!this.#loaded[o]) throw new JazminFormatError(`Chunk ${o} is in no chunk directory`);
      this.#groups.forEach((group, g) => add(this.#part(o, g), `${t}/chunk/${o}/${group.name}`, data));
    }
    for (const ix of this.#indexList()) {
      const base = `${t}/index/${ix.column}/${ix.kind}${ix.segment ? `/${ix.segment}` : ''}`;
      add(ix.section, base, index);
      if (ix.kind !== 'sorted') continue;
      const directory = decodeIndexDirectory(this.#read(ix.section, base, this.#keys.sectionKey(index, base)));
      directory.pages.forEach((page, n) => add(page, `${base}/page/${n}`, index));
      if (directory.nulls) add(directory.nulls, `${base}/nulls`, index);
    }
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
    if (this.#table.sortedBy.length && this.#table.chunkCount > 0) {
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
   */
  count(filter) {
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
    for (const { ordinal, from, to } of this.#chunkRuns(plan, rowIds)) {
      if (rowIds === null && whole(ordinal)) {
        n += this.#liveRows(ordinal);
        continue;
      }
      const chunk = this.#chunk(ordinal, wanted, types);
      const start = this.#rowStart[ordinal];
      const count = rowIds === null ? chunk.rowCount : to - from;
      for (let k = 0; k < count; k++) {
        const r = rowIds === null ? k : rowIds[from + k] - start;
        if (chunk.deleted?.has(r)) continue;
        chunkRow(chunk, r, row);
        if (evaluate(plan, row)) n++;
      }
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
  columnArrays(filter, { select, offset, limit } = {}) {
    const names = select ?? this.columns.map((c) => c.name);
    const positions = this.#selection(names);
    const collectors = positions.map((i) => columnCollector(this.#columns[i]));
    let rowCount = 0;
    // Values go from the decoded columns straight into the arrays: no object per row, and no Date per datetime.
    const sink = (columns, from, to) => {
      for (let i = 0; i < positions.length; i++) collectors[i].add(columns[positions[i]], from, to);
      rowCount += to - from;
    };
    for (const _ of this.#find(filter, { select: names, offset, limit }, false, sink)); // eslint-disable-line no-unused-vars
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
          ? "compact({ regroup: true }) puts each partition's rows together."
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

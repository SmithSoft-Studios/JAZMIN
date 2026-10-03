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
  decodeChunkDirectoryLists, decodeColumnDefinitions, decodeDelta, decodeHeader, decodeIndexDirectory, decodeOwnerCatalog,
  decodePartitionTable, decodeStatistics, findPartitions,
} from './catalog.js';
import { decodeColumnar } from './columnar.js';
import {
  CODEC, DRAFT_MAGIC, ENVELOPE_SIZE, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, KEYRING_GROUPS,
  KNOWN_FLAGS, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, SUPPORTED_READER_FEATURES, TRAILER_SIZE, WHOLE_TABLE,
} from './constants.js';
import { JazminFormatError, JazminKeyError, JazminValidationError } from './errors.js';
import { enforceExpiry, toMs } from './expiry.js';
import { EVERYONE } from './files.js';
import { candidates, evaluate, mayMatch, normalizeFilter } from './filter.js';
import { CompositeIndex, PagedSortedIndex, TrigramIndex, decodePostingsSection } from './indexes.js';
import { JazminAccessKey, KeySchedule, deriveFromPassword, hkdf, parseAnyKey, parseUnlockToken, slotId } from './keys.js';
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
 * Partition names a filter pins the partition column to (top-level AND of eq / in / isNull:true),
 * or null when the filter does not restrict the column to exact values.
 */
function partitionLookup(plan, col) {
  if (col < 0) return null;
  const leaves = plan.kind === 'and' ? plan.items : [plan];
  for (const leaf of leaves) {
    if (leaf.kind !== 'leaf' || leaf.col !== col) continue;
    if (leaf.op === 'eq') return [partitionName(leaf.value)];
    if (leaf.op === 'in') return leaf.value.map((v) => partitionName(v));
    if (leaf.op === 'isNull' && leaf.value) return [''];
  }
  return null;
}

/** Internal: state the appender needs to continue an existing file (see append.js). */
export const APPEND_STATE = Symbol('jazmin.appendState');

/** Internal: yields [rowId, row object] for visible, non-deleted rows matching a filter. */
export const ROWS_WITH_IDS = Symbol('jazmin.rowsWithIds');

/** Internal: lets update() carry an access-controlled file's grants into its next version. */
export const OWNER_GRANTS = Symbol('jazmin.ownerGrants');

/** Internal: lets update() and append() carry a file's embedded files into its next version. */
export const FILE_STATE = Symbol('jazmin.fileState');

const NEXT_CHUNK = Symbol('jazmin.nextChunk'); // yielded by internal scans before each chunk is read (findAsync)
const READ_AHEAD = 2; // chunks read ahead by findAsync
const nextTurn = () => new Promise((resolve) => setImmediate(resolve)); // lets timers and I/O callbacks run

/** Internal: openTable() passes this as the source, with the reader it shares the open file with. */
const SHARED = Symbol('jazmin.shared');

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
 * Builds a function that turns a row array into an object. Creating every object with one literal
 * gives V8 a single object shape, which is markedly faster than adding properties one by one.
 * Falls back to plain assignment where code generation is disabled or a name needs it.
 */
function objectMaker(names, indexes) {
  const assign = (row) => {
    const out = {};
    for (let k = 0; k < names.length; k++) out[names[k]] = row[indexes[k]];
    return out;
  };
  if (names.includes('__proto__')) return assign; // a literal would set the prototype instead of a property
  try {
    return new Function('row', `return { ${names.map((n, k) => `${JSON.stringify(n)}: row[${indexes[k]}]`).join(', ')} };`);
  } catch {
    return assign; // e.g. node --disallow-code-generation-from-strings
  }
}

/**
 * Builds a function turning row `r` of decoded column arrays into an object with the selected columns.
 * Objects are built one at a time as rows are consumed, so a chunk's rows are never all alive at once.
 * Returns null where code generation is disabled or a name needs special handling.
 */
function columnsToObject(columns, select) {
  if (select.some((i) => columns[i].name === '__proto__')) return null;
  const object = select.map((i) => `${JSON.stringify(columns[i].name)}: c[${i}][r]`).join(', ');
  try {
    return new Function('c', 'r', `return { ${object} };`);
  } catch {
    return null;
  }
}

/** Public form of a catalog column definition. */
function publicColumn(c) {
  return {
    name: c.name,
    type: c.type,
    nullable: !c.required,
    ...(c.description ? { description: c.description } : {}),
    ...(c.attributes ? { attributes: parseJsonText(c.attributes, `Column '${c.name}' attributes`) } : {}),
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
  #indexRefs = null;
  #indexes = new Map();
  #cachedChunk = { ordinal: -1, rows: null };
  #sortStatsComplete; // computed on first sorted scan
  #flags = 0;
  #deleted = []; // sorted row ids removed by appends
  #deletedVisible; // computed on first use
  #validEnd = 0; // end of the trailer in use (an interrupted append may have left bytes after it)
  #recovered = false;
  #closed = false;
  #readOptions;
  #makers = new Map(); // selected column indexes -> row-object builder
  #fileIndex = null; // embedded files visible to this key: { entries: Map(path -> entry), contents: Map(id -> content) }
  #scratch = Buffer.alloc(0); // file-read buffer reused across chunks (see #readChunk)

  /**
   * options: key | password; for online access keys `unlockToken` (from the owner's key service);
   * `now` (Date / ms, default the system clock) and `accessState` ({ dir } | custom store | false)
   * for expiring keys - see enforceExpiry; `table`: the name of the table to read (default: the first).
   */
  constructor(source, { key, password, unlockToken, now, accessState, table, [SHARED]: from } = {}) {
    if (source === SHARED) {
      this.#share(from, table);
      return;
    }
    this.#readOptions = { unlockToken, now, accessState, table };
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
    this.#metadata = header.metadata ? parseJsonText(header.metadata, 'Metadata') : {};
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

  /** Loads the chunk directories of these partitions (id texts). */
  #ensurePartitions(ids) {
    this.#lookupPartitions(ids);
    const g = this.#groups.length;
    const added = [];
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
    if (added.length === 0) return;
    let count = 0;
    for (let o = 0; o < this.#loaded.length; o++) count += this.#loaded[o];
    this.#visibleChunks = new Int32Array(count);
    for (let o = 0, i = 0; o < this.#loaded.length; o++) if (this.#loaded[o]) this.#visibleChunks[i++] = o;
    this.#sortStatsComplete = undefined;
    if (this.#statCols.size) this.#loadStats(this.#statCols, added);
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

  #mayMatch(plan, ordinal) {
    this.#statOrdinal = ordinal;
    return mayMatch(plan, this.#statLookup, this.#rowCount[ordinal]);
  }

  /** Loads the statistics of these columns for every loaded segment (spec 6.4), one array set per column. */
  #ensureStats(cols) {
    const missing = new Set([...cols].filter((c) => c >= 0 && !this.#statCols.has(c)));
    if (missing.size === 0) return; // segments loaded later get these columns' statistics as they load
    for (const col of missing) this.#statCols.add(col);
    this.#loadStats(missing, this.#segments);
  }

  #loadStats(cols, segments) {
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
      this.#access.directory = parseJsonText(this.#access.directoryText, 'The owner directory');
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
  get appendCount() {
    return this.#header.appendCount;
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
    const sectionId = 'owner/catalog';
    return decodeOwnerCatalog(this.#read(this.#header.access.ownerCatalog, sectionId, sectionKeyFrom(this.#access.secrets.owner, this.#salt, sectionId)));
  }

  /** Names of the file's tables, in order (spec 6.2). */
  get tables() {
    return this.#header.tables.map((t) => t.name);
  }

  /** Name of the table this reader reads. */
  get table() {
    return this.#table.name;
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
   *   { isOwner, partitionBy, columnGroups, visiblePartitions, visibleColumnGroups, grants? }
   * `grants` (owner only) lists who can see what, without any secrets.
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
      info.online = this.#access.online;
      if (this.#access.expires) info.expires = this.#access.expires;
    }
    if (isOwner) {
      info.grants = this.#ownerDirectory().grants.map((g) => ({
        keyId: JazminAccessKey.parse(g.key).id, rows: g.rows, columns: g.columns, ...(g.label === undefined ? {} : { label: g.label }),
        mode: g.mode ?? 'offline',
        ...(g.expires ? { expires: g.expires } : {}),
      }));
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
        const directory = checkFileDirectory(parseJsonText(this.#read(dir.section, sectionId, key).toString('utf8'), 'An embedded-file directory'));
        for (const c of directory.contents) index.contents.set(c.id, c);
        for (const f of directory.files) {
          const known = index.entries.get(f.path);
          const groups = f.groups ?? (ownerNames ? [ownerNames.get(dir.group)] : undefined);
          if (known) {
            if (known.groups && groups) known.groups = [...new Set([...known.groups, ...groups])].sort();
          } else {
            index.entries.set(f.path, { path: f.path, type: f.type, content: f.content, ...(groups ? { groups } : {}) });
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

  /** Embedded files this key can see: [{ path, type, size, sha256, groups? }] (groups for the owner / single-key files). */
  get files() {
    const { entries, contents } = this.#files();
    return [...entries.values()].map((e) => {
      const c = contents.get(e.content);
      return { path: e.path, type: e.type, size: c.size, sha256: c.sha256, ...(e.groups ? { groups: [...e.groups] } : {}) };
    });
  }

  /** Package settings for viewers ({ entry, title, allowedOrigins, allowWasm }), or undefined. */
  get package() {
    const settings = this.#header.files?.package;
    return settings ? parseJsonText(settings, 'Package settings') : undefined;
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
    return { partitionBy: this.#table.partitionBy || undefined, columnGroups, grants: this.#ownerDirectory().grants };
  }

  /** Reads and decodes a section by reference, checking its digest when it has one (spec 7.6.5). */
  #read(ref, sectionId, key, scratch) {
    if (!(ref.length >= ENVELOPE_SIZE)) throw new JazminFormatError(`Section '${sectionId}' is truncated`);
    const section = this.#source.read(ref.offset, ref.length, scratch);
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
    if (this.#scratch.length < part.length) this.#scratch = Buffer.allocUnsafeSlow(Math.ceil(part.length * 1.25));
    const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${this.#groups[0].name}`;
    return this.#read(part, sectionId, this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId), this.#scratch);
  }

  #chunkRows(ordinal) {
    if (this.#cachedChunk.ordinal === ordinal) return this.#cachedChunk.rows;
    const width = this.#columns.length;
    const rowCount = this.#rowCount[ordinal];
    // Made after a part is decoded: decodeColumnar checks the directory's row count against the part's size.
    let rows = null;
    const newRows = () => {
      const out = new Array(rowCount);
      for (let r = 0; r < rowCount; r++) out[r] = new Array(width).fill(null);
      return out;
    };
    const partitionSecret = this.#access ? this.#partitionSecret(this.#chunkPartition[ordinal]) : null;
    if (this.#access && !partitionSecret) throw new JazminKeyError(`Chunk ${ordinal} is not visible with this key`);
    this.#groups.forEach((group, g) => {
      if (!group.visible) return; // column group not granted: its columns stay hidden
      const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${group.name}`;
      const key = this.#access
        ? partKey(partitionSecret, this.#columnSecret(group.name), this.#salt, sectionId)
        : this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId);
      const raw = this.#read(this.#part(ordinal, g), sectionId, key);
      const columns = decodeColumnar(raw, group.cols.map((c) => this.#types[c]), rowCount, ordinal);
      rows ??= newRows();
      group.cols.forEach((col, j) => {
        const values = columns[j];
        for (let r = 0; r < rowCount; r++) rows[r][col] = values[r];
      });
    });
    rows ??= newRows();
    // Deleted rows become null and are skipped by every read path.
    const start = this.#rowStart[ordinal];
    for (let i = lowerBound(this.#deleted, start); i < this.#deleted.length && this.#deleted[i] < start + rows.length; i++) {
      rows[this.#deleted[i] - start] = null;
    }
    this.#cachedChunk = { ordinal, rows };
    return rows;
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
      const read = (sectionId, ref) => this.#read(ref, sectionId, this.#catalogKey(sectionId, this.#access?.secrets.owner, KEYRING_GROUPS.index));
      // One segment for the original rows plus one per append (section id suffix "/<segment>").
      const parts = descriptors.map((ix) => {
        const sectionId = `${this.#tableIndex}/index/${column}/${kind}${ix.segment ? `/${ix.segment}` : ''}`;
        if (kind === 'trigram') return TrigramIndex.decode(read(sectionId, ix.section));
        // Only the directory is read now; pages are read (and a few kept) as lookups need them.
        return new PagedSortedIndex(decodeIndexDirectory(read(sectionId, ix.section)), type, (part, ref) => read(`${sectionId}/${part}`, ref));
      });
      index = parts.length === 1 ? parts[0] : new CompositeIndex(parts);
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
    if (names && this.#access.isOwner && !this.#allLoaded) this.#ensurePartitions(names.map((n) => this.#access.secrets.partitionId(n)));
    else this.#ensureAllChunks();
    const cols = new Set();
    (function collect(node) {
      if (node.kind === 'leaf') cols.add(node.col);
      else (node.items ?? [node.item]).forEach(collect);
    })(plan);
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
    this.#ensureAllChunks();
    const ordinal = this.#chunkOrdinalFor(rowId);
    if (!this.#isVisibleChunk(ordinal) || this.#visibleCols.length === 0) throw new JazminKeyError(`Row ${rowId} is not visible with this key`);
    const row = this.#chunkRows(ordinal)[rowId - this.#rowStart[ordinal]];
    if (row === null) throw new JazminValidationError(`Row ${rowId} was deleted`);
    return this.#toObject(row, this.#visibleCols);
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
    const planned = this.#plannedChunks(filter);
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

  /** The chunks a query reads, in the order it reads them (for reading ahead). */
  #plannedChunks(filter) {
    const plan = this.#plan(filter);
    if (!plan) return [...this.#visibleChunks];
    const rowIds = candidates(plan, { get: (column, kind) => this.#index(column, kind) });
    if (rowIds === null) return Array.from(this.#scanChunks(plan)).filter((o) => this.#mayMatch(plan, o));
    const ordinals = [];
    for (const rowId of rowIds) {
      const ordinal = this.#chunkOrdinalFor(rowId);
      if (ordinal !== ordinals[ordinals.length - 1] && this.#isVisibleChunk(ordinal)) ordinals.push(ordinal);
    }
    return ordinals;
  }

  /** find(); with `ticks`, NEXT_CHUNK is yielded before each chunk is read (for findAsync). */
  *#find(filter, { select, limit = Infinity, offset = 0 } = {}, ticks) {
    const plan = this.#plan(filter);
    const selection = this.#selection(select);
    const singleGroup = !this.#access;
    if (singleGroup && plan) {
      const rowIds = candidates(plan, { get: (column, kind) => this.#index(column, kind) });
      if (rowIds === null) {
        // No index narrows the rows: decode only the filter's and the selected columns of each chunk.
        yield* this.#scanColumns(plan, selection, offset, limit, ticks);
        return;
      }
    }
    const decode = singleGroup && !plan && offset === 0 ? this.#directDecoder(selection) : null;
    if (decode) {
      const wanted = this.#columns.map((_, i) => selection.includes(i)); // skip unselected columns
      // Full scan: each chunk's columns are decoded and rows built from them one at a time.
      let yielded = 0;
      let deleted = 0;
      for (const ordinal of this.#visibleChunks) {
        const rowCount = this.#rowCount[ordinal];
        if (ticks) yield NEXT_CHUNK;
        const columns = decodeColumnar(this.#readChunk(ordinal), this.#types, rowCount, ordinal, wanted);
        for (let r = 0; r < rowCount; r++) {
          if (yielded >= limit) return;
          const rowId = this.#rowStart[ordinal] + r;
          while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
          if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue; // removed by an append
          yielded++;
          yield decode(columns, r);
        }
      }
      return;
    }
    const make = this.#maker(selection);
    for (const item of this.#iterate(plan, offset, limit, ticks)) yield item === NEXT_CHUNK ? item : make(item[1]);
  }

  /** Scan with a filter (one column group): only the columns the filter and the selection use are decoded. */
  *#scanColumns(plan, selection, offset, limit, ticks) {
    const planCols = new Set();
    (function collect(node) {
      if (node.kind === 'leaf') planCols.add(node.col);
      else if (node.kind === 'not') collect(node.item);
      else node.items.forEach(collect);
    })(plan);
    const wanted = this.#columns.map((_, i) => planCols.has(i) || selection.includes(i));
    const make = this.#maker(selection);
    const row = new Array(this.#columns.length);
    let skipped = 0;
    let yielded = 0;
    let deleted = 0;
    for (const ordinal of this.#scanChunks(plan)) {
      if (!this.#mayMatch(plan, ordinal)) continue;
      if (ticks) yield NEXT_CHUNK;
      const rowCount = this.#rowCount[ordinal];
      const columns = decodeColumnar(this.#readChunk(ordinal), this.#types, rowCount, ordinal, wanted);
      for (let r = 0; r < rowCount; r++) {
        if (yielded >= limit) return;
        const rowId = this.#rowStart[ordinal] + r;
        while (deleted < this.#deleted.length && this.#deleted[deleted] < rowId) deleted++;
        if (deleted < this.#deleted.length && this.#deleted[deleted] === rowId) continue;
        for (let c = 0; c < columns.length; c++) if (wanted[c]) row[c] = columns[c][r];
        if (!evaluate(plan, row)) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        yielded++;
        yield make(row);
      }
    }
  }

  /** Cached generated row builder for a column selection (null where code generation is unavailable). */
  #directDecoder(select) {
    const cacheKey = 'direct:' + select.join(',');
    if (!this.#makers.has(cacheKey)) this.#makers.set(cacheKey, columnsToObject(this.#columns, select));
    return this.#makers.get(cacheKey);
  }

  /** Internal: [rowId, row object with every visible column] for matching rows. */
  *[ROWS_WITH_IDS](filter) {
    const make = this.#maker(this.#visibleCols);
    for (const [rowId, row] of this.#iterate(this.#plan(filter), 0, Infinity)) yield [rowId, make(row)];
  }

  /** Yields [rowId, row array] for visible, non-deleted rows matching a normalized filter. */
  *#iterate(plan, offset, limit, ticks = false) {
    let skipped = 0;
    let yielded = 0;
    const indexes = { get: (column, kind) => this.#index(column, kind) };
    const rowIds = plan ? candidates(plan, indexes) : null;

    const accept = (row) => {
      if (row === null) return false; // deleted
      if (plan && !evaluate(plan, row)) return false;
      if (skipped < offset) {
        skipped++;
        return false;
      }
      return true;
    };

    if (rowIds !== null) {
      this.#ensureAllChunks(); // index results span every partition
      let previous = -1;
      for (const rowId of rowIds) {
        if (yielded >= limit) return;
        const ordinal = this.#chunkOrdinalFor(rowId);
        if (!this.#isVisibleChunk(ordinal)) continue;
        if (ticks && ordinal !== previous) yield NEXT_CHUNK;
        previous = ordinal;
        const row = this.#chunkRows(ordinal)[rowId - this.#rowStart[ordinal]];
        if (accept(row)) {
          yielded++;
          yield [rowId, row];
        }
      }
      return;
    }

    for (const ordinal of this.#scanChunks(plan)) {
      if (plan && !this.#mayMatch(plan, ordinal)) continue;
      if (ticks) yield NEXT_CHUNK;
      const rows = this.#chunkRows(ordinal);
      for (let r = 0; r < rows.length; r++) {
        if (yielded >= limit) return;
        if (accept(rows[r])) {
          yielded++;
          yield [this.#rowStart[ordinal] + r, rows[r]];
        }
      }
    }
  }

  /** Internal: what the appender needs to continue this file. Owner (or the single key / password) only. */
  get [APPEND_STATE]() {
    this.#ensureAllChunks();
    const lastOrdinal = this.#visibleChunks[this.#visibleChunks.length - 1];
    const last = lastOrdinal === undefined ? null : this.#chunkRowsRaw(lastOrdinal);
    const isOwner = this.#access?.isOwner;
    return {
      header: this.#header,
      table: this.#table,
      tableIndex: this.#tableIndex,
      ownerCatalog: isOwner ? this.#ownerCatalog() : null,
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
      lastRow: last && last.length ? Object.fromEntries(this.#columns.map((c, i) => [c.name, last[last.length - 1][i]])) : null,
    };
  }

  /** Decoded rows of a chunk including deleted ones (for the appender's sort-order check). */
  #chunkRowsRaw(ordinal) {
    const saved = this.#deleted;
    this.#deleted = [];
    this.#cachedChunk = { ordinal: -1, rows: null };
    try {
      return this.#chunkRows(ordinal);
    } finally {
      this.#deleted = saved;
      this.#cachedChunk = { ordinal: -1, rows: null };
    }
  }

  /** Counts matching visible rows. Without a filter this reads only the header. */
  count(filter) {
    if (filter == null) return this.rowCount;
    let n = 0;
    for (const _ of this.find(filter)) n++;
    return n;
  }

  /** Describes how a filter would execute: 'index' (with candidate count) or 'scan' (with chunks skipped). */
  explain(filter) {
    const plan = this.#plan(filter);
    const ids = plan ? candidates(plan, { get: (column, kind) => this.#index(column, kind) }) : null;
    if (ids !== null) return { strategy: 'index', candidateRows: ids.length };
    const scanned = this.#scanChunks(plan);
    const matching = plan ? Array.from(scanned).filter((i) => this.#mayMatch(plan, i)).length : scanned.length;
    return { strategy: 'scan', chunks: this.#visibleChunks.length, chunksSkipped: this.#visibleChunks.length - matching };
  }

  /** Releases the file. Safe to call more than once. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    release(this.#source);
    this.#cachedChunk = { ordinal: -1, rows: null };
    this.#indexes.clear();
  }

  [Symbol.iterator]() {
    return this.rows();
  }
}

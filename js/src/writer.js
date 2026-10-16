// Writes JAZMIN format 1.0 files (docs/rfc/draft-jazmin-format-03.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  FileSecrets, KEY_SLOT_PAGE_BYTES, buildKeySlotList, buildKeySlotPages, buildSignature, checkAccessOptions, digest, headerKey,
  normalizeGrants, normalizeTableAccess, ownerDirectoryKey, partKey, partitionName,
  sealSlot, sectionKeyFrom,
} from './access.js';
import { crc32 } from './binary.js';
import {
  encodeChunkDirectory, encodeChunkMap, encodeColumnDefinitions, encodeDelta, encodeHeader, encodeIndexDirectory, encodeOwnerCatalog, joinChunkMaps,
  encodePartitionTable, encodeStatistics,
} from './catalog.js';
import { columnBuffer, encodeColumnBuffers, nestedStage } from './columnar.js';
import { isNested } from './nested.js';
import { EVERYONE, FILE_BLOCK_SIZE, FILE_SOURCE, checkEdit, fileSource, normalizePackage } from './files.js';
import {
  DEFAULTS, DEFAULT_COLUMN_GROUP, FILE_ID_SIZE, FILE_LOCKS, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, INDEX_DELTAS, INLINE_PARTITIONS, NESTED_COLUMNS,
  KEYRING_GROUPS, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, SALT_SIZE, TRAILER_SIZE, WHOLE_TABLE,
} from './constants.js';
import { JazminValidationError } from './errors.js';
import { LINKS_KEY, checkLinkDefinitions, normalizeLinks } from './links.js';
import { INDEX_BUILDERS, INDEX_PAGE_BYTES, INDEX_SPILL_ENTRIES, encodePostingsSection } from './indexes.js';
import { JazminKey, KeySchedule, deriveFromPassword, fingerprint, hkdf, parseAnyKey } from './keys.js';
import { ownerLockList, readOwnerLocks, sealContentKey, sealGroupSecret, writerLocks } from './locks.js';
import { MASKED_COLUMNS, openGroupName, ownerMasks, rowMasker, tableMasks } from './masks.js';
import { checkPriority, writeThreads } from './priority.js';
import { checkShapeList, checkShapes, normalizeShapes } from './saved-shapes.js';
import { normalizeColumns } from './schema.js';
import { describeOrder, normalizeOrder, orderComparer, orderKeyMaker } from './sort-keys.js';
import { toMs } from './expiry.js';
import { encodeSection } from './section.js';
import { SectionPool } from './section-pool.js';
import { ColumnStats } from './stats.js';
import { normalizeValue } from './types.js';

const FLAGS_OFFSET = 4; // preamble: magic (4) | flags u16 | reserved u16 | file id | salt | kdf iterations | reserved

const TINY_SECTION = 256; // raw bytes below which catalog sections are not compressed
// Sections up to STAGE_LIMIT (directories, statistics, most chunks) are written in batches of up to STAGE_SIZE: each
// write is a system call, slow on some systems (Windows with real-time scanning), and a file is mostly small sections.
const STAGE_SIZE = 1024 * 1024;
const STAGE_LIMIT = 256 * 1024;

/**
 * Output: a file (written at explicit positions) or an in-memory list of buffers.
 * With `appendAt`, an existing file is continued from that offset; anything after it (an
 * interrupted earlier append) is cut off first.
 */
class Output {
  #stage = null;
  #staged = 0;
  #stageAt = 0;

  constructor(path, appendAt) {
    this.path = path;
    this.appendAt = appendAt;
    this.parts = [];
    this.position = appendAt ?? 0;
    this.fd = null;
    if (path && appendAt !== undefined) {
      this.fd = fs.openSync(path, 'r+');
      fs.ftruncateSync(this.fd, appendAt);
    } else if (path) {
      this.fd = fs.openSync(path, 'w');
    }
  }

  /** `buf` must not be modified afterwards (sections are always freshly allocated). */
  write(buf) {
    if (this.fd !== null && buf.length < STAGE_LIMIT) {
      this.#stage ??= Buffer.allocUnsafe(STAGE_SIZE);
      if (this.#staged + buf.length > STAGE_SIZE) this.#flush();
      if (this.#staged === 0) this.#stageAt = this.position;
      buf.copy(this.#stage, this.#staged);
      this.#staged += buf.length;
      this.position += buf.length;
      return;
    }
    this.#flush();
    this.writeAt(this.position, buf);
    this.position += buf.length;
  }

  #flush() {
    if (this.#staged === 0) return;
    const length = this.#staged;
    this.#staged = 0;
    this.writeAt(this.#stageAt, this.#stage.subarray(0, length));
  }

  writeAt(position, buf) {
    if (this.fd === null) {
      this.parts.push(buf);
      return;
    }
    let offset = 0;
    while (offset < buf.length) offset += fs.writeSync(this.fd, buf, offset, buf.length - offset, position + offset);
  }

  /** Overwrites bytes already written (the preamble flags of a file being appended to). */
  patch(position, buf) {
    if (this.fd !== null) {
      this.#flush();
      this.writeAt(position, buf);
      return;
    }
    let start = 0;
    for (const part of this.parts) {
      if (position >= start && position + buf.length <= start + part.length) {
        buf.copy(part, position - start);
        return;
      }
      start += part.length;
    }
    throw new Error('patch spans written parts');
  }

  /** Flushes written data to disk (so a trailer is never persisted before the data it points to). */
  sync() {
    this.#flush();
    if (this.fd !== null) fs.fsyncSync(this.fd);
  }

  close() {
    this.#flush();
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    return this.path ? undefined : Buffer.concat(this.parts);
  }

  /** Abandons the output: a new file is deleted, an appended file is cut back to its previous end. */
  discard() {
    this.#staged = 0; // never written
    if (this.fd !== null && this.appendAt !== undefined) fs.ftruncateSync(this.fd, this.appendAt);
    this.close();
    if (this.path && this.appendAt === undefined) fs.rmSync(this.path, { force: true });
  }
}

/** Internal option: continue an existing file instead of creating one (used by append()). */
export const CONTINUE = Symbol('jazmin.continue');

/** Internal: overrides the sorted-index page size ({ pageBytes }), so tests and fixtures can use many small pages. */
export const PAGING = Symbol('jazmin.paging');

/** Internal: `[CHUNK_MAP]: false` writes no owner chunk map, as writers before it did (tests of older files). */
export const CHUNK_MAP = Symbol('jazmin.chunkMap');

/** Internal: the rows a write will hand the writer, when known, for progress (`total` of the 'write' stage). */
export const PROGRESS_TOTAL = Symbol('jazmin.progressTotal');

/** Internal: the locks a rewrite keeps, as the owner directory has them (update(); an append has them in CONTINUE). */
export const KEPT_LOCKS = Symbol('jazmin.keptLocks');

/** Internal: the masked columns a rewrite keeps, as the owner directory has them, each with its table's `tableName`. */
export const KEPT_MASKS = Symbol('jazmin.keptMasks');

/** Where the writer keeps a stored content: by its bytes and its lock. */
const contentSlot = (c) => (c.lock === undefined ? c.sha256 : `${c.sha256}/${c.lock}`);

/** A column's catalog definition (spec 6.2), with a list's item or an object's fields (spec 5.4). */
function catalogColumn(c, position) {
  return {
    position, name: c.name, type: c.type, required: !c.nullable,
    description: c.description, attributes: c.attributes ? JSON.stringify(c.attributes) : undefined,
    ...(c.item ? { item: catalogColumn(c.item, 0) } : {}),
    ...(c.fields ? { fields: c.fields.map(catalogColumn) } : {}),
  };
}

/** Approximate encoded size of a value, used to cap chunks at `chunkBytes`. */
function estimateSize(type, v) {
  if (v === null) return 0;
  switch (type) {
    case 'decimal':
    case 'string':
    case 'json': return v.length + 1;
    case 'binary': return v.length + 2;
    case 'float': return 8;
    case 'bool': return 1;
    default: return 5;
  }
}

const sha256 = (...parts) => {
  const hash = crypto.createHash('sha256');
  for (const p of parts) hash.update(p);
  return hash.digest();
};

/**
 * A table's definition, checked (spec 6.2): { name, columns, sortedBy, sortCols, order, chunkRows, chunkBytes,
 * partitionBy, partitionCol, columnGroups }; `order` is its sort order (sort-keys.js normalizeOrder), `sortedBy` its
 * plain leading keys (the catalog's sorted_by). Partition columns and column groups belong to access-controlled files.
 */
function tableDefinition(t, { named, access, chunkRows, chunkBytes, kept = [] }) {
  if (t === null || typeof t !== 'object') throw new JazminValidationError('Each table must be an object');
  if (named && (typeof t.name !== 'string' || t.name === '')) throw new JazminValidationError('Each table needs a name');
  // Masked columns (spec 7.6.8): each in a group of its own, with its shown and unmasked columns added.
  const masked = Array.isArray(t.columns) ? tableMasks(t.columns, kept) : { columns: t.columns, masks: [], groups: {} };
  if (masked.masks.length && !access) {
    throw new JazminValidationError(`Column '${masked.masks[0].column}': masked columns need an access-controlled file (spec 7.6.8): only its keys can be given a column masked`);
  }
  const columns = normalizeColumns(masked.columns);
  const rows = t.chunkRows ?? chunkRows;
  if (!Number.isInteger(rows) || rows < 1) throw new JazminValidationError('chunkRows must be a positive integer');
  let sortCols = null;
  let order = null;
  if (t.sortedBy !== undefined) {
    order = normalizeOrder(t.sortedBy, columns);
    sortCols = order.keys.map((k) => k.col);
  }
  let layout = { partitionBy: null, partitionCol: -1, columnGroups: [{ name: DEFAULT_COLUMN_GROUP, cols: columns.map((_, i) => i) }] };
  if (access) {
    layout = normalizeTableAccess(masked.masks.length ? { ...t, columnGroups: { ...(t.columnGroups ?? {}), ...masked.groups } } : t, columns);
    for (const i of sortCols ?? []) {
      if (layout.columnGroups[0].name !== DEFAULT_COLUMN_GROUP || !layout.columnGroups[0].cols.includes(i)) {
        throw new JazminValidationError(`The sortedBy column '${columns[i].name}' must stay in the default column group`);
      }
    }
  } else if ((t.partitionBy !== undefined && t.partitionBy !== null) || t.columnGroups !== undefined) {
    throw new JazminValidationError('partitionBy and columnGroups need an access-controlled file (the access option)');
  }
  return {
    name: t.name ?? '', columns, sortedBy: order ? order.plain : undefined, sortCols, order, chunkRows: rows, chunkBytes: t.chunkBytes ?? chunkBytes, ...layout,
    masks: masked.masks,
  };
}

/**
 * Streams rows into a JAZMIN file. Memory use is one chunk of rows plus the row-id lists
 * of indexed columns.
 *
 *   const w = new JazminWriter('people.jzm', { columns, key });
 *   w.writeRow({ ... }); ...; w.finish();
 *
 * Pass `null` as target to build the file in memory; finish() then returns a Buffer.
 *
 * Options beyond the basics:
 *   sortedBy: ['section', 'line']   rows must arrive in this order; recorded so updates can merge
 *   access:   { partitionBy, columnGroups, grants }   access-controlled file (needs an owner `key`)
 *   tables:   [{ name, columns, sortedBy, partitionBy, columnGroups, chunkRows, chunkBytes }]   several tables
 *             (instead of columns, sortedBy and access.partitionBy / columnGroups); see startTable
 *   shapes:   [{ name, shape, description, default, table, groups }]   saved export shapes; in shared files each key
 *             that sees one (its groups) must see every column it uses
 */

/** A nested column's leaf statistics over a segment's chunks (spec 6.4): every chunk of a writer has the same leaves. */
function leafEntries(chunks, col) {
  const first = chunks[0].stats[col].leaves;
  if (!first) return [];
  return first.map((leaf, k) => {
    const bounds = chunks.map((c) => c.stats[col].leaves[k].stats.bounds());
    return {
      path: leaf.path,
      counts: chunks.map((c) => c.stats[col].leaves[k].count),
      nullCounts: chunks.map((c) => c.stats[col].leaves[k].stats.nulls),
      min: bounds.map((x) => x.min),
      max: bounds.map((x) => x.max),
    };
  });
}
export class JazminWriter {
  #out;
  #columns;
  #options;
  #fileId;
  #salt;
  #keys = null; // key or password files
  #ownerKey = null; // access-controlled files
  #secrets = null; // access-controlled files
  #access = null; // access-controlled files: { grants, expiredGrants }
  #tableDefs; // the tables to write (see tableDefinition)
  #current; // the definition of the table rows go to
  #tableIndex = 0; // its number in the file
  #written = []; // by table number: { table, indexes } once written
  #allGroupNames; // column groups of every table (grants of all columns get them all)
  #deltas; // append deltas (spec 11.2)
  #groups; // column groups: [{ name, cols, buffers, bytes }] - '*' only, unless access-controlled
  #chunkRows = 0;
  #chunkStats;
  #chunkPartition = null;
  #chunks = []; // chunks this writer wrote: { ordinal, rowStart, rowCount, partition, parts, stats }
  #firstOrdinal = 0;
  #indexBuilders = [];
  #rowCount = 0;
  #finished = false;
  #passwordBased = false;
  #names;
  #values; // reused per row
  #sortCols = null;
  #lastSortKey = null;
  #orderKey = null; // the table's sort order: a row's key (sort-keys.js), and how two keys compare
  #orderCompare = null;
  #continue = null; // append mode: state of the file being continued
  #progress = null; // onProgress and signal, when given: { onProgress, signal, total, written }
  #files = { entries: new Map(), contents: new Map(), nextId: 0 }; // embedded files (spec 6.8): path -> entry, sha256 -> stored content
  #package; // package settings for viewers (validated at finish)
  #shapes = new Map(); // saved export shapes (spec 6.8): name -> entry
  #fileGroupNames = []; // access mode: names of the file groups written
  #locks = new Map(); // locks of stored files (spec 6.8.1): id -> { id, kind, salt, iterations, key, secret }
  #otherMasks = []; // an append: the file's other tables' masked columns, as the owner directory has them
  #masker = null; // the table's masked columns: makes a row's shown values and moves its unmasked values
  #parallelism; // threads encoding chunk sections (1 = this thread only)
  #indexDeltas = false; // sorted index pages with keys and first row ids as differences (reader feature 'index-deltas')
  #usesIndexDeltas = false; // a page was written that way: the header names the feature
  #usesNested = false; // a table has list or object columns: the header names the feature (spec 5.4)
  #stagers = null; // by column: list and object values are checked into a stage before any buffer takes them
  #pool = null; // SectionPool, started from the third chunk so small files never pay for workers
  #pending = []; // chunk parts being encoded by the pool, in file order: { entry, group }

  constructor(target, options = {}) {
    const {
      columns, metadata = {}, codec = DEFAULTS.codec, level, chunkRows = DEFAULTS.chunkRows,
      chunkBytes = DEFAULTS.chunkBytes, key, password, kdfIterations = DEFAULTS.kdfIterations, sortedBy, access, now,
      layout, files, package: packageSettings, tables, priority = 'balanced', compactIndexes = false, shapes, links,
      onProgress, signal, locks,
    } = options;
    signal?.throwIfAborted();
    this.#progress = onProgress || signal ? { onProgress, signal, total: options[PROGRESS_TOTAL] ?? null, written: 0 } : null;
    const { maxDegreeOfParallelism = writeThreads(priority) } = options;
    checkPriority(priority);
    if (typeof compactIndexes !== 'boolean') throw new JazminValidationError('compactIndexes must be true or false');
    if (!Number.isInteger(maxDegreeOfParallelism) || maxDegreeOfParallelism < 1) {
      throw new JazminValidationError('maxDegreeOfParallelism must be a positive integer');
    }
    if (layout !== undefined && layout !== 'columnar') throw new JazminValidationError("Format 1.0 stores every file in the columnar layout; the 'row' layout no longer exists");
    this.#parallelism = maxDegreeOfParallelism;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new JazminValidationError('metadata must be a plain object');
    }
    if (key && password) throw new JazminValidationError('Supply either key or password, not both');
    if (password && (!Number.isInteger(kdfIterations) || kdfIterations < MIN_KDF_ITERATIONS || kdfIterations > MAX_KDF_ITERATIONS)) {
      throw new JazminValidationError(`kdfIterations must be from ${MIN_KDF_ITERATIONS} to ${MAX_KDF_ITERATIONS}`);
    }
    this.#options = {
      metadata, codec, level, kdfIterations: password ? kdfIterations : 0, now: toMs(now),
      pageBytes: options[PAGING]?.pageBytes ?? INDEX_PAGE_BYTES,
      keySlotPageBytes: options[PAGING]?.keySlotPageBytes ?? KEY_SLOT_PAGE_BYTES,
      chunkMap: options[CHUNK_MAP] !== false,
      // Sorted index entries held before they go to a temporary file (bounded memory for any number of keys).
      spillEntries: options[PAGING]?.spillEntries ?? INDEX_SPILL_ENTRIES[priority],
    };
    const cont = options[CONTINUE];
    this.#continue = cont ?? null;
    // An append keeps the file's index encoding: its readers already support it (or the file would not use it).
    this.#indexDeltas = cont ? cont.header.readerFeatures.includes(INDEX_DELTAS) : compactIndexes;
    if (access !== undefined) checkAccessOptions(access);
    if (locks !== undefined && !access) {
      throw new JazminValidationError('Locks need an access-controlled file (spec 6.8.1): with one key or password, that key would open every lock');
    }
    // An append keeps the owner directory's locks (masked columns may use them with no file stored).
    const lockChanges = writerLocks(locks, cont ? [...readOwnerLocks(cont.directory?.locks).values()] : options[KEPT_LOCKS]);
    this.#locks = lockChanges.locks;
    if (tables !== undefined) {
      if (!Array.isArray(tables) || tables.length === 0) throw new JazminValidationError('tables must be a non-empty array of table definitions');
      if (columns !== undefined || sortedBy !== undefined || access?.partitionBy != null || access?.columnGroups !== undefined) {
        throw new JazminValidationError('With tables, give columns, sortedBy, partitionBy and columnGroups in each table');
      }
    }
    const definitions = tables ?? [{ name: cont?.table.name ?? '', columns, sortedBy, partitionBy: access?.partitionBy, columnGroups: access?.columnGroups }];
    // The masked columns a rewrite or an append keeps: the file's, for the table they are of.
    const keptMasks = (t) => (cont ? (cont.directory?.masks ?? []).filter((m) => m.table === cont.tableIndex)
      : (options[KEPT_MASKS] ?? []).filter((m) => m.tableName === (t.name ?? '')));
    this.#otherMasks = cont ? (cont.directory?.masks ?? []).filter((m) => m.table !== cont.tableIndex) : [];
    this.#tableDefs = definitions.map((t) => tableDefinition(t, { named: tables !== undefined, access: Boolean(access), chunkRows, chunkBytes, kept: keptMasks(t) }));
    const maskGroups = new Set(this.#otherMasks.map((m) => m.group));
    for (const m of [...this.#otherMasks, ...this.#tableDefs.flatMap((t) => t.masks)]) {
      if (!this.#locks.has(m.lock)) {
        const known = this.#locks.size ? `locks: ${[...this.#locks.keys()].join(', ')}` : 'no locks given';
        throw new JazminValidationError(`Column '${m.column}': mask: no lock '${m.lock}' (${known})`);
      }
    }
    for (const m of this.#tableDefs.flatMap((t) => t.masks)) {
      if (maskGroups.has(m.group)) throw new JazminValidationError(`Column '${m.column}': a masked column group is of one table ('${m.group}' is in two)`);
      maskGroups.add(m.group);
    }
    const names = new Set();
    for (const t of tables ? this.#tableDefs : []) {
      if (names.has(t.name)) throw new JazminValidationError(`Table '${t.name}' is declared twice`);
      names.add(t.name);
    }
    // Links between the tables: checked against them, kept in the metadata (names only).
    if (links !== undefined) {
      if (cont) throw new JazminValidationError('An append keeps the links: change them with update()');
      const list = checkLinkDefinitions(normalizeLinks(links), new Map(this.#tableDefs.map((t) => [t.name, t.columns])));
      const { [LINKS_KEY]: _, ...rest } = this.#options.metadata;
      this.#options.metadata = list.length ? { ...rest, [LINKS_KEY]: list } : rest;
    }
    // Column groups a grant may name: those of every table (when appending, of the file's other tables too).
    this.#allGroupNames = [...new Set([
      ...this.#tableDefs.flatMap((t) => t.columnGroups.map((g) => g.name)),
      ...(cont?.header.tables ?? []).flatMap((t) => t.columnGroups.map((g) => g.name)),
    ])];

    // Saved shapes: the file's own, replaced by name by those given. Checked against the tables before anything is
    // written, and against the columns of every key that will see them when the file is finished.
    for (const s of cont?.files?.shapes ?? []) this.#shapes.set(s.name, s);
    for (const s of normalizeShapes(shapes)) this.#shapes.set(s.name, s);
    if (this.#shapes.size) {
      checkShapeList([...this.#shapes.values()]);
      checkShapes([...this.#shapes.values()], this.#shapeTables());
    }

    this.#fileId = cont ? cont.fileId : crypto.randomBytes(FILE_ID_SIZE);
    this.#salt = cont ? cont.salt : key || password || access ? crypto.randomBytes(SALT_SIZE) : Buffer.alloc(SALT_SIZE);
    if (access) {
      const owner = key ? parseAnyKey(key) : null;
      if (!(owner instanceof JazminKey)) throw new JazminValidationError("An access-controlled file needs the owner's master key (jzk1-...) as `key`");
      this.#ownerKey = owner;
      this.#access = normalizeGrants(access.grants, new Set(this.#allGroupNames), this.#options.now);
      // A masked column's shown and unmasked columns go with it (spec 7.6.8): a grant of its group gets theirs too.
      const maskGroups = [...this.#otherMasks.map((m) => m.group), ...this.#tableDefs.flatMap((t) => t.masks.map((m) => m.group))];
      for (const g of this.#access.grants) {
        if (!Array.isArray(g.columns)) continue; // every group: theirs too
        for (const group of maskGroups) {
          const open = openGroupName(group);
          if (g.columns.includes(group) && this.#allGroupNames.includes(open) && !g.columns.includes(open)) g.columns = [...g.columns, open];
        }
      }
      // Same file, same secrets when appending: new sections must be readable with those already in use.
      this.#secrets = cont ? new FileSecrets(this.#salt, cont.ownerSecrets.header, cont.ownerSecrets.owner) : new FileSecrets(this.#salt);
      this.#secrets.recordPartitions(cont?.directory.partitions ?? []);
    } else {
      if (cont) {
        this.#keys = cont.keys;
      } else if (key || password) {
        const master = password ? deriveFromPassword(password, this.#salt, kdfIterations) : JazminKey.from(key).bytes;
        this.#keys = new KeySchedule(master, this.#salt);
        // The 'files' group is added only when files are stored.
        this.#keys.setKeyring(Object.fromEntries([KEYRING_GROUPS.data, KEYRING_GROUPS.index].map((g) => [g, crypto.randomBytes(32)])));
      }
    }
    this.#passwordBased = Boolean(password);
    this.#deltas = [...(cont?.header.deltas ?? [])];
    this.#beginTable(this.#tableDefs[0], cont ? cont.tableIndex : 0);
    this.#out = cont ? new Output(target, cont.validEnd) : new Output(target);
    try {
      if (cont) {
        const flags = Buffer.alloc(2);
        flags.writeUInt16LE(cont.flags | FLAG_APPENDED);
        this.#out.patch(FLAGS_OFFSET, flags); // set before anything else is written (spec 11.2)
      } else {
        this.#out.write(this.#preamble());
      }
      if (cont?.files) {
        // Files already in the file stay; their stored contents are reused by reference.
        for (const e of cont.files.entries) this.#files.entries.set(e.path, e);
        for (const c of cont.files.contents) {
          // A removed lock's contents stay, unlocked.
          const { lock, ...unlocked } = c;
          if (lock !== undefined && !this.#locks.has(lock) && !lockChanges.removed.has(lock)) {
            const path = cont.files.entries.find((e) => e.content === c.id)?.path ?? `#${c.id}`;
            throw new JazminValidationError(`File '${path}' names lock '${lock}', which the file no longer has: remove the file with update({ removeFiles })`);
          }
          const kept = lock !== undefined && this.#locks.has(lock) ? c : unlocked;
          this.#files.contents.set(contentSlot(kept), kept);
        }
        this.#files.nextId = cont.files.nextId;
      }
      this.#package = packageSettings !== undefined ? packageSettings : cont?.files?.package;
      for (const f of files ?? []) this.addFile(f);
    } catch (error) {
      // Refused with the output open (a stored file given twice, say): no writer is returned to abort it, so it is
      // aborted here. A new file is removed and closed; an appended one is cut back, its flags restored.
      this.abort();
      throw error;
    }
  }

  /** The file's tables and their column groups, the first table first: what saved shapes are checked against. */
  #shapeTables() {
    const declared = (t) => ({ name: t.name, groups: t.columnGroups.map((g) => ({ name: g.name, columns: g.cols.map((i) => t.columns[i]) })) });
    const cont = this.#continue;
    if (!cont) return this.#tableDefs.map(declared);
    // An append writes one table: the others are as the file has them.
    return cont.header.tables.map((t, i) => (i === cont.tableIndex ? declared(this.#tableDefs[0]) : cont.shapeTables?.[i] ?? { name: t.name, groups: [] }));
  }

  /**
   * Stores a file (spec 6.8): addFile({ path, content | file, type, groups }) or addFile(path, content, { type, groups }).
   * Identical content is stored once, however many paths or groups refer to it; adding a path twice is an error.
   */
  addFile(entryOrPath, content, options = {}) {
    if (this.#finished) throw new JazminValidationError('Writer is already finished');
    const entry = typeof entryOrPath === 'string' ? { ...options, path: entryOrPath, content } : entryOrPath;
    const src = entry?.[FILE_SOURCE] ? entry : fileSource(entry);
    if (this.#files.entries.has(src.path)) throw new JazminValidationError(`File '${src.path}' is added twice`);
    if (src.lock !== undefined && !this.#locks.has(src.lock)) {
      const known = this.#locks.size ? `locks: ${[...this.#locks.keys()].join(', ')}` : 'no locks given';
      throw new JazminValidationError(`File '${src.path}': no lock '${src.lock}' (${known})`);
    }
    // The same bytes locked and unlocked (or under two locks) are two contents: one's key must not open the other.
    const slot = contentSlot(src);
    let stored = this.#files.contents.get(slot);
    if (!stored) {
      this.#writePending(); // sections are written in order: chunks still being encoded go first
      const id = this.#files.nextId++;
      const key = this.#keys || this.#access ? crypto.randomBytes(32) : null; // one random key per stored content
      const blocks = [];
      for (let offset = 0, b = 0; offset < src.size; offset += FILE_BLOCK_SIZE, b++) {
        const raw = src.read(offset, Math.min(FILE_BLOCK_SIZE, src.size - offset));
        const sectionId = `file/${id}/${b}`;
        const section = this.#section(raw, sectionId, key ? hkdf(key, this.#salt, `JAZMIN/1/${sectionId}`) : undefined);
        blocks.push({ offset: this.#out.position, length: section.length, ...(this.#access ? { digest: digest(section).toString('base64') } : {}) });
        this.#out.write(section);
      }
      stored = {
        id, size: src.size, sha256: src.sha256, blockSize: FILE_BLOCK_SIZE, ...(key ? { key: key.toString('base64') } : {}),
        ...(src.lock !== undefined ? { lock: src.lock } : {}), blocks,
      };
      this.#files.contents.set(slot, stored);
    }
    this.#files.entries.set(src.path, {
      path: src.path, type: src.type, groups: src.groups, content: stored.id, ...(src.actions ? { actions: src.actions } : {}),
      ...(src.groupActions ? { groupActions: src.groupActions } : {}),
    });
  }

  /** Columns of the table rows go to. */
  get columns() {
    return this.#columns.map((c) => ({ ...c }));
  }

  /** Name of the table rows go to. */
  get table() {
    return this.#current.name;
  }

  /**
   * Starts another table declared in `tables`: rows written from now on go to it. Tables can be written in any
   * order, each once; the file lists them in the order they were declared, and any never started is written empty.
   */
  startTable(name) {
    if (this.#finished) throw new JazminValidationError('Writer is already finished');
    const index = this.#continue ? -1 : this.#tableDefs.findIndex((t) => t.name === name);
    if (index < 0) throw new JazminValidationError(`startTable: no table '${name}' was declared in the writer's tables`);
    if (index === this.#tableIndex || this.#written[index]) throw new JazminValidationError(`Table '${name}' has already been written`);
    this.#endTable();
    this.#beginTable(this.#tableDefs[index], index);
  }

  /** Makes `def` (table `index` of the file) the table rows go to. */
  #beginTable(def, index) {
    this.#current = def;
    this.#tableIndex = index;
    this.#columns = def.columns;
    this.#names = new Set(def.columns.map((c) => c.name));
    this.#stagers = def.columns.some((c) => isNested(c.type))
      ? def.columns.map((c) => (isNested(c.type) ? { buffer: columnBuffer(c.type, def.chunkRows, c), stage: nestedStage() } : null))
      : null;
    this.#usesNested ||= this.#stagers !== null;
    this.#values = new Array(def.columns.length);
    this.#sortCols = def.sortCols;
    this.#lastSortKey = null;
    this.#masker = def.masks?.length ? rowMasker(def.masks, def.columns) : null;
    this.#orderKey = def.order ? orderKeyMaker(def.order.keys) : null;
    this.#orderCompare = def.order ? orderComparer(def.order.keys) : null;
    this.#groups = def.columnGroups.map((g) => ({ name: g.name, cols: g.cols }));
    this.#chunks = [];
    this.#chunkPartition = null;
    this.#closeIndexBuilders();
    this.#indexBuilders = [];
    def.columns.forEach((column, col) => {
      for (const kind of column.index) {
        // Readers find the leading sortedBy column's values from chunk statistics and have never used its sorted
        // index (spec 6.7): it is not written. A leading key with another text order is searched by its index.
        if (kind === 'sorted' && def.sortCols?.[0] === col && def.sortedBy?.length) continue;
        const builder = new INDEX_BUILDERS[kind](column.type, Infinity, { spillEntries: this.#options.spillEntries });
        this.#indexBuilders.push({ col, column: column.name, kind, builder });
      }
    });
    const cont = this.#continue;
    this.#rowCount = cont ? cont.table.rowCount : 0;
    this.#firstOrdinal = cont ? cont.table.chunkCount : 0;
    if (cont && this.#sortCols && cont.lastRow) {
      this.#lastSortKey = this.#orderKey((i) => normalizeValue(this.#columns[i].type, cont.lastRow[this.#columns[i].name], this.#columns[i].name));
    }
    this.#resetChunk();
  }

  /** Writes the current table's last chunk, indexes, statistics and directories; keeps its catalog entry. */
  #endTable() {
    this.#flushChunk();
    this.#writePending();
    const cont = this.#continue;
    const t = this.#tableIndex;
    const segment = cont ? cont.header.appendCount + 1 : 0;
    // A new file always lists its indexes, even without rows, so appends and updates keep them.
    const newIndexes = !cont || this.#chunks.length ? this.#writeIndexes(segment) : [];
    const indexes = [...(cont?.indexes ?? []), ...newIndexes];
    const written = this.#writeDirectories(); // [{ id, segments: [ref] }] for the partitions this writer added to
    const table = {
      name: this.#current.name,
      columnCount: this.#columns.length,
      columnGroups: this.#columnGroups(),
      sortedBy: this.#current.sortedBy ?? [],
      sort: this.#current.order?.sort ?? [], // other text orders (spec 6.7); sortedBy keeps the plain leading keys
      partitionBy: this.#current.partitionBy ?? '',
      rowCount: this.#rowCount,
      deletedCount: cont?.deleted.length ?? 0,
      chunkCount: this.#firstOrdinal + this.#chunks.length,
      partitions: [],
      partitionTable: null,
      indexes: this.#access ? [] : indexes,
      deletes: cont?.table.deletes ?? null,
    };
    this.#placePartitions(table, written, this.#deltas);
    if (cont && cont.deleted.length && cont.deleted.length !== cont.table.deletedCount) {
      const sectionId = `${t}/deletes/${cont.deleted.length}`; // the count only grows, so the id is unique
      table.deletes = this.#writeSection(encodePostingsSection(cont.deleted), sectionId, this.#key(sectionId, this.#secrets?.header));
    }
    this.#written[t] = { table, indexes, ...(this.#access ? this.#writeChunkMap(segment) : {}) };
  }

  /**
   * The table's chunk map (spec 7.6.5): every chunk's row count and partition, by ordinal, so the owner finds a row's
   * partition without reading every partition's chunk directory. A full write writes it whole (section
   * `<t>/chunkmap`); an append writes the chunks appended since (`<t>/chunkmap/<segment>`: the earlier appends' and
   * its own) and keeps the whole one. A file without one gets none until its next full write.
   * Returns the owner catalog's { chunkMap, chunkMapAppended } refs.
   */
  #writeChunkMap(segment) {
    if (!this.#options.chunkMap) return {};
    const cont = this.#continue;
    // This writer's chunks.
    const partitions = [...new Set(this.#chunks.map((c) => c.partition))];
    const index = new Map(partitions.map((id, i) => [id, i]));
    const written = { rowCounts: this.#chunks.map((c) => c.rowCount), partitions, partitionOf: this.#chunks.map((c) => index.get(c.partition)) };
    const ownerKey = (sectionId) => sectionKeyFrom(this.#secrets.owner, this.#salt, sectionId);
    if (!cont) {
      const sectionId = `${this.#tableIndex}/chunkmap`;
      return { chunkMap: this.#writeSection(encodeChunkMap(written), sectionId, ownerKey(sectionId)) };
    }
    const state = cont.chunkMap;
    if (!state || state.chunks !== this.#firstOrdinal) return {}; // the file has none, or it does not cover every chunk
    const appended = state.appended ? joinChunkMaps(state.appended, written) : written;
    const sectionId = `${this.#tableIndex}/chunkmap/${segment}`;
    return {
      chunkMap: state.base,
      chunkMapAppended: this.#writeSection(encodeChunkMap(appended), sectionId, ownerKey(sectionId)),
      chunkMapSegment: segment,
    };
  }

  get rowCount() {
    return this.#rowCount;
  }

  /** Grants left out because they had already expired (access-controlled files). */
  get expiredGrants() {
    return this.#access?.expiredGrants ?? 0;
  }

  #preamble() {
    const buf = Buffer.alloc(PREAMBLE_SIZE);
    MAGIC.copy(buf, 0);
    let flags = 0;
    if (this.#keys || this.#access) flags |= FLAG_ENCRYPTED;
    if (this.#passwordBased) flags |= FLAG_PASSWORD;
    if (this.#access) flags |= FLAG_ACCESS;
    buf.writeUInt16LE(flags, FLAGS_OFFSET);
    this.#fileId.copy(buf, 8);
    this.#salt.copy(buf, 24);
    buf.writeUInt32LE(this.#options.kdfIterations, 56);
    return buf;
  }

  #resetChunk() {
    for (const group of this.#groups) {
      group.bytes = 0;
      group.buffers ??= group.cols.map((i) => columnBuffer(this.#columns[i].type, this.#current.chunkRows, this.#columns[i]));
      for (const b of group.buffers) if (b.rows > 0) b.reset(); // normally already empty (encoding resets them)
    }
    this.#chunkRows = 0;
    this.#chunkStats = this.#columns.map((c) => new ColumnStats(c.type));
  }

  #section(raw, sectionId, key, codec = this.#options.codec) {
    return encodeSection(raw, { codec, level: this.#options.level, fileId: this.#fileId, sectionId, key });
  }

  /** Key of a catalog or data section: the keyring group of key/password files (spec 7.3), or `secret` (spec 7.6.3). */
  #key(sectionId, secret, group = KEYRING_GROUPS.data) {
    if (this.#access) return sectionKeyFrom(secret, this.#salt, sectionId);
    return this.#keys?.sectionKey(group, sectionId);
  }

  /**
   * Writes a catalog section and returns its reference ({ offset, length, digest? }). Tiny ones (statistics and
   * directories of small partitions) are stored uncompressed: compression would save a few bytes at most, and each
   * call costs time and memory.
   */
  #writeSection(raw, sectionId, key, codec = raw.length < TINY_SECTION ? 'none' : undefined) {
    const section = this.#section(raw, sectionId, key, codec);
    const ref = { offset: this.#out.position, length: section.length, ...(this.#access ? { digest: digest(section) } : {}) };
    this.#out.write(section);
    return ref;
  }

  /** Appends one row. Unknown properties are rejected so typos are caught early. */
  writeRow(row) {
    if (this.#finished) throw new JazminValidationError('Writer is already finished');
    if (row === null || typeof row !== 'object') throw new JazminValidationError('Each row must be an object');
    if (this.#masker) row = this.#masker(row); // shown values made, unmasked values moved (spec 7.6.8)
    const rowNumber = this.#rowCount;
    for (const name in row) {
      if (!this.#names.has(name)) throw new JazminValidationError(`Row ${rowNumber}: unknown column '${name}'`);
    }
    const columns = this.#columns;
    const values = this.#values;
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      let value = normalizeValue(c.type, row[c.name], c.name);
      if (value === null && !c.nullable) throw new JazminValidationError(`Row ${rowNumber}: column '${c.name}' is not nullable`);
      const stager = this.#stagers?.[i];
      if (stager && value !== null) {
        const { stage } = stager;
        stage.values.length = stage.lengths.length = stage.vi = stage.li = stage.bytes = 0;
        stager.buffer.stage(value, stage);
        value = stage;
      }
      values[i] = value;
    }
    if (this.#sortCols) this.#checkOrder(values, rowNumber);

    if (this.#access) {
      // A chunk holds exactly one partition, so a key can be granted whole chunks.
      const partition = this.#current.partitionCol >= 0 ? partitionName(values[this.#current.partitionCol]) : WHOLE_TABLE;
      if (this.#chunkRows > 0 && partition !== this.#chunkPartition) this.#flushChunk();
      this.#chunkPartition = partition;
    }

    // Values are collected per column, in typed buffers, and encoded when the chunk is flushed.
    let bytes = 0;
    for (const group of this.#groups) {
      for (let j = 0; j < group.cols.length; j++) {
        const col = group.cols[j];
        let v = values[col];
        if (v !== null && columns[col].type === 'json') v = JSON.stringify(v);
        if (v === null) group.buffers[j].addNull();
        else group.buffers[j].add(v);
        group.bytes += this.#stagers?.[col] && v !== null ? v.bytes : estimateSize(columns[col].type, v);
      }
      bytes += group.bytes;
    }
    const stats = this.#chunkStats;
    for (let i = 0; i < values.length; i++) stats[i].add(values[i]);
    for (const ix of this.#indexBuilders) ix.builder.add(rowNumber, values[ix.col]);

    this.#rowCount++;
    this.#chunkRows++;
    if (this.#chunkRows >= this.#current.chunkRows || bytes >= this.#current.chunkBytes) this.#flushChunk();
  }

  #checkOrder(values, rowNumber) {
    const key = this.#orderKey((i) => values[i]);
    if (this.#lastSortKey && this.#orderCompare(this.#lastSortKey, key) > 0) {
      throw new JazminValidationError(`Row ${rowNumber} is out of order for sortedBy [${describeOrder(this.#current.order.keys)}]`);
    }
    this.#lastSortKey = key;
  }

  writeRows(rows) {
    for (const row of rows) this.writeRow(row);
  }

  /**
   * writeRows for async code: `rows` may be an async iterable (a database cursor, a stream). Waits for the
   * compression workers without blocking, and gives other work the event loop after each chunk.
   */
  async writeRowsAsync(rows) {
    let chunks = this.#chunks.length;
    for await (const row of rows) {
      // The next chunk could have to wait for a worker: wait here, without blocking, instead.
      if (this.#pool && this.#pool.pending >= this.#pool.capacity - this.#groups.length) await this.#pool.whenReady();
      this.writeRow(row);
      if (this.#chunks.length !== chunks) {
        chunks = this.#chunks.length;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  /** finish() for async code: waits for the compression workers without blocking. */
  async finishAsync() {
    if (this.#finished) throw new JazminValidationError('Writer is already finished');
    this.#flushChunk();
    while (this.#pending.length) {
      await this.#pool.whenReady();
      this.#writePending(1);
    }
    return this.finish();
  }

  #flushChunk() {
    if (this.#chunkRows === 0) return;
    if (this.#progress) this.#reportRows(this.#chunkRows);
    const ordinal = this.#firstOrdinal + this.#chunks.length;
    const partition = this.#access ? this.#secrets.addPartition(this.#chunkPartition) : WHOLE_TABLE;
    const entry = {
      ordinal, rowStart: this.#rowCount - this.#chunkRows, rowCount: this.#chunkRows, partition,
      parts: this.#groups.map(() => ({ offset: 0, length: 0 })), stats: this.#chunkStats,
    };
    // Nested columns' leaves (spec 6.4): taken before encoding resets the buffers.
    for (const group of this.#groups) {
      group.cols.forEach((col, j) => {
        if (typeof group.buffers[j].leafStats === 'function') entry.stats[col].leaves = group.buffers[j].leafStats();
      });
    }
    this.#chunks.push(entry);
    const pool = this.#sectionPool();
    const partitionSecret = this.#access ? this.#secrets.partitionSecret(partition) : null;
    this.#groups.forEach((group, g) => {
      const sectionId = `${this.#tableIndex}/chunk/${ordinal}/${group.name}`;
      const key = this.#access
        ? partKey(partitionSecret, this.#secrets.columnSecret(group.name), this.#salt, sectionId)
        : this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId);
      const raw = encodeColumnBuffers(group.buffers); // values are kept in typed buffers until here
      if (pool) {
        // Compressed (and encrypted) on a worker; written in order once ready.
        pool.submit(raw, { codec: this.#options.codec, level: this.#options.level, fileId: this.#fileId, sectionId, key });
        this.#pending.push({ entry, group: g });
        if (pool.pending >= pool.capacity) this.#writePending(1);
      } else {
        const section = this.#section(raw, sectionId, key);
        Object.assign(entry.parts[g], { offset: this.#out.position, length: section.length, ...(this.#access ? { digest: digest(section) } : {}) });
        this.#out.write(section);
      }
    });
    this.#resetChunk();
  }

  /** The worker pool for chunk sections, or null to encode on this thread (small files, parallelism 1, no workers). */
  #sectionPool() {
    if (this.#pool || this.#parallelism <= 1 || this.#chunks.length < 3) return this.#pool;
    try {
      this.#pool = new SectionPool(this.#parallelism);
    } catch {
      this.#parallelism = 1; // worker threads unavailable (for example in some bundles): encode inline
    }
    return this.#pool;
  }

  /** Writes up to `count` encoded chunk parts from the pool, oldest first. */
  #writePending(count = Infinity) {
    for (; count > 0 && this.#pending.length > 0; count--) {
      const { entry, group } = this.#pending.shift();
      const { envelope, body } = this.#pool.take();
      Object.assign(entry.parts[group], {
        offset: this.#out.position, length: envelope.length + body.length, ...(this.#access ? { digest: sha256(envelope, body) } : {}),
      });
      this.#out.write(envelope);
      // In memory the parts are kept: copy the body out of the worker's larger output buffer.
      this.#out.write(this.#out.fd === null ? Buffer.from(body) : body);
    }
  }

  #closePool() {
    this.#pending = [];
    this.#pool?.close();
    this.#pool = null;
  }

  /** Writes the catalog, header, key slots, signature and trailer. Returns a Buffer when writing in memory. */
  finish() {
    if (this.#finished) throw new JazminValidationError('Writer is already finished');
    this.#endTable();
    if (!this.#continue) {
      // Declared tables that were never started are written empty.
      this.#tableDefs.forEach((def, i) => {
        if (this.#written[i]) return;
        this.#beginTable(def, i);
        this.#endTable();
      });
    }
    this.#closePool();
    if (this.#access && this.#shapes.size) {
      // Every key that sees a saved shape must see every column it uses: its text names them.
      const viewers = this.#access.grants.map((g) => ({
        get who() {
          return `${g.key.id}${g.label ? ` (${g.label})` : ''}`;
        },
        columns: g.columns === '*' ? '*' : new Set(g.columns),
        sees: (name) => this.#seesFileGroup(g, name),
      }));
      checkShapes([...this.#shapes.values()], this.#shapeTables(), viewers);
    }

    const cont = this.#continue;
    const segment = cont ? cont.header.appendCount + 1 : 0;
    const tables = cont ? cont.header.tables.map((t, i) => this.#written[i]?.table ?? t) : this.#written.map((w) => w.table);
    const deltas = this.#deltas;
    // Features are named when, and only when, the file uses them (spec 12); an append keeps the file's.
    const readerFeatures = new Set(cont ? cont.header.readerFeatures : []);
    if (this.#usesIndexDeltas) readerFeatures.add(INDEX_DELTAS);
    if (this.#usesNested) readerFeatures.add(NESTED_COLUMNS);
    const header = {
      readerFeatures: [...readerFeatures],
      // file-locks while the file has a lock: writers that would not keep them must not modify it (spec 6.8.1, 12).
      writerFeatures: [
        ...(cont ? cont.header.writerFeatures.filter((f) => f !== FILE_LOCKS && f !== MASKED_COLUMNS) : []),
        ...(this.#locks.size ? [FILE_LOCKS] : []), ...(this.#allMasks().length ? [MASKED_COLUMNS] : []),
      ],
      created: cont ? cont.header.created : this.#options.now,
      modified: cont ? this.#options.now : 0,
      appendCount: segment,
      metadata: JSON.stringify(this.#options.metadata),
      tables,
      keyring: this.#keys ? this.#keys.keyring : null,
      // Package settings are kept with the file directories, also in a file with no stored files (masks, online).
      files: this.#files.entries.size > 0 || this.#shapes.size > 0 || this.#hasPackage() ? this.#writeFileDirectories(segment) : null,
      access: null,
      deltas,
    };

    let keySlots = null;
    let directoryChanged = true;
    if (this.#access) {
      const catalogId = 'owner/catalog';
      // Indexes of every table; when appending, the other tables' come from the file.
      const entry = (table, w) => ({
        table, indexes: w.indexes, chunkMap: w.chunkMap ?? null, chunkMapAppended: w.chunkMapAppended ?? null, chunkMapSegment: w.chunkMapSegment ?? 0,
      });
      const catalog = cont
        ? cont.ownerCatalog.filter((c) => c.table !== this.#tableIndex).concat(entry(this.#tableIndex, this.#written[this.#tableIndex]))
        : this.#written.map((w, table) => entry(table, w));
      catalog.sort((a, b) => a.table - b.table);
      const ownerCatalog = this.#writeSection(encodeOwnerCatalog(catalog), catalogId, sectionKeyFrom(this.#secrets.owner, this.#salt, catalogId));
      const directoryText = this.#ownerDirectoryText();
      directoryChanged = !cont || directoryText !== cont.directoryText;
      const ownerDirectory = directoryChanged
        // Not compressed: its size must not hint at the secrets and names it holds (spec 13, compression side channels).
        ? this.#writeSection(Buffer.from(directoryText, 'utf8'), 'owner', ownerDirectoryKey(this.#secrets.owner, this.#salt), 'none')
        : cont.directoryRef;
      header.access = { ownerDirectory, ownerCatalog };
      if (directoryChanged) {
        // Key slots in pages, then the page list the owner signs (spec 7.6.4). Sealed slots are random bytes:
        // compressing them would only cost time on every open.
        const pages = buildKeySlotPages(this.#keySlots(), this.#options.keySlotPageBytes).map((page, n) => {
          const section = this.#section(page.raw, `keyslots/${n}`, undefined, 'none');
          const ref = { firstId: page.firstId, offset: this.#out.position, length: section.length, digest: digest(section) };
          this.#out.write(section);
          return ref;
        });
        const section = this.#section(buildKeySlotList(pages), 'keyslots', undefined, 'none');
        keySlots = { offset: this.#out.position, length: section.length, section };
        this.#out.write(section);
      } else {
        keySlots = cont.keySlots; // unchanged grants and partitions: the existing slots stay valid (spec 11.2)
      }
    }

    const headerSection = this.#section(encodeHeader(header), 'header', this.#access ? headerKey(this.#secrets.header, this.#salt) : this.#keys?.headerKey);
    const headerOffset = this.#out.position;
    this.#out.write(headerSection);
    let signature = null;
    if (this.#access) {
      const section = this.#section(buildSignature(this.#ownerKey.bytes, this.#fileId, keySlots.section, headerSection), 'signature', undefined, 'none');
      signature = { offset: this.#out.position, length: section.length };
      this.#out.write(section);
    }
    this.#out.sync(); // data first: a trailer must never point at data that is not on disk yet

    const trailer = Buffer.alloc(TRAILER_SIZE);
    trailer.writeBigUInt64LE(BigInt(headerOffset), 0);
    trailer.writeUInt32LE(headerSection.length, 8);
    trailer.writeBigUInt64LE(BigInt(keySlots?.offset ?? 0), 12);
    trailer.writeUInt32LE(keySlots?.length ?? 0, 20);
    trailer.writeBigUInt64LE(BigInt(signature?.offset ?? 0), 24);
    trailer.writeUInt32LE(signature?.length ?? 0, 32);
    trailer.writeUInt32LE(crc32(trailer.subarray(0, 36)), 36);
    MAGIC.copy(trailer, 40);
    this.#out.write(trailer);
    this.#out.sync();

    this.#finished = true;
    return this.#out.close();
  }

  /** Column groups for the header: definitions inline, or (restricted groups) in their own locked section (spec 7.6.5). */
  #columnGroups() {
    const definition = (i) => catalogColumn(this.#columns[i], i);
    const previous = new Map((this.#continue?.table.columnGroups ?? []).map((g) => [g.name, g]));
    return this.#groups.map((g) => {
      if (!this.#access || g.name === DEFAULT_COLUMN_GROUP) return { name: g.name, columns: g.cols.map(definition) };
      let definitions = previous.get(g.name)?.definitions;
      if (!definitions || g.cols.some((c) => this.#continue?.grown?.has(this.#columns[c].name))) { // new, or nested columns grew
        const sectionId = `${this.#tableIndex}/columns/${g.name}`;
        definitions = this.#writeSection(encodeColumnDefinitions(g.cols.map(definition)), sectionId, this.#key(sectionId, this.#secrets.columnSecret(g.name)));
      }
      return { name: g.name, columnCount: g.cols.length, definitions };
    });
  }

  /** Index sections for this writer's rows (one segment per index; spec 8). */
  /** Progress: a chunk of `rows` rows is being written ({ stage: 'write' }); the signal is checked first. */
  #reportRows(rows) {
    const progress = this.#progress;
    progress.signal?.throwIfAborted();
    progress.written += rows;
    progress.onProgress?.({ stage: 'write', done: progress.written, total: progress.total });
  }

  /** Progress: `done` of the table's `total` indexes are built ({ stage: 'indexes' }); the signal is checked first. */
  #reportIndexes(done, total) {
    this.#progress.signal?.throwIfAborted();
    if (done > 0) this.#progress.onProgress?.({ stage: 'indexes', done, total });
  }

  #writeIndexes(segment) {
    const suffix = segment ? `/${segment}` : '';
    const key = (sectionId) => this.#key(sectionId, this.#secrets?.owner, KEYRING_GROUPS.index);
    const count = this.#indexBuilders.length;
    const built = this.#indexBuilders.map((ix, i) => {
      if (this.#progress) this.#reportIndexes(i, count);
      const base = `${this.#tableIndex}/index/${ix.column}/${ix.kind}${suffix}`;
      if (ix.kind === 'trigram') return { column: ix.column, kind: ix.kind, section: this.#writeSection(ix.builder.encode(), base, key(base)), segment };
      const pages = [];
      for (const page of ix.builder.pages(this.#options.pageBytes, this.#indexDeltas)) {
        this.#usesIndexDeltas ||= this.#indexDeltas;
        const sectionId = `${base}/page/${pages.length}`;
        pages.push({ first: page.first, count: page.count, ...this.#writeSection(page.raw, sectionId, key(sectionId)) });
      }
      let nulls = null;
      if (ix.builder.nulls.length) nulls = this.#writeSection(encodePostingsSection(ix.builder.nulls), `${base}/nulls`, key(`${base}/nulls`));
      const directory = encodeIndexDirectory({ pages, nulls }, Boolean(this.#access));
      return { column: ix.column, kind: ix.kind, section: this.#writeSection(directory, base, key(base)), segment };
    });
    if (this.#progress && count) this.#reportIndexes(count, count);
    this.#closeIndexBuilders(); // their temporary runs, if any, are no longer needed
    return built;
  }

  /** Deletes the index builders' temporary runs (sorted indexes past their budget write runs to temporary files). */
  #closeIndexBuilders() {
    for (const ix of this.#indexBuilders) ix.builder.close?.();
  }

  /**
   * Statistics blocks and one chunk-directory segment per partition this writer added rows to (spec 6.3, 6.4).
   * Returns [{ id, idText, segments: [ref] }], sorted by id.
   */
  #writeDirectories() {
    const byPartition = new Map();
    for (const chunk of this.#chunks) {
      if (!byPartition.has(chunk.partition)) byPartition.set(chunk.partition, []);
      byPartition.get(chunk.partition).push(chunk);
    }
    const written = [];
    for (const [partition, chunks] of byPartition) {
      // Segment n of a partition's directory (n > 0 after appends) has ids ending "/n".
      const position = this.#continue?.segmentCounts.get(partition) ?? 0;
      const suffix = position ? `/${position}` : '';
      const secret = this.#access ? this.#secrets.partitionSecret(partition) : null;
      // One block per column for a table without partitions (a query loads only its columns' statistics);
      // one block per column group in access-controlled files (few sections however many partitions). Partitions of
      // a single chunk keep theirs too: the owner's searches across all partitions skip chunks with them.
      const blocks = this.#access ? this.#groups.map((g) => ({ group: g.name, cols: g.cols })) : this.#columns.map((_, i) => ({ group: DEFAULT_COLUMN_GROUP, cols: [i] }));
      const statistics = blocks.map((block, b) => {
        const sectionId = `${this.#tableIndex}/stats/${partition}/${b}${suffix}`;
        const columns = block.cols.map((col) => {
          const bounds = chunks.map((c) => c.stats[col].bounds());
          return { nullCounts: chunks.map((c) => c.stats[col].nulls), min: bounds.map((x) => x.min), max: bounds.map((x) => x.max), leaves: leafEntries(chunks, col) };
        });
        const key = this.#access ? partKey(secret, this.#secrets.columnSecret(block.group), this.#salt, sectionId) : this.#keys?.sectionKey(KEYRING_GROUPS.data, sectionId);
        return { columns: block.cols, section: this.#writeSection(encodeStatistics(columns), sectionId, key) };
      });
      const sectionId = `${this.#tableIndex}/dir/${partition}${suffix}`;
      const ref = this.#writeSection(encodeChunkDirectory({ chunks, statistics }, Boolean(this.#access)), sectionId, this.#key(sectionId, secret));
      written.push({ id: this.#access ? Buffer.from(partition, 'base64url') : Buffer.alloc(0), segments: [ref] });
    }
    return written.sort((a, b) => Buffer.compare(a.id, b.id));
  }

  /**
   * Where the partitions are listed (spec 6.3, 11.2): in the header (at most INLINE_PARTITIONS), or in a
   * partition-table section; an append to a file with a partition table, or one that would list too many
   * partitions in the header, writes a delta with the new segments instead of rewriting the list.
   */
  #placePartitions(table, written, deltas) {
    const cont = this.#continue;
    const writeTable = (partitions) => {
      const sectionId = `${this.#tableIndex}/partitions`;
      // Ids and digests do not compress, and readers scan the table for their own entries: store it as is.
      return this.#writeSection(encodePartitionTable(partitions), sectionId, this.#key(sectionId, this.#secrets?.header), 'none');
    };
    if (!cont) {
      if (written.length > INLINE_PARTITIONS) table.partitionTable = writeTable(written);
      else table.partitions = written;
      return;
    }
    table.partitions = cont.table.partitions.map((p) => ({ id: p.id, segments: [...p.segments] }));
    table.partitionTable = cont.table.partitionTable;
    if (written.length === 0) return;
    const inline = new Map(table.partitions.map((p) => [p.id.toString('hex'), p]));
    const added = written.filter((p) => !inline.has(p.id.toString('hex'))).length;
    if (table.partitionTable || deltas.length || inline.size + added > INLINE_PARTITIONS) {
      const sectionId = `delta/${deltas.length}`;
      deltas.push(this.#writeSection(encodeDelta([{ table: this.#tableIndex, partitions: written }]), sectionId, this.#key(sectionId, this.#secrets?.header)));
      return;
    }
    for (const p of written) {
      const known = inline.get(p.id.toString('hex'));
      if (known) known.segments.push(...p.segments);
      else table.partitions.push(p);
    }
    table.partitions.sort((a, b) => Buffer.compare(a.id, b.id));
  }

  #hasPackage() {
    return this.#package !== undefined && this.#package !== null && (typeof this.#package !== 'object' || Object.keys(this.#package).length > 0);
  }

  /** Writes the file directories (one per file group in access-controlled files); returns the header member. */
  #writeFileDirectories(segment) {
    const entries = [...this.#files.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const byId = new Map([...this.#files.contents.values()].map((c) => [c.id, c]));
    const shapes = [...this.#shapes.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const firstTable = this.#continue ? this.#continue.header.tables[0].name : this.#tableDefs[0].name;
    const savedShape = (s, withGroups) => ({
      name: s.name, ...(s.description ? { description: s.description } : {}), ...(s.default ? { default: true } : {}),
      ...(s.table === undefined || s.table === firstTable ? {} : { table: s.table }), // none: the first table
      ...(withGroups ? { groups: s.groups } : {}), shape: s.shape,
    });
    // A file's actions in a group's directory: the group's own (groupActions), else the file's.
    const actionsIn = (e, group) => (group !== undefined && e.groupActions?.[group]) || e.actions;
    // A locked content's key is not in the directories: they hold it sealed under its lock's key (spec 6.8.1), sealed
    // once per content for every directory that lists it.
    const sealed = new Map();
    const sealedKey = (c) => {
      if (!sealed.has(c.id)) sealed.set(c.id, sealContentKey(this.#locks.get(c.lock), c.id, Buffer.from(c.key, 'base64')).toString('base64'));
      return sealed.get(c.id);
    };
    const lockEntry = (lock, keys) => ({
      id: lock.id, kind: lock.kind, salt: lock.salt.toString('base64'), ...(lock.iterations === undefined ? {} : { iterations: lock.iterations }), keys,
      ...(lock.keyService ? { keyService: lock.keyService } : {}),
    });
    const directory = (list, withGroups, saved, group) => {
      const contents = [...new Set(list.map((e) => e.content))].sort((a, b) => a - b).map((id) => byId.get(id));
      const locks = new Map();
      for (const c of contents) {
        if (c.lock === undefined) continue;
        if (!locks.has(c.lock)) locks.set(c.lock, {});
        locks.get(c.lock)[c.id] = sealedKey(c);
      }
      return {
        files: list.map((e) => {
          const actions = actionsIn(e, group);
          return { path: e.path, type: e.type, content: e.content, ...(withGroups ? { groups: e.groups } : {}), ...(actions && Object.keys(actions).length ? { actions } : {}) };
        }),
        contents: contents.map((c) => {
          if (c.lock === undefined) return c;
          const { key: _, ...locked } = c;
          return locked;
        }),
        ...(locks.size ? { locks: [...locks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, keys]) => lockEntry(this.#locks.get(id), keys)) } : {}),
        ...(saved.length ? { shapes: saved.map((s) => savedShape(s, withGroups)) } : {}),
      };
    };
    const settings = normalizePackage(this.#package, new Set(this.#files.entries.keys()));
    if (settings?.edit) checkEdit(settings.edit, this.#tableDefs, { partial: Boolean(this.#continue) });
    const suffix = segment ? `/${segment}` : '';
    // nextContent: content ids are never reused, so block section ids stay unique across appends.
    const member = { directories: [], nextContent: this.#files.nextId, package: settings ? JSON.stringify(settings) : '', segment };
    const write = (group, sectionId, json, key) => {
      member.directories.push({ group, section: this.#writeSection(Buffer.from(JSON.stringify(json), 'utf8'), sectionId, key) });
    };
    if (!this.#access) {
      const grouped = entries.find((e) => e.groupActions);
      if (grouped) throw new JazminValidationError(`File '${grouped.path}': groupActions need an access-controlled file (only its keys see files by group)`);
      if (this.#keys && !this.#keys.keyring.files) this.#keys.keyring.files = crypto.randomBytes(32);
      const sectionId = `files/dir${suffix}`;
      write(EVERYONE, sectionId, directory(entries, true, shapes), this.#keys?.sectionKey(KEYRING_GROUPS.files, sectionId));
      return member;
    }
    this.#fileGroupNames = [...new Set([...entries.flatMap((e) => e.groups), ...shapes.flatMap((s) => s.groups)])].sort();
    for (const name of this.#fileGroupNames) {
      const id = this.#secrets.partitionId(name); // same opaque HMAC id as partitions
      const sectionId = `files/dir/${id}${suffix}`;
      write(id, sectionId, directory(entries.filter((e) => e.groups.includes(name)), false, shapes.filter((s) => s.groups.includes(name)), name),
        hkdf(this.#secrets.fileGroupSecret(id), this.#salt, `JAZMIN/1/${sectionId}`));
    }
    return member;
  }

  /**
   * Owner-only JSON with the partition names and the grants (including the access keys, so updates can
   * re-issue them). Clients never read it, so its size does not affect them.
   */
  #ownerDirectoryText() {
    // A grant names masked groups in maskedColumns, and every group as those listed with allColumns (spec 7.6.8): a
    // writer that doesn't know masks (1.0-1.6) then grants no one a masked group when it rewrites the file.
    const maskedGroups = new Set(this.#allMasks().map((m) => m.group));
    const grantColumns = (g) => {
      if (!maskedGroups.size) return { columns: g.columns };
      const names = g.columns === '*' ? this.#allGroupNames : g.columns;
      const masked = names.filter((n) => maskedGroups.has(n));
      return { columns: names.filter((n) => !maskedGroups.has(n)), ...(masked.length ? { maskedColumns: masked } : {}), ...(g.columns === '*' ? { allColumns: true } : {}) };
    };
    return JSON.stringify({
      partitions: [...this.#secrets.names],
      ...(this.#fileGroupNames.length ? { fileGroups: this.#fileGroupNames } : {}),
      grants: this.#access.grants.map((g) => ({
        key: g.key.export(), rows: g.rows, ...grantColumns(g), ...(g.label === undefined ? {} : { label: g.label }),
        ...(g.files.length || g.files === '*' ? { files: g.files } : {}),
        ...(g.expires === undefined ? {} : { expires: new Date(g.expires).toISOString() }),
        mode: g.mode,
        ...(g.share ? { share: g.share.toString('base64') } : {}),
      })),
      // Every lock with its key and secret: the owner opens locked files, and rewrites keep the locks (spec 6.8.1).
      ...(this.#locks.size ? { locks: ownerLockList(this.#locks) } : {}),
      // Every masked column, so rewrites and appends keep them and write each key slot again (spec 7.6.8).
      ...(this.#allMasks().length ? { masks: this.#allMasks() } : {}),
    });
  }

  /** Every masked column of the file, as the owner directory keeps them (spec 7.6.8). */
  #allMasks() {
    const cont = this.#continue;
    return [
      ...this.#otherMasks,
      ...this.#tableDefs.flatMap((def, i) => ownerMasks(def.masks ?? [], cont ? cont.tableIndex : i, def.columns)),
    ].sort((a, b) => a.table - b.table || a.position - b.position);
  }

  /** The key slots: one small slot for the owner, one per grant (spec 7.6.4). */
  #keySlots() {
    const s = this.#secrets;
    const b64 = (buf) => buf.toString('base64');
    const allColumns = this.#allGroupNames;
    const header = b64(s.header);

    const slots = [sealSlot(this.#ownerKey.bytes, this.#salt, this.#fileId, { header, owner: b64(s.owner) })];
    const maskedGroups = new Map(this.#allMasks().map((m) => [m.group, m]));
    const ownerFingerprint = fingerprint(this.#ownerKey.ownerPublicKey);
    for (const g of this.#access.grants) {
      if (!g.key.ownerFingerprint.equals(ownerFingerprint)) {
        throw new JazminValidationError(`Access key ${g.key.id} was issued by a different owner key`);
      }
      const partitions = {};
      const partitionNames = {};
      const names = g.rows === '*' ? [...s.partitionNames.values()] : g.rows;
      for (const name of names) {
        const id = s.partitionId(name);
        if (!s.partitionNames.has(id)) continue; // granted partition not present in this version of the file
        partitions[id] = b64(s.partitionSecret(id));
        partitionNames[id] = name;
      }
      // A masked column's group (spec 7.6.8): its secret sealed under its lock, with the column, under `masks`.
      const granted = g.columns === '*' ? allColumns : g.columns;
      const columns = Object.fromEntries(granted.filter((n) => !maskedGroups.has(n)).map((n) => [n, b64(s.columnSecret(n))]));
      const maskGroups = {};
      const maskLocks = {};
      for (const n of granted) {
        const m = maskedGroups.get(n);
        if (!m) continue;
        const lock = this.#locks.get(m.lock);
        maskLocks[lock.id] = {
          kind: lock.kind, salt: b64(lock.salt), ...(lock.iterations === undefined ? {} : { iterations: lock.iterations }),
          ...(lock.keyService ? { keyService: lock.keyService } : {}),
        };
        maskGroups[n] = {
          lock: lock.id, sealed: b64(sealGroupSecret(lock, n, s.columnSecret(n))),
          column: {
            table: m.table, position: m.position, name: m.column, type: m.type,
            ...(m.shown ? { shown: m.shown } : {}), ...(m.unmasked ? { unmasked: m.unmasked } : {}),
          },
        };
      }
      const masks = Object.keys(maskGroups).length ? { masks: { locks: maskLocks, groups: maskGroups } } : {};
      const files = {};
      for (const name of this.#fileGroupNames) {
        const id = s.partitionId(name);
        if (this.#seesFileGroup(g, name, id)) files[id] = b64(s.fileGroupSecret(id));
      }
      const limits = {
        ...(g.expires === undefined ? {} : { expires: new Date(g.expires).toISOString() }),
        ...(g.mode === 'online' ? { online: true } : {}),
      };
      const fileSecrets = Object.keys(files).length ? { files } : {};
      const submission = b64(this.#ownerKey.submissionKey(g.key.id).bytes); // the key of what this holder sends back (spec 7.8)
      slots.push(sealSlot(g.key.secret, this.#salt, this.#fileId, { header, partitions, partitionNames, columns, submission, ...fileSecrets, ...masks, ...limits }, g.share));
    }
    return slots;
  }

  /** File groups a grant's key sees: everyone's, its partitions', and the named ones it was granted. */
  #seesFileGroup(g, name, id = this.#secrets.partitionId(name)) {
    return name === EVERYONE || g.files === '*' || g.files.includes(name)
      || (g.rows === '*' ? this.#secrets.partitionNames.has(id) : g.rows.includes(name));
  }

  /** Abandons the output: a new file is deleted; an appended file is cut back to its previous end. */
  abort() {
    this.#finished = true;
    this.#closeIndexBuilders();
    this.#closePool();
    if (this.#continue) {
      const flags = Buffer.alloc(2);
      flags.writeUInt16LE(this.#continue.flags);
      this.#out.writeAt(FLAGS_OFFSET, flags); // restore the original flags: a failed append leaves no trace
    }
    this.#out.discard();
  }
}

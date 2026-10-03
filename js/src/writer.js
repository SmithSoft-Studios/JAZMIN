// Writes JAZMIN format 1.0 files (docs/rfc/draft-jazmin-format-03.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {
  FileSecrets, KEY_SLOT_PAGE_BYTES, buildKeySlotList, buildKeySlotPages, buildSignature, checkAccessOptions, digest, headerKey,
  normalizeGrants, normalizeTableAccess, ownerDirectoryKey, partKey, partitionName,
  sealSlot, sectionKeyFrom,
} from './access.js';
import { crc32 } from './binary.js';
import {
  encodeChunkDirectory, encodeColumnDefinitions, encodeDelta, encodeHeader, encodeIndexDirectory, encodeOwnerCatalog,
  encodePartitionTable, encodeStatistics,
} from './catalog.js';
import { columnBuffer, encodeColumnBuffers } from './columnar.js';
import { EVERYONE, FILE_BLOCK_SIZE, FILE_SOURCE, fileSource, normalizePackage } from './files.js';
import {
  DEFAULTS, DEFAULT_COLUMN_GROUP, FILE_ID_SIZE, FLAG_ACCESS, FLAG_APPENDED, FLAG_ENCRYPTED, FLAG_PASSWORD, INLINE_PARTITIONS,
  KEYRING_GROUPS, MAGIC, MAX_KDF_ITERATIONS, MIN_KDF_ITERATIONS, PREAMBLE_SIZE, SALT_SIZE, TRAILER_SIZE, WHOLE_TABLE,
} from './constants.js';
import { JazminValidationError } from './errors.js';
import { INDEX_BUILDERS, INDEX_PAGE_BYTES, encodePostingsSection } from './indexes.js';
import { JazminKey, KeySchedule, deriveFromPassword, fingerprint, hkdf, parseAnyKey } from './keys.js';
import { normalizeColumns } from './schema.js';
import { toMs } from './expiry.js';
import { encodeSection } from './section.js';
import { SectionPool } from './section-pool.js';
import { ColumnStats } from './stats.js';
import { compareKeys, normalizeValue, toKey } from './types.js';

const FLAGS_OFFSET = 4; // preamble: magic (4) | flags u16 | reserved u16 | file id | salt | kdf iterations | reserved

const TINY_SECTION = 256; // raw bytes below which catalog sections are not compressed
const STAGE_SIZE = 64 * 1024; // small sections (directories, statistics, envelopes) are written in batches
const STAGE_LIMIT = 8 * 1024;

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

/** Orders two rows by the `sortedBy` columns; nulls sort first. */
function compareSortKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return Number.isNaN(c) ? 0 : c;
  }
  return 0;
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
 * A table's definition, checked (spec 6.2): { name, columns, sortedBy, sortCols, chunkRows, chunkBytes, partitionBy,
 * partitionCol, columnGroups }. Partition columns and column groups belong to access-controlled files.
 */
function tableDefinition(t, { named, access, chunkRows, chunkBytes }) {
  if (t === null || typeof t !== 'object') throw new JazminValidationError('Each table must be an object');
  if (named && (typeof t.name !== 'string' || t.name === '')) throw new JazminValidationError('Each table needs a name');
  const columns = normalizeColumns(t.columns);
  const rows = t.chunkRows ?? chunkRows;
  if (!Number.isInteger(rows) || rows < 1) throw new JazminValidationError('chunkRows must be a positive integer');
  let sortCols = null;
  if (t.sortedBy !== undefined) {
    if (!Array.isArray(t.sortedBy) || t.sortedBy.length === 0) throw new JazminValidationError('sortedBy must be a non-empty array of column names');
    sortCols = t.sortedBy.map((name) => {
      const i = columns.findIndex((c) => c.name === name);
      if (i < 0) throw new JazminValidationError(`sortedBy: unknown column '${name}'`);
      return i;
    });
  }
  let layout = { partitionBy: null, partitionCol: -1, columnGroups: [{ name: DEFAULT_COLUMN_GROUP, cols: columns.map((_, i) => i) }] };
  if (access) {
    layout = normalizeTableAccess(t, columns);
    for (const i of sortCols ?? []) {
      if (layout.columnGroups[0].name !== DEFAULT_COLUMN_GROUP || !layout.columnGroups[0].cols.includes(i)) {
        throw new JazminValidationError(`The sortedBy column '${columns[i].name}' must stay in the default column group`);
      }
    }
  } else if ((t.partitionBy !== undefined && t.partitionBy !== null) || t.columnGroups !== undefined) {
    throw new JazminValidationError('partitionBy and columnGroups need an access-controlled file (the access option)');
  }
  return { name: t.name ?? '', columns, sortedBy: t.sortedBy, sortCols, chunkRows: rows, chunkBytes: t.chunkBytes ?? chunkBytes, ...layout };
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
 */
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
  #continue = null; // append mode: state of the file being continued
  #files = { entries: new Map(), contents: new Map(), nextId: 0 }; // embedded files (spec 6.8): path -> entry, sha256 -> stored content
  #package; // package settings for viewers (validated at finish)
  #fileGroupNames = []; // access mode: names of the file groups written
  #parallelism; // threads encoding chunk sections (1 = this thread only)
  #pool = null; // SectionPool, started from the third chunk so small files never pay for workers
  #pending = []; // chunk parts being encoded by the pool, in file order: { entry, group }

  constructor(target, options = {}) {
    const {
      columns, metadata = {}, codec = DEFAULTS.codec, level, chunkRows = DEFAULTS.chunkRows,
      chunkBytes = DEFAULTS.chunkBytes, key, password, kdfIterations = DEFAULTS.kdfIterations, sortedBy, access, now,
      layout, files, package: packageSettings, tables,
      maxDegreeOfParallelism = Math.max(1, Math.min(os.availableParallelism() - 1, 2)),
    } = options;
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
    };
    const cont = options[CONTINUE];
    this.#continue = cont ?? null;
    if (access !== undefined) checkAccessOptions(access);
    if (tables !== undefined) {
      if (!Array.isArray(tables) || tables.length === 0) throw new JazminValidationError('tables must be a non-empty array of table definitions');
      if (columns !== undefined || sortedBy !== undefined || access?.partitionBy != null || access?.columnGroups !== undefined) {
        throw new JazminValidationError('With tables, give columns, sortedBy, partitionBy and columnGroups in each table');
      }
    }
    const definitions = tables ?? [{ name: cont?.table.name ?? '', columns, sortedBy, partitionBy: access?.partitionBy, columnGroups: access?.columnGroups }];
    this.#tableDefs = definitions.map((t) => tableDefinition(t, { named: tables !== undefined, access: Boolean(access), chunkRows, chunkBytes }));
    const names = new Set();
    for (const t of tables ? this.#tableDefs : []) {
      if (names.has(t.name)) throw new JazminValidationError(`Table '${t.name}' is declared twice`);
      names.add(t.name);
    }
    // Column groups a grant may name: those of every table (when appending, of the file's other tables too).
    this.#allGroupNames = [...new Set([
      ...this.#tableDefs.flatMap((t) => t.columnGroups.map((g) => g.name)),
      ...(cont?.header.tables ?? []).flatMap((t) => t.columnGroups.map((g) => g.name)),
    ])];

    this.#fileId = cont ? cont.fileId : crypto.randomBytes(FILE_ID_SIZE);
    this.#salt = cont ? cont.salt : key || password || access ? crypto.randomBytes(SALT_SIZE) : Buffer.alloc(SALT_SIZE);
    if (access) {
      const owner = key ? parseAnyKey(key) : null;
      if (!(owner instanceof JazminKey)) throw new JazminValidationError("An access-controlled file needs the owner's master key (jzk1-...) as `key`");
      this.#ownerKey = owner;
      this.#access = normalizeGrants(access.grants, new Set(this.#allGroupNames), this.#options.now);
      // Same file, same secrets when appending: new sections must be readable with those already in use.
      this.#secrets = cont ? new FileSecrets(this.#salt, cont.ownerSecrets.header, cont.ownerSecrets.owner) : new FileSecrets(this.#salt);
      for (const name of cont?.directory.partitions ?? []) this.#secrets.addPartition(name);
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
    if (cont) {
      this.#out = new Output(target, cont.validEnd);
      const flags = Buffer.alloc(2);
      flags.writeUInt16LE(cont.flags | FLAG_APPENDED);
      this.#out.patch(FLAGS_OFFSET, flags); // set before anything else is written (spec 11.2)
    } else {
      this.#out = new Output(target);
      this.#out.write(this.#preamble());
    }
    if (cont?.files) {
      // Files already in the file stay; their stored contents are reused by reference.
      for (const e of cont.files.entries) this.#files.entries.set(e.path, e);
      for (const c of cont.files.contents) this.#files.contents.set(c.sha256, c);
      this.#files.nextId = cont.files.nextId;
    }
    this.#package = packageSettings !== undefined ? packageSettings : cont?.files?.package;
    for (const f of files ?? []) this.addFile(f);
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
    let stored = this.#files.contents.get(src.sha256);
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
      stored = { id, size: src.size, sha256: src.sha256, blockSize: FILE_BLOCK_SIZE, ...(key ? { key: key.toString('base64') } : {}), blocks };
      this.#files.contents.set(src.sha256, stored);
    }
    this.#files.entries.set(src.path, { path: src.path, type: src.type, groups: src.groups, content: stored.id });
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
    this.#values = new Array(def.columns.length);
    this.#sortCols = def.sortCols;
    this.#lastSortKey = null;
    this.#groups = def.columnGroups.map((g) => ({ name: g.name, cols: g.cols }));
    this.#chunks = [];
    this.#chunkPartition = null;
    this.#indexBuilders = [];
    def.columns.forEach((column, col) => {
      for (const kind of column.index) {
        this.#indexBuilders.push({ col, column: column.name, kind, builder: new INDEX_BUILDERS[kind](column.type) });
      }
    });
    const cont = this.#continue;
    this.#rowCount = cont ? cont.table.rowCount : 0;
    this.#firstOrdinal = cont ? cont.table.chunkCount : 0;
    if (cont && this.#sortCols && cont.lastRow) {
      this.#lastSortKey = this.#sortCols.map((i) => {
        const v = normalizeValue(this.#columns[i].type, cont.lastRow[this.#columns[i].name], this.#columns[i].name);
        return v === null ? null : toKey(this.#columns[i].type, v);
      });
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
    this.#written[t] = { table, indexes };
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
      group.buffers ??= group.cols.map((i) => columnBuffer(this.#columns[i].type, this.#current.chunkRows));
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
    const rowNumber = this.#rowCount;
    for (const name in row) {
      if (!this.#names.has(name)) throw new JazminValidationError(`Row ${rowNumber}: unknown column '${name}'`);
    }
    const columns = this.#columns;
    const values = this.#values;
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const value = normalizeValue(c.type, row[c.name], c.name);
      if (value === null && !c.nullable) throw new JazminValidationError(`Row ${rowNumber}: column '${c.name}' is not nullable`);
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
        group.bytes += estimateSize(columns[col].type, v);
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
    const key = this.#sortCols.map((i) => (values[i] === null ? null : toKey(this.#columns[i].type, values[i])));
    if (this.#lastSortKey && compareSortKeys(this.#lastSortKey, key) > 0) {
      throw new JazminValidationError(`Row ${rowNumber} is out of order for sortedBy [${this.#current.sortedBy.join(', ')}]`);
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
    const ordinal = this.#firstOrdinal + this.#chunks.length;
    const partition = this.#access ? this.#secrets.addPartition(this.#chunkPartition) : WHOLE_TABLE;
    const entry = {
      ordinal, rowStart: this.#rowCount - this.#chunkRows, rowCount: this.#chunkRows, partition,
      parts: this.#groups.map(() => ({ offset: 0, length: 0 })), stats: this.#chunkStats,
    };
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

    const cont = this.#continue;
    const segment = cont ? cont.header.appendCount + 1 : 0;
    const tables = cont ? cont.header.tables.map((t, i) => this.#written[i]?.table ?? t) : this.#written.map((w) => w.table);
    const deltas = this.#deltas;
    const header = {
      readerFeatures: [],
      writerFeatures: [],
      created: cont ? cont.header.created : this.#options.now,
      modified: cont ? this.#options.now : 0,
      appendCount: segment,
      metadata: JSON.stringify(this.#options.metadata),
      tables,
      keyring: this.#keys ? this.#keys.keyring : null,
      files: this.#files.entries.size > 0 ? this.#writeFileDirectories(segment) : null,
      access: null,
      deltas,
    };

    let keySlots = null;
    let directoryChanged = true;
    if (this.#access) {
      const catalogId = 'owner/catalog';
      // Indexes of every table; when appending, the other tables' come from the file.
      const catalog = cont
        ? cont.ownerCatalog.filter((c) => c.table !== this.#tableIndex).concat({ table: this.#tableIndex, indexes: this.#written[this.#tableIndex].indexes })
        : this.#written.map((w, table) => ({ table, indexes: w.indexes }));
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
    const definition = (i) => {
      const c = this.#columns[i];
      return {
        position: i, name: c.name, type: c.type, required: !c.nullable,
        description: c.description, attributes: c.attributes ? JSON.stringify(c.attributes) : undefined,
      };
    };
    const previous = new Map((this.#continue?.table.columnGroups ?? []).map((g) => [g.name, g]));
    return this.#groups.map((g) => {
      if (!this.#access || g.name === DEFAULT_COLUMN_GROUP) return { name: g.name, columns: g.cols.map(definition) };
      let definitions = previous.get(g.name)?.definitions;
      if (!definitions) {
        const sectionId = `${this.#tableIndex}/columns/${g.name}`;
        definitions = this.#writeSection(encodeColumnDefinitions(g.cols.map(definition)), sectionId, this.#key(sectionId, this.#secrets.columnSecret(g.name)));
      }
      return { name: g.name, columnCount: g.cols.length, definitions };
    });
  }

  /** Index sections for this writer's rows (one segment per index; spec 8). */
  #writeIndexes(segment) {
    const suffix = segment ? `/${segment}` : '';
    const key = (sectionId) => this.#key(sectionId, this.#secrets?.owner, KEYRING_GROUPS.index);
    return this.#indexBuilders.map((ix) => {
      const base = `${this.#tableIndex}/index/${ix.column}/${ix.kind}${suffix}`;
      if (ix.kind === 'trigram') return { column: ix.column, kind: ix.kind, section: this.#writeSection(ix.builder.encode(), base, key(base)), segment };
      const pages = [];
      for (const page of ix.builder.pages(this.#options.pageBytes)) {
        const sectionId = `${base}/page/${pages.length}`;
        pages.push({ first: page.first, count: page.count, ...this.#writeSection(page.raw, sectionId, key(sectionId)) });
      }
      let nulls = null;
      if (ix.builder.nulls.length) nulls = this.#writeSection(encodePostingsSection(ix.builder.nulls), `${base}/nulls`, key(`${base}/nulls`));
      const directory = encodeIndexDirectory({ pages, nulls }, Boolean(this.#access));
      return { column: ix.column, kind: ix.kind, section: this.#writeSection(directory, base, key(base)), segment };
    });
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
          return { nullCounts: chunks.map((c) => c.stats[col].nulls), min: bounds.map((x) => x.min), max: bounds.map((x) => x.max) };
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

  /** Writes the file directories (one per file group in access-controlled files); returns the header member. */
  #writeFileDirectories(segment) {
    const entries = [...this.#files.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const byId = new Map([...this.#files.contents.values()].map((c) => [c.id, c]));
    const directory = (list, withGroups) => ({
      files: list.map((e) => ({ path: e.path, type: e.type, content: e.content, ...(withGroups ? { groups: e.groups } : {}) })),
      contents: [...new Set(list.map((e) => e.content))].sort((a, b) => a - b).map((id) => byId.get(id)),
    });
    const settings = normalizePackage(this.#package, new Set(this.#files.entries.keys()));
    const suffix = segment ? `/${segment}` : '';
    // nextContent: content ids are never reused, so block section ids stay unique across appends.
    const member = { directories: [], nextContent: this.#files.nextId, package: settings ? JSON.stringify(settings) : '', segment };
    const write = (group, sectionId, json, key) => {
      member.directories.push({ group, section: this.#writeSection(Buffer.from(JSON.stringify(json), 'utf8'), sectionId, key) });
    };
    if (!this.#access) {
      if (this.#keys && !this.#keys.keyring.files) this.#keys.keyring.files = crypto.randomBytes(32);
      const sectionId = `files/dir${suffix}`;
      write(EVERYONE, sectionId, directory(entries, true), this.#keys?.sectionKey(KEYRING_GROUPS.files, sectionId));
      return member;
    }
    this.#fileGroupNames = [...new Set(entries.flatMap((e) => e.groups))].sort();
    for (const name of this.#fileGroupNames) {
      const id = this.#secrets.partitionId(name); // same opaque HMAC id as partitions
      const sectionId = `files/dir/${id}${suffix}`;
      write(id, sectionId, directory(entries.filter((e) => e.groups.includes(name)), false),
        hkdf(this.#secrets.fileGroupSecret(id), this.#salt, `JAZMIN/1/${sectionId}`));
    }
    return member;
  }

  /**
   * Owner-only JSON with the partition names and the grants (including the access keys, so updates can
   * re-issue them). Clients never read it, so its size does not affect them.
   */
  #ownerDirectoryText() {
    return JSON.stringify({
      partitions: [...this.#secrets.partitionNames.values()],
      ...(this.#fileGroupNames.length ? { fileGroups: this.#fileGroupNames } : {}),
      grants: this.#access.grants.map((g) => ({
        key: g.key.toString(), rows: g.rows, columns: g.columns, ...(g.label === undefined ? {} : { label: g.label }),
        ...(g.files.length || g.files === '*' ? { files: g.files } : {}),
        ...(g.expires === undefined ? {} : { expires: new Date(g.expires).toISOString() }),
        mode: g.mode,
        ...(g.share ? { share: g.share.toString('base64') } : {}),
      })),
    });
  }

  /** The key slots: one small slot for the owner, one per grant (spec 7.6.4). */
  #keySlots() {
    const s = this.#secrets;
    const b64 = (buf) => buf.toString('base64');
    const allColumns = this.#allGroupNames;
    const header = b64(s.header);

    const slots = [sealSlot(this.#ownerKey.bytes, this.#salt, this.#fileId, { header, owner: b64(s.owner) })];
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
      const columns = Object.fromEntries((g.columns === '*' ? allColumns : g.columns).map((n) => [n, b64(s.columnSecret(n))]));
      // File groups this key sees: everyone's, its partitions', and the named ones it was granted.
      const files = {};
      for (const name of this.#fileGroupNames) {
        const id = s.partitionId(name);
        const visible = name === EVERYONE || g.files === '*' || g.files.includes(name)
          || (g.rows === '*' ? s.partitionNames.has(id) : g.rows.includes(name));
        if (visible) files[id] = b64(s.fileGroupSecret(id));
      }
      const limits = {
        ...(g.expires === undefined ? {} : { expires: new Date(g.expires).toISOString() }),
        ...(g.mode === 'online' ? { online: true } : {}),
      };
      const fileSecrets = Object.keys(files).length ? { files } : {};
      slots.push(sealSlot(g.key.secret, this.#salt, this.#fileId, { header, partitions, partitionNames, columns, ...fileSecrets, ...limits }, g.share));
    }
    return slots;
  }

  /** Abandons the output: a new file is deleted; an appended file is cut back to its previous end. */
  abort() {
    this.#finished = true;
    this.#closePool();
    if (this.#continue) {
      const flags = Buffer.alloc(2);
      flags.writeUInt16LE(this.#continue.flags);
      this.#out.writeAt(FLAGS_OFFSET, flags); // restore the original flags: a failed append leaves no trace
    }
    this.#out.discard();
  }
}

// Type definitions for the JAZMIN JavaScript library.

/** `list` and `object` columns (nested columns, spec 5.4) store their items or fields as columns of their own. */
export type JazminType = 'bool' | 'int' | 'float' | 'decimal' | 'string' | 'datetime' | 'binary' | 'json' | 'list' | 'object';
export type JazminIndexKind = 'sorted' | 'trigram';
export type JazminCodec = 'none' | 'deflate' | 'brotli';
/**
 * What reading or writing favours where memory and speed pull apart (default 'balanced'). It sets the default
 * thread count; the file written and the rows read are the same whichever is chosen.
 */
export type JazminPriority = 'memory' | 'balanced' | 'speed';

/** Values as returned by readers. A list is an array of its items' values; an object has every field. */
export type JazminValue = boolean | number | bigint | string | Date | Buffer | JsonValue | JazminValue[] | { [field: string]: JazminValue } | null;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JazminRow = Record<string, JazminValue>;

export interface JazminColumnInput {
  name: string;
  type: JazminType;
  /** Default true. */
  nullable?: boolean;
  description?: string;
  /** Free-form details (units, format hints, max length...). */
  attributes?: Record<string, JsonValue>;
  index?: JazminIndexKind | JazminIndexKind[];
  /** A list column's items: their type and, for lists and objects within lists, their own parts. */
  item?: JazminPartInput;
  /** An object column's fields, in order (at least one, unique names). */
  fields?: (JazminPartInput & { name: string })[];
}

/** A list's item or an object's field (nested columns, spec 5.4): never indexed; at most 64 levels deep. */
export interface JazminPartInput {
  /** Fields need one; an item is named 'item'. */
  name?: string;
  type: JazminType;
  /** Default true. */
  nullable?: boolean;
  description?: string;
  attributes?: Record<string, JsonValue>;
  item?: JazminPartInput;
  fields?: (JazminPartInput & { name: string })[];
}

export interface JazminColumn {
  name: string;
  type: JazminType;
  nullable: boolean;
  description?: string;
  attributes?: Record<string, JsonValue>;
  /** List columns: their items. */
  item?: JazminColumn;
  /** Object columns: their fields, in order. */
  fields?: JazminColumn[];
}

export type KeyInput = JazminKey | JazminAccessKey | string | Uint8Array;

/** A grant in an access-controlled file. '*' (or omitted) means all. */
export interface Grant {
  key: JazminAccessKey | string;
  /** Partition names (values of partitionBy) this key may see. */
  rows?: '*' | string[];
  /** Column group names ('*' is the default group) this key may see. */
  columns?: '*' | string[];
  label?: string;
  /** Absolute end of access (Date, ISO string or epoch ms). */
  expires?: Date | string | number;
  /** End of access relative to when the file is written: '2h', '14d', '5y', ... or ms. */
  expiresIn?: string | number;
  /** 'offline' (default): enforced by the library. 'online': opening also needs an unlock token from your key service. */
  mode?: 'offline' | 'online';
  /** Extra file groups this key may see (embedded files), besides '*' and groups named like its partitions. */
  files?: '*' | string[];
}

/** A file to embed: give `content` (bytes or text) or `file` (a path on disk, read in blocks). */
export interface FileInput {
  /** Relative path with '/' separators, e.g. 'img/logo.png'. */
  path: string;
  content?: Uint8Array | string;
  file?: string;
  /** Media type (default: from the extension). */
  type?: string;
  /** Groups that may see the file: '*' (default: everyone with a key) or partition / named file-group names. */
  groups?: '*' | string[];
}

export interface FileInfo {
  path: string;
  type: string;
  size: number;
  sha256: string;
  /** Present for the owner and for single-key files. */
  groups?: string[];
}

/** Settings for viewers that render a file's embedded website. */
export interface PackageSettings {
  entry?: string;
  title?: string;
  /** https origins the rendered page may contact. */
  allowedOrigins?: string[];
  allowWasm?: boolean;
}

/** Where readers keep each expiring key's last-seen time (to detect a clock being set back). */
export type AccessState = false | { dir: string } | { read(name: string): string | undefined; write(name: string, text: string): void };

/** Makes a file access-controlled. Requires the owner's JazminKey as `key`. */
export interface AccessOptions {
  /** String or int column whose value names each row's partition, e.g. 'section'. */
  partitionBy?: string;
  /** Named column groups, e.g. { pii: ['salary', 'idNumber'] }. Other columns form group '*'. */
  columnGroups?: Record<string, string[]>;
  grants?: Grant[];
}

export interface AccessInfo {
  isOwner: boolean;
  partitionBy: string | null;
  columnGroups: string[];
  visiblePartitions: string[];
  visibleColumnGroups: string[];
  /** Access keys: whether opening needs an unlock token, and when access ends. */
  online?: boolean;
  expires?: string;
  /** Owner only. */
  grants?: { keyId: string; rows: '*' | string[]; columns: '*' | string[]; label?: string; mode: 'offline' | 'online'; expires?: string }[];
  /** Owner only: the columns of each column group ('*' holds the columns of no named group). */
  groupColumns?: Record<string, string[]>;
}

/** One table of a file with several (WriteOptions.tables; docs/design/several-tables.md). */
export interface TableDefinition {
  /** Unique and non-empty. */
  name: string;
  columns: JazminColumnInput[];
  sortedBy?: string[];
  /** Access-controlled files: the partition column. Partition names are shared by every table of the file. */
  partitionBy?: string;
  /** Access-controlled files: this table's restricted column groups. Group names are shared too. */
  columnGroups?: Record<string, string[]>;
  /** Default: the writer's chunkRows / chunkBytes. Small chunks (e.g. 256) suit tables looked up by key. */
  chunkRows?: number;
  chunkBytes?: number;
}

export interface WriteOptions {
  /** Omit to infer the schema from the rows. */
  columns?: JazminColumnInput[];
  /**
   * Several tables, written one after another (JazminWriter.startTable), instead of columns, sortedBy and
   * access.partitionBy / columnGroups. Grants and keys stay file-wide.
   */
  tables?: TableDefinition[];
  metadata?: Record<string, JsonValue>;
  codec?: JazminCodec;
  /** Deflate 0-9, Brotli 0-11. */
  level?: number;
  /** Rows per chunk (default 4096). Smaller = finer random access. */
  chunkRows?: number;
  /** Flush a chunk once it reaches this many raw bytes (default 1 MiB). */
  chunkBytes?: number;
  /**
   * Threads compressing (and encrypting) chunks: worker threads start from the third chunk, so small files
   * never pay for them. 1 = this thread only (lowest memory). Default by priority: 'balanced' and 'speed' up
   * to 2 (more threads did not write faster), 'memory' 1; at most one fewer than the processors.
   */
  maxDegreeOfParallelism?: number;
  /** Memory or speed first (default 'balanced'): sets the default of maxDegreeOfParallelism. */
  priority?: JazminPriority;
  /**
   * Sorted indexes with keys and first row ids as differences from the previous entry's (reader feature
   * 'index-deltas'): much smaller for whole numbers and dates, and lookups as fast or faster. Readers before 1.2 refuse
   * such files, naming the feature. Default false until 2.0. An append keeps the file's choice.
   */
  compactIndexes?: boolean;
  /** Files to embed. Identical content is stored once. */
  files?: FileInput[];
  package?: PackageSettings;
  key?: KeyInput;
  password?: string;
  /** PBKDF2 iterations for password encryption (default 600000). */
  kdfIterations?: number;
  /** Shorthand to add indexes: { country: 'sorted', name: ['trigram'] }. */
  indexes?: Record<string, JazminIndexKind | JazminIndexKind[]>;
  /** Detect ISO-8601 strings as datetime when inferring a schema. */
  detectDates?: boolean;
  /** Rows must arrive in this column order; recorded so updates can merge in place. */
  sortedBy?: string[];
  access?: AccessOptions;
  /** Clock used for expiry calculations and file dates (default: the system clock). */
  now?: Date | number;
}

export interface ReadOptions {
  key?: KeyInput;
  password?: string;
  /** Online access keys: the "jzu1-..." token from the owner's key service. */
  unlockToken?: string;
  /**
   * Clock for expiry checks (default: the system clock).
   * @deprecated Removed in 2.0: setting it back lets an expired key open the file (docs/SECURITY-REVIEW.md, D1).
   */
  now?: Date | number;
  /** Expiring keys: where the last-seen record is kept (default: the user's app-data folder). */
  accessState?: AccessState;
  /** The table to read, by name (default: the first). */
  table?: string;
  /**
   * Memory or speed first (default 'balanced'). With 'speed', scans of files with one column group decompress the
   * next chunks on worker threads (up to 4; 2 for scans of more than a quarter of the columns) while rows are built.
   */
  priority?: JazminPriority;
}

/** Operators for one column (GraphQL-style "where" input). */
export interface Condition {
  eq?: unknown;
  ne?: unknown;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  in?: unknown[];
  contains?: string;
  icontains?: string;
  startsWith?: string;
  isNull?: boolean;
}

/** `{ column: value }` is shorthand for `{ column: { eq: value } }`; keys in one object are ANDed. */
export type Filter = {
  and?: Filter[];
  or?: Filter[];
  not?: Filter;
} & { [column: string]: Condition | string | number | bigint | boolean | Date | null | Filter[] | Filter | undefined };

export interface QueryOptions {
  select?: string[];
  limit?: number;
  offset?: number;
}

export interface ExportOptions extends QueryOptions {
  filter?: Filter;
  /** JSON only. */
  pretty?: boolean;
  /** JSON only: leave out null properties. */
  omitNulls?: boolean;
  /** CSV only. */
  delimiter?: string;
  /** JSON and XML: the structure of the output (docs/design/export-shapes.md). Use instead of select/limit/offset. */
  shape?: ExportShape;
  /** XML with a shape: the root element (default 'export'). */
  root?: string;
}

/**
 * A node of an export shape: a column name (in a set of rows: its first value), a literal, an object of
 * nodes, a list (`$rows`), a constant (`$value`), a metadata member (`$meta`) or an aggregate.
 */
export type ShapeNode =
  | string | number | boolean | null
  | ShapeObject | ShapeList | ShapeLinkedList | ShapeLinkedOne
  | { $value: JsonValue } | { $meta: string }
  | { $count: true } | { $sum: string } | { $min: string } | { $max: string };

export interface ShapeObject { [member: string]: ShapeNode }

/** A list: one item per row, or per distinct `$groupBy` key (the item then sees the group's rows). */
export interface ShapeList {
  $rows: ShapeNode;
  $filter?: Filter;
  $groupBy?: string | string[];
  /** Column names; prefix with '-' for descending. Nulls first. */
  $sort?: string[];
  $limit?: number;
  /** XML element name of each item (default 'item'). */
  $xmlItem?: string;
}

/**
 * A list of the rows of another table of the file, linked to the row (or set) it is written for
 * (docs/design/export-shapes.md section 7). Column names inside are the linked table's.
 */
export interface ShapeLinkedList extends Omit<ShapeList, '$rows'> {
  /** The linked table. */
  $from: string;
  /** Linked table's column -> this row's column, e.g. { customer_id: 'id' }; every pair must be equal. */
  $on: Record<string, string>;
  $rows: ShapeNode;
}

/** The linked rows of another table as one set: first values, aggregates and lists; null when none are linked. */
export interface ShapeLinkedOne {
  $from: string;
  $on: Record<string, string>;
  $filter?: Filter;
  $one: ShapeNode;
}

export type ExportShape = ShapeObject | ShapeList;

export type QueryPlan =
  | { strategy: 'index'; candidateRows: number }
  | { strategy: 'scan'; chunks: number; chunksSkipped: number };

/** reader.advise(): layout advice from chunk directories and statistics (no rows decoded). */
/** Column values as arrays (JazminReader.columnArrays). */
export interface ColumnArrays {
  rowCount: number;
  /** int, float and datetime (milliseconds) as Float64Array; bool as Uint8Array (1 = true); other types as arrays. */
  values: Record<string, Float64Array | Uint8Array | unknown[]>;
  /** For typed columns with nulls: bit (i & 7) of byte (i >> 3) is set where row i is null (the value is NaN, or 0). */
  nulls: Record<string, Uint8Array>;
}

export interface LayoutAdvice {
  rows: number;
  chunks: number;
  rowsPerChunk: number;
  bytesPerChunk: number;
  sortedBy: string[];
  /** Per requested column: how many chunks the rows of one value lie in, and what reading one value costs. */
  columns: { column: string; indexed: boolean; chunksPerValue: number | null; bytesPerValue: number | null; distinctValues: number | null }[];
  /** Access-controlled files: each partition's chunks and rows. */
  partitions: { partition: string; chunks: number; rows: number }[];
  /** A sortedBy or chunkRows that would make those lookups read less, partitions compact({ regroup: true }) would merge. */
  suggestions: string[];
}

/** What a query read: explain(filter, { analyze: true }). */
export interface QueryCost {
  /** Rows the query returned. */
  rows: number;
  /** Bytes of the sections read: chunks, index pages, statistics and directories. */
  bytesRead: number;
  /** Chunks read and decoded. */
  chunksRead: number;
  /** Index sections read: index directories, pages and trigram indexes. */
  indexPagesRead: number;
  /** Column streams decoded: one per column per chunk. */
  columnsDecoded: number;
  /** Time taken, in milliseconds. */
  ms: number;
}

export class JazminKey {
  constructor(bytes: Uint8Array);
  static generate(): JazminKey;
  /** Parses "jzk1-..." text; throws JazminKeyError on a checksum mismatch. */
  static parse(text: string): JazminKey;
  static from(value: JazminKey | string | Uint8Array): JazminKey;
  readonly bytes: Buffer;
  /** 65-byte uncompressed P-256 public key used to sign access-controlled files. */
  readonly ownerPublicKey: Buffer;
  /** Issues a new access key; grant it rows/columns with `access.grants` or grantAccess(). */
  createAccessKey(): JazminAccessKey;
  /**
   * The submission key of one of this owner's access keys (spec 7.8): the key of the files its holder sends back.
   * The holder gets the same key from the shared file (reader.submissionKey).
   */
  submissionKey(accessKey: JazminAccessKey | string): JazminKey;
  /** The key's secret text ("jzk1-..."), to store in a secret manager or pass to parse(). Keep it out of logs. */
  export(): string;
  /** @deprecated To get the key's secret text, use export(): from 2.0, toString() won't print the secret. */
  toString(): string;
}

/** Opens only the parts of an access-controlled file it was granted ("jza1-..."). */
export class JazminAccessKey {
  constructor(secret: Uint8Array, ownerFingerprint: Uint8Array);
  static parse(text: string): JazminAccessKey;
  readonly secret: Buffer;
  readonly ownerFingerprint: Buffer;
  /** Short public identifier, safe to log. */
  readonly id: string;
  /** The key's secret text ("jza1-..."), to send to its holder or pass to parse(). Keep it out of logs. */
  export(): string;
  /** @deprecated To get the key's secret text, use export(): from 2.0, toString() prints only the key's id. */
  toString(): string;
}

export interface UpdateOptions {
  /** Required for encrypted files; the OWNER key for access-controlled files. */
  key?: KeyInput;
  password?: string;
  insert?: Record<string, unknown>[];
  /** Replace rows whose keyColumns match; insert the rest. */
  upsert?: Record<string, unknown>[];
  keyColumns?: string[];
  delete?: Filter;
  /** Merged into the existing metadata. */
  metadata?: Record<string, JsonValue>;
  grant?: Grant[];
  revoke?: (JazminAccessKey | string)[];
  codec?: JazminCodec;
  level?: number;
  chunkRows?: number;
  chunkBytes?: number;
  /** Threads compressing chunks (default by priority, as for a new file; 1 = this thread only). */
  maxDegreeOfParallelism?: number;
  /** Memory or speed first while the file is rewritten (default 'balanced'). */
  priority?: JazminPriority;
  /** Sorted indexes with keys as differences (see WriteOptions.compactIndexes). Default: as the file has them. */
  compactIndexes?: boolean;
  /** Clock used to drop expired grants (default: the system clock). */
  now?: Date | number;
  /** Embedded files to add (a path that exists is replaced). */
  addFiles?: FileInput[];
  /** Paths of embedded files to remove. */
  removeFiles?: string[];
  package?: PackageSettings;
  /** The table the rows change in (default: the first). The file's other tables are kept. */
  table?: string;
}

export interface UpdateResult {
  rowCount: number;
  inserted: number;
  updated: number;
  deleted: number;
  /** Grants dropped because they had expired. */
  expiredGrantsRemoved: number;
}

/** Streams the file into a new version with the changes applied, then atomically replaces it. */
export function update(path: string, options: UpdateOptions): UpdateResult;

export interface AppendOptions extends Omit<UpdateOptions, 'revoke' | 'compactIndexes'> {
  /** Compact automatically afterwards when either threshold is reached. */
  autoCompact?: { deletedRatio?: number; appends?: number };
}

export interface AppendResult extends UpdateResult {
  appendCount: number;
  deletedRowCount: number;
  compacted: boolean;
}

/**
 * Applies changes by appending them to the end of the file (existing bytes are never modified).
 * Cost is proportional to the change. Deleted/replaced rows are recorded and removed by compact().
 * In a sortedBy file, appended rows must sort after the existing rows.
 */
export function append(path: string, options: AppendOptions): AppendResult;

/** Key service: the unlock token for an online grant, if it exists and has not expired (owner key required). */
export function issueUnlockToken(path: string, ownerKey: KeyInput, accessKey: JazminAccessKey | string, options?: { now?: Date | number }): string;
/** The access key a shared file grants, by its id or the key itself, from the grant list (owner key required). */
export function accessKeyOf(path: string, ownerKey: KeyInput, accessKey: JazminAccessKey | string): JazminAccessKey;
/** Key service: every online grant's token, for services that store them. */
export function listUnlockTokens(path: string, ownerKey: KeyInput): { keyId: string; label?: string; expires?: string; token: string }[];
/** What can be read without a key: the file id (send it with a key id to your key service) and its features. */
export function inspect(path: string): {
  fileId: string; version: string; encrypted: boolean; passwordProtected: boolean; accessControlled: boolean; appended: boolean;
};

/**
 * Rewrites the file in full: drops deleted rows and superseded data, re-locks with fresh secrets. With `regroup` (an
 * access-controlled file without sortedBy, or sorted by its partition column first), each partition's rows are
 * written together, in their file order: appends leave one chunk per append, and regrouping merges them.
 */
export function compact(path: string, options?: { key?: KeyInput; password?: string; codec?: JazminCodec; chunkRows?: number; regroup?: boolean }):
  { rowCount: number; bytesBefore: number; bytesAfter: number; expiredGrantsRemoved: number };
/**
 * Encrypts a file again under a new key or password, without decoding its rows: every section is decrypted and
 * encrypted again as stored. Only the new key or password opens the result. A file with appends is compacted first.
 * Not for access-controlled files.
 */
export function rotateKey(path: string, options: {
  key?: KeyInput; password?: string; newKey?: KeyInput; newPassword?: string; kdfIterations?: number;
}): { sections: number; bytes: number };
/**
 * A shared (access-controlled) file under a new owner key (default: generated). Every access key is replaced too: each
 * grant keeps its rows, columns, files, label, expiry and mode under a new key. Online grants need new unlock tokens.
 * Expired grants are dropped. The file is rewritten with fresh secrets.
 */
export function rotateOwnerKey(path: string, options: { key: KeyInput; newKey?: KeyInput; now?: Date | number }): {
  ownerKey: JazminKey;
  accessKeys: { previous: string; key: JazminAccessKey; label?: string; mode: 'offline' | 'online'; expires?: Date }[];
};
/** Owner only: lets accessKey see the given partitions / column groups (rewrites the file). */
export function grantAccess(path: string, ownerKey: KeyInput, accessKey: JazminAccessKey | string,
  grant?: { rows?: '*' | string[]; columns?: '*' | string[]; label?: string }): UpdateResult;
/** Owner only: removes a key's access; the new version uses fresh secrets. */
export function revokeAccess(path: string, ownerKey: KeyInput, accessKey: JazminAccessKey | string): UpdateResult;

export class JazminReader implements Iterable<JazminRow> {
  constructor(source: string | Uint8Array, options?: ReadOptions);
  /** Names of the file's tables, in order. */
  readonly tables: string[];
  /** Name of the table this reader reads. */
  readonly table: string;
  /**
   * Another table of this file, without opening it again: shares the open file, keys and checks. Close it too;
   * the file closes with the last reader.
   */
  openTable(name: string): JazminReader;
  readonly columns: JazminColumn[];
  readonly metadata: Record<string, JsonValue>;
  readonly rowCount: number;
  readonly chunkCount: number;
  readonly encrypted: boolean;
  /** Live rows in the file this key may not see. */
  readonly hiddenRowCount: number;
  /** Rows deleted by appends and not yet removed by compaction. */
  readonly deletedRowCount: number;
  /** Appends since the file was last written in full. */
  readonly appendCount: number;
  /** When the file was last written (its last append, or when it was created), by the writer's clock. */
  readonly writtenAt: Date;
  /**
   * The submission key (spec 7.8): lock the files you send back to the owner with it. Only an access key that opened
   * this file has it; null for the owner and for files written before submission keys existed.
   */
  readonly submissionKey: JazminKey | null;
  /** True when an interrupted append was found at the end of the file and the previous version was used. */
  readonly recovered: boolean;
  readonly sortedBy: string[] | undefined;
  readonly kdfIterations: number | undefined;
  /** Access-control details, or null for ordinary files. */
  readonly access: AccessInfo | null;
  readonly indexes: { column: string; kind: JazminIndexKind }[];
  /** Embedded files this key can see. */
  readonly files: FileInfo[];
  readonly package: PackageSettings | undefined;
  /** A whole embedded file (checked against its SHA-256). */
  readFile(path: string): Buffer;
  /** Bytes [start, end) of an embedded file; only the blocks involved are read. */
  readFileRange(path: string, start?: number, end?: number): Buffer;
  /** An embedded file as a stream, block by block. */
  openFile(path: string): import('node:stream').Readable;
  get(rowId: number): JazminRow;
  rows(options?: QueryOptions): Generator<JazminRow>;
  find(filter: Filter | null | undefined, options?: QueryOptions): Generator<JazminRow>;
  /**
   * find() for async code: chunks are read with non-blocking reads, a few ahead of decoding, and other work
   * gets the event loop between chunks. Same rows, same order. One query at a time per reader.
   */
  findAsync(filter: Filter | null | undefined, options?: QueryOptions): AsyncGenerator<JazminRow>;
  /** findAsync() yielding each chunk's rows as one array: as fast as find(), still non-blocking. */
  findBatchesAsync(filter: Filter | null | undefined, options?: QueryOptions): AsyncGenerator<JazminRow[]>;
  rowsAsync(options?: QueryOptions): AsyncGenerator<JazminRow>;
  /**
   * Matching rows. Exact index answers and chunks whose statistics prove every row matches are counted without
   * reading rows; elsewhere only the filter's columns are decoded.
   */
  count(filter?: Filter): number;
  /**
   * Column values as arrays, for charts and totals: far less memory than an object per row. Integers beyond ±2^53 are
   * refused (a Float64Array cannot hold them exactly).
   */
  columnArrays(filter?: Filter | null, options?: { select?: string[]; offset?: number; limit?: number }): ColumnArrays;
  /** Layout advice for lookups of these columns (chunk directories and statistics only). */
  advise(options?: { columns?: string[] }): LayoutAdvice;
  explain(filter: Filter): QueryPlan;
  /**
   * Runs the query (with any find() options) and reports what it read. Indexes and the last chunk this reader
   * already holds are not read again: analyze on a freshly opened reader to see a query's full cost.
   */
  explain(filter: Filter, options: QueryOptions & { analyze: true }): QueryPlan & QueryCost;
  explain(filter: Filter, options?: QueryOptions & { analyze?: boolean }): QueryPlan | (QueryPlan & QueryCost);
  close(): void;
  [Symbol.iterator](): Iterator<JazminRow>;
}

export class JazminWriter {
  /** target: file path, or null to build in memory (finish() then returns a Buffer). */
  constructor(target: string | null, options: WriteOptions & ({ columns: JazminColumnInput[] } | { tables: TableDefinition[] }));
  /** Columns, row count and name of the table rows go to. */
  readonly columns: JazminColumn[];
  readonly rowCount: number;
  readonly table: string;
  /** Rows written from now on go to this table (declared in `tables`). Any order, each table once. */
  startTable(name: string): void;
  writeRow(row: Record<string, unknown>): void;
  writeRows(rows: Iterable<Record<string, unknown>>): void;
  /** writeRows() for async code: also takes async iterables (database cursors); never blocks the event loop. */
  writeRowsAsync(rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>): Promise<void>;
  /** Embeds a file; identical content is stored once. */
  addFile(file: FileInput): void;
  addFile(path: string, content: Uint8Array | string, options?: { type?: string; groups?: '*' | string[] }): void;
  finish(): Buffer | undefined;
  /** finish() for async code: waits for the compression workers without blocking. */
  finishAsync(): Promise<Buffer | undefined>;
  abort(): void;
}

export class JazminError extends Error {}
/** The key's access period has ended, or the system clock appears to have been set back. */
export class JazminAccessExpiredError extends JazminKeyError {}
/** An online key needs an unlock token: send fileId and keyId to your key service. */
export class JazminUnlockRequiredError extends JazminKeyError {
  readonly fileId: string;
  readonly keyId: string;
}
export class JazminFormatError extends JazminError {}
export class JazminKeyError extends JazminError {}
export class JazminValidationError extends JazminError {}

export const TYPES: readonly JazminType[];

export function open(source: string | Uint8Array, options?: ReadOptions): JazminReader;
/** open() for async code: the file's header region is read with non-blocking reads. */
export function openAsync(source: string | Uint8Array, options?: ReadOptions): Promise<JazminReader>;
/** write() for async code. With an async iterable of rows, options.columns is required. */
export function writeAsync(target: null, rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, options?: WriteOptions): Promise<Buffer>;
export function writeAsync(target: string, rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, options?: WriteOptions): Promise<undefined>;
export function write(target: null, rows: Iterable<Record<string, unknown>>, options?: WriteOptions): Buffer;
export function write(target: string, rows: Iterable<Record<string, unknown>>, options?: WriteOptions): undefined;
/** Several tables: rows by table name, in the order of options.tables. */
export function write(target: null, rows: Record<string, Iterable<Record<string, unknown>>>, options: WriteOptions & { tables: TableDefinition[] }): Buffer;
export function write(target: string, rows: Record<string, Iterable<Record<string, unknown>>>, options: WriteOptions & { tables: TableDefinition[] }): undefined;
export function inferSchema(rows: Iterable<Record<string, unknown>>, options?: { detectDates?: boolean }): JazminColumn[];

export function exportString(reader: JazminReader, format: 'json' | 'csv' | 'xml', options?: ExportOptions): string;
export function exportFile(reader: JazminReader, format: 'json' | 'csv' | 'xml', path: string, options?: ExportOptions): void;
export function toJSON(reader: JazminReader, options?: ExportOptions): string;
/**
 * Validates a shape against the columns a reader can see; throws JazminValidationError naming the mistake. `tables`: the
 * columns of the file's other tables by name, for links ($from).
 */
export function compileShape(columns: JazminColumn[], shape: ExportShape, tables?: Record<string, JazminColumn[]>): unknown;
/** JSON Schema (draft 2020-12) of a shape's JSON output. */
export function shapeSchema(reader: JazminReader, shape: ExportShape): Record<string, JsonValue>;
export function toCSV(reader: JazminReader, options?: ExportOptions): string;
export function toXML(reader: JazminReader, options?: ExportOptions): string;

export function fromJSON(json: string | object[], target: null, options?: WriteOptions): Buffer;
export function fromJSON(json: string | object[], target: string, options?: WriteOptions): undefined;
export function fromCSV(csv: string, target: null, options?: WriteOptions & { delimiter?: string; inferTypes?: boolean }): Buffer;
export function fromCSV(csv: string, target: string, options?: WriteOptions & { delimiter?: string; inferTypes?: boolean }): undefined;
export function fromXML(xml: string, target: null, options?: WriteOptions & { inferTypes?: boolean }): Buffer;
export function fromXML(xml: string, target: string, options?: WriteOptions & { inferTypes?: boolean }): undefined;

/**
 * Converts a JSON file of any size (JSON array of objects, or JSON Lines) to JAZMIN without
 * loading it. Read twice (schema, then rows) unless options.columns is given.
 */
export function importJSONFile(inputPath: string, target: null, options?: WriteOptions): Buffer;
export function importJSONFile(inputPath: string, target: string, options?: WriteOptions): undefined;
/** Streams the objects of a JSON array or JSON Lines file one at a time. */
export function readJsonObjects(path: string, options?: { blockSize?: number }): Generator<Record<string, unknown>>;

/**
 * Converts a CSV file of any size to JAZMIN without loading it. Read twice (column types, then rows) unless
 * options.columns is given; then every header name must be one of those columns, and it is read once.
 */
export function importCSVFile(inputPath: string, target: null, options?: WriteOptions & { delimiter?: string; inferTypes?: boolean }): Buffer;
export function importCSVFile(inputPath: string, target: string, options?: WriteOptions & { delimiter?: string; inferTypes?: boolean }): undefined;
/**
 * Converts an XML file of the canonical shape (as toXML writes it) of any size to JAZMIN without loading it. Read
 * twice (column types, then rows) unless options.columns is given; then every element must name one of those columns.
 */
export function importXMLFile(inputPath: string, target: null, options?: WriteOptions & { inferTypes?: boolean }): Buffer;
export function importXMLFile(inputPath: string, target: string, options?: WriteOptions & { inferTypes?: boolean }): undefined;
/** Streams the rows of a canonical XML file: each a Map from column position to its text; `names` fills as it reads. */
export function readXmlRows(path: string, options?: { blockSize?: number; names?: string[] }): Generator<Map<number, string>>;
/** Streams the records of a CSV file (fields as strings, null for an unquoted empty field), header first. */
export function readCsvRecords(path: string, options?: { delimiter?: string; blockSize?: number }): Generator<(string | null)[]>;

export function parseCsv(text: string, options?: { delimiter?: string; inferTypes?: boolean }): { columns: JazminColumn[]; rows: JazminRow[] };
export function parseXml(text: string, options?: { inferTypes?: boolean }): { columns: JazminColumn[]; rows: JazminRow[] };
export function parseJsonRows(input: string | object | object[]): Record<string, unknown>[];

/** Counterpart of JSON.stringify / JSON.parse for arrays of records. */
export const JAZMIN: {
  stringify(rows: Iterable<Record<string, unknown>>, options?: WriteOptions): Buffer;
  parse(bytes: Uint8Array, options?: ReadOptions): JazminRow[];
};

// ---- Server-side helpers (TASKS F-3) --------------------------------------------------------------------------------

/** A response for an embedded file: the bytes are read only when `body` or `stream()` is used. */
export interface FileResponse {
  status: 200 | 206 | 304 | 400 | 404 | 405 | 416;
  headers: Record<string, string>;
  /** The bytes (whole file, or the requested range). */
  readonly body: Buffer;
  /** The same bytes, block by block. */
  stream(): import('node:stream').Readable;
}

/** Answers a request for an embedded file by path. */
export type FileHandler = (path: string, request?: { method?: string; range?: string; ifNoneMatch?: string }) => FileResponse;

/**
 * Serves a reader's embedded files by path, for request interception or a web server: one byte range per request,
 * ETags from the files' SHA-256, and the document's security policy (sandboxed by default) on pages and SVG.
 * Only files the reader's key can see are served.
 */
export function createFileHandler(reader: JazminReader, options?: { origin?: string; sandbox?: boolean }): FileHandler;

/** A Node request handler (http.createServer, Express) serving a reader's embedded files under `prefix`. */
export function serveFiles(
  reader: JazminReader,
  options?: { prefix?: string; origin?: string },
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: () => void) => void;

/** The security policy the viewer gives a package's document; `self` adds the origin its files are served from. */
export function documentPolicy(settings?: PackageSettings, options?: { self?: string | null }): string;

export interface RenderPdfOptions {
  /** A path, a Buffer or an open reader. */
  file: string | Uint8Array | JazminReader;
  key?: string | JazminKey | JazminAccessKey;
  password?: string;
  unlockToken?: string;
  table?: string;
  /** The page to render (default: the package's entry). */
  entry?: string;
  /** A Puppeteer or Playwright Browser (Chromium), or a Playwright BrowserContext. */
  browser: unknown;
  /** The browser's PDF options (default A4, with backgrounds). */
  pdf?: Record<string, unknown>;
  /** Render when the document calls jazmin.ready() (default), or when it has loaded. */
  waitFor?: 'ready' | 'load';
  /** Milliseconds to wait (default 30,000). */
  timeout?: number;
  /** What the document passed to jazmin.ready(). */
  onReady?(info: unknown): void;
  /** Files the document saved with jazmin.download(). */
  onDownload?(file: { filename: string; type: string; bytes: Buffer }): void;
}

/**
 * Renders a file's document to PDF with the viewer's window.jazmin API, answered from the file: one template serves
 * the viewer and PDFs. Only the package's files and allowed origins are reachable.
 */
export function renderPdf(options: RenderPdfOptions): Promise<Buffer>;

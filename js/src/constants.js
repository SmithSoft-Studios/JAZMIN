// Fixed values from the JAZMIN specification (docs/rfc/draft-jazmin-format-03.md, format 1.0).

export const MAGIC = Buffer.from('JZM1', 'ascii');
export const DRAFT_MAGIC = Buffer.from('JZMN', 'ascii'); // pre-release draft formats, refused with a clear message

export const PREAMBLE_SIZE = 64;
export const TRAILER_SIZE = 44;
export const ENVELOPE_SIZE = 16;
export const FILE_ID_SIZE = 16;
export const SALT_SIZE = 32;

// Preamble flags
export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_PASSWORD = 0x0002;
export const FLAG_ACCESS = 0x0004; // access-controlled: key slots + owner signature (spec 7.6)
export const FLAG_APPENDED = 0x0008; // appended to: may hold earlier versions before the last trailer (spec 11.2)
export const KNOWN_FLAGS = 0x000f;

// Section envelope flags
export const SECTION_ENCRYPTED = 0x01;

export const CODEC = Object.freeze({ none: 0, deflate: 1, brotli: 2 });

export const KEYRING_GROUPS = Object.freeze({ data: 'data', index: 'index', files: 'files' });

/**
 * Reader feature 'index-deltas' (spec 8.1): sorted index pages with encoding 1, whose keys and first row ids are
 * differences from the previous entry's. Written only when asked for (compactIndexes) until 2.0.
 */
export const INDEX_DELTAS = 'index-deltas';
export const INDEX_DELTAS_ENCODING = 1;

/** Reader features this implementation supports (spec 12). */
export const SUPPORTED_READER_FEATURES = new Set([INDEX_DELTAS]);
export const SUPPORTED_WRITER_FEATURES = new Set();

export const DEFAULTS = Object.freeze({
  chunkRows: 4096,
  chunkBytes: 1024 * 1024,
  codec: 'deflate',
  kdfIterations: 600_000,
});

export const MIN_KDF_ITERATIONS = 1000;
export const MAX_KDF_ITERATIONS = 10_000_000; // a file asking for more is refused: each open would take minutes

export const DEFAULT_COLUMN_GROUP = '*';
export const SIGNATURE_SIZE = 64;
export const PUBLIC_KEY_SIZE = 65;

/** Text form of the single partition of a table without a partition column (section ids). */
export const WHOLE_TABLE = '*';

/** Partitions listed in the header; more go to a partition-table section (spec 6.3). */
export const INLINE_PARTITIONS = 64;

/** Encoding byte at the start of index, page, postings and deleted-rows sections (spec 8). */
export const POSTINGS_ENCODING = 0;

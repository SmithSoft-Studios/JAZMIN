import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { utf8Slice } from '../binary.js';
import { JazminValidationError } from '../errors.js';
import { inferTextColumns, textType, textTypeOfBytes, toObjects, valueToText } from './text.js';

// RFC 4180 CSV. Convention: an unquoted empty field is null; a quoted empty field ("") is an empty string.

function quote(text, delimiter) {
  if (text === '' || /["\r\n]/.test(text) || text.includes(delimiter) || text.trim() !== text) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function* csvPieces(columns, rows, { delimiter = ',', newline = '\r\n' } = {}) {
  yield columns.map((c) => quote(c.name, delimiter)).join(delimiter) + newline;
  for (const row of rows) {
    yield columns
      .map((c) => {
        const value = row[c.name] ?? null;
        return value === null ? '' : quote(valueToText(c.type, value, c), delimiter);
      })
      .join(delimiter) + newline;
  }
}

const QUOTE = 34;
const CR = 13;
const LF = 10;

/**
 * RFC 4180 records from text that arrives in pieces: push() returns the records a piece completes and keeps what
 * continues into the next one (a record, a field, or a quote or line ending split across two pieces). Fields are
 * strings, or null for an unquoted empty field.
 */
export class CsvRecordParser {
  #delimiter;
  #record = [];
  #field = '';
  #quoted = false; // the field started with a quote: "" is an empty string, not null
  #inQuotes = false;
  #quoteAtEnd = false; // the last piece ended on a quote inside quotes: an escaped quote ("") or the closing one
  #skipLF = false; // the last piece ended on \r: a \n starting the next one belongs to it

  constructor(delimiter = ',') {
    this.#delimiter = delimiter.length === 1 ? delimiter.charCodeAt(0) : -1;
  }

  #endField() {
    this.#record.push(this.#quoted || this.#field !== '' ? this.#field : null);
    this.#field = '';
    this.#quoted = false;
  }

  /** The records `text` completes; `final` marks the end of the input. */
  push(text, final = false) {
    const records = [];
    let i = 0;
    if (text.length && this.#skipLF) {
      this.#skipLF = false;
      if (text.charCodeAt(0) === LF) i = 1;
    }
    if (this.#quoteAtEnd && (text.length || final)) {
      this.#quoteAtEnd = false;
      if (text.charCodeAt(0) === QUOTE) {
        this.#field += '"';
        i = 1;
      } else this.#inQuotes = false; // the closing quote (also when the input ends after it)
    }
    let start = i; // a run of ordinary characters of the current field, added in one slice
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (this.#inQuotes) {
        if (ch !== QUOTE) {
          i++;
          continue;
        }
        this.#field += text.slice(start, i);
        if (i + 1 === text.length) {
          if (final) this.#inQuotes = false;
          else this.#quoteAtEnd = true;
          i++;
        } else if (text.charCodeAt(i + 1) === QUOTE) {
          this.#field += '"';
          i += 2;
        } else {
          this.#inQuotes = false;
          i++;
        }
        start = i;
        continue;
      }
      if (ch === QUOTE && start === i && this.#field === '' && !this.#quoted) {
        this.#inQuotes = true;
        this.#quoted = true;
        start = ++i;
      } else if (ch === this.#delimiter) {
        this.#field += text.slice(start, i);
        this.#endField();
        start = ++i;
      } else if (ch === CR || ch === LF) {
        this.#field += text.slice(start, i);
        this.#endField();
        records.push(this.#record);
        this.#record = [];
        i++;
        if (ch === CR) {
          if (i < text.length) {
            if (text.charCodeAt(i) === LF) i++;
          } else if (!final) this.#skipLF = true;
        }
        start = i;
      } else i++;
    }
    this.#field += text.slice(start, i);
    if (final) {
      if (this.#inQuotes) throw new JazminValidationError('CSV ends inside a quoted field');
      if (this.#field !== '' || this.#quoted || this.#record.length > 0) {
        this.#endField();
        records.push(this.#record);
        this.#record = [];
      }
    }
    return records;
  }
}

/** Parses CSV text into positional rows of strings/null. */
export function parseCsvRecords(text, delimiter = ',') {
  return new CsvRecordParser(delimiter).push(text, true);
}

/**
 * CsvRecordParser for the bytes of a UTF-8 file, read a block at a time (the caller may reuse its block). Fields are
 * decoded from the bytes into strings of their own: a field cut from a larger string would keep that whole string
 * alive while anything holds the field (the writer keeps chunk statistics), which grew memory with every block. The
 * characters CSV gives meaning to are ASCII, so they never occur inside a multi-byte UTF-8 character.
 */
class CsvByteParser {
  #delimiter;
  #special = new Uint8Array(256); // the bytes CSV gives meaning to: one look-up per byte outside quotes
  #record = [];
  #parts = []; // bytes of the current field from earlier blocks (copies), or segments of it in this block
  #ranges = []; // segments of the current field in the current block: [from, to) pairs (around escaped quotes)
  #quoted = false;
  #inQuotes = false;
  #quoteAtEnd = false;
  #skipLF = false;
  #value; // a field's bytes as its value: its text, or (for type inference) only the type that text would have

  constructor(delimiter, value = utf8Slice) {
    this.#delimiter = delimiter;
    this.#value = value;
    for (const b of [QUOTE, CR, LF, delimiter]) this.#special[b] = 1;
  }

  /** Ends a field; an unquoted empty one is null. */
  #endField(bytes, start, end) {
    let value = null;
    if (!this.#parts.length && !this.#ranges.length) {
      if (start < end || this.#quoted) value = this.#value(bytes, start, end);
    } else {
      const pieces = [...this.#parts];
      for (let k = 0; k < this.#ranges.length; k += 2) pieces.push(bytes.subarray(this.#ranges[k], this.#ranges[k + 1]));
      if (start < end) pieces.push(bytes.subarray(start, end));
      const joined = Buffer.concat(pieces);
      if (joined.length || this.#quoted) value = this.#value(joined, 0, joined.length);
      this.#parts = [];
      this.#ranges = [];
    }
    this.#record.push(value);
    this.#quoted = false;
  }

  /** The records `bytes` completes; `final` marks the end of the file. */
  push(bytes, final = false) {
    const records = [];
    let i = 0;
    if (bytes.length && this.#skipLF) {
      this.#skipLF = false;
      if (bytes[0] === LF) i = 1;
    }
    if (this.#quoteAtEnd && (bytes.length || final)) {
      this.#quoteAtEnd = false;
      if (bytes.length && bytes[0] === QUOTE) {
        this.#parts.push(QUOTE_BYTE);
        i = 1;
      } else this.#inQuotes = false;
    }
    let start = i;
    const special = this.#special;
    while (i < bytes.length) {
      if (this.#inQuotes) {
        const quote = bytes.indexOf(QUOTE, i); // the next quote, found natively
        if (quote < 0) {
          i = bytes.length;
          break;
        }
        i = quote;
        if (i + 1 === bytes.length) {
          if (start < i) this.#ranges.push(start, i);
          if (final) this.#inQuotes = false;
          else this.#quoteAtEnd = true;
          i++;
        } else if (bytes[i + 1] === QUOTE) {
          this.#ranges.push(start, i + 1); // one of the two quotes
          i += 2;
        } else {
          if (start < i) this.#ranges.push(start, i);
          this.#inQuotes = false;
          i++;
        }
        start = i;
        continue;
      }
      const b = bytes[i];
      if (special[b] === 0) {
        i++;
        continue;
      }
      if (b === QUOTE && start === i && !this.#parts.length && !this.#ranges.length && !this.#quoted) {
        this.#inQuotes = true;
        this.#quoted = true;
        start = ++i;
      } else if (b === this.#delimiter) {
        this.#endField(bytes, start, i);
        start = ++i;
      } else if (b === CR || b === LF) {
        this.#endField(bytes, start, i);
        records.push(this.#record);
        this.#record = [];
        i++;
        if (b === CR) {
          if (i < bytes.length) {
            if (bytes[i] === LF) i++;
          } else if (!final) this.#skipLF = true;
        }
        start = i;
      } else i++;
    }
    // What is left of the current field continues in the next block, which reuses this one's memory: copy it.
    if (start < i) this.#ranges.push(start, i);
    for (let k = 0; k < this.#ranges.length; k += 2) this.#parts.push(Buffer.from(bytes.subarray(this.#ranges[k], this.#ranges[k + 1])));
    this.#ranges = [];
    if (final) {
      if (this.#inQuotes) throw new JazminValidationError('CSV ends inside a quoted field');
      if (this.#parts.length || this.#quoted || this.#record.length > 0) {
        this.#endField(bytes, i, i);
        records.push(this.#record);
        this.#record = [];
      }
    }
    return records;
  }
}

const QUOTE_BYTE = Buffer.from('"');
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The records of a CSV file, without loading it: it is read a block at a time (memory: one block and the record
 * being read). A byte order mark at the start is skipped. The delimiter is one character; an ASCII one (as usual) is
 * found in the bytes, another in the decoded text.
 */
export function readCsvRecords(path, { delimiter = ',', blockSize = 1 << 20 } = {}) {
  return readCsv(path, delimiter, blockSize, false);
}

/**
 * readCsvRecords() with each present value given as the type its text would be inferred as (textType), worked out
 * from the bytes without decoding them: the first of importCSVFile()'s two reads.
 */
export function readCsvTypes(path, { delimiter = ',', blockSize = 1 << 20 } = {}) {
  return readCsv(path, delimiter, blockSize, true);
}

function* readCsv(path, delimiter, blockSize, types) {
  const ascii = delimiter.length === 1 && delimiter.charCodeAt(0) < 0x80;
  const fd = fs.openSync(path, 'r');
  try {
    const head = Buffer.alloc(3);
    let position = fs.readSync(fd, head, 0, 3, 0) === 3 && head.equals(BOM_BYTES) ? 3 : 0;
    const block = Buffer.allocUnsafe(blockSize);
    if (ascii) {
      const parser = new CsvByteParser(delimiter.charCodeAt(0), types ? textTypeOfBytes : utf8Slice);
      for (;;) {
        const read = fs.readSync(fd, block, 0, blockSize, position);
        position += read;
        yield* parser.push(block.subarray(0, read), read === 0);
        if (read === 0) return;
      }
    }
    // Another delimiter: the text is decoded, and fields cut from it are copied, for the reason CsvByteParser gives.
    const decoder = new StringDecoder('utf8');
    const parser = new CsvRecordParser(delimiter);
    const own = types
      ? (field) => (field === null ? null : textType(field))
      : (field) => (field === null || field.length < 13 ? field : Buffer.from(field, 'utf8').toString('utf8'));
    for (;;) {
      const read = fs.readSync(fd, block, 0, blockSize, position);
      position += read;
      const text = read === 0 ? decoder.end() : decoder.write(block.subarray(0, read));
      for (const record of parser.push(text, read === 0)) yield record.map(own);
      if (read === 0) return;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Column names from a CSV header record (an empty name becomes column1, column2, ...). */
export const csvHeaderNames = (header) => header.map((h, i) => h ?? `column${i + 1}`);

/** Throws when a data record (`n`, from 0) has more fields than the header. */
export function checkCsvFields(record, names, n) {
  if (record.length > names.length) throw new JazminValidationError(`CSV line ${n + 2} has more fields than the header`);
}

/** Parses CSV (first line = header) into { columns, rows }. */
export function parseCsv(text, { delimiter = ',', inferTypes = true } = {}) {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ''), delimiter);
  if (records.length === 0) throw new JazminValidationError('CSV has no header row');
  const [header, ...data] = records;
  const names = csvHeaderNames(header);
  data.forEach((r, n) => checkCsvFields(r, names, n));
  const columns = inferTextColumns(names, data, inferTypes);
  return { columns, rows: toObjects(columns, data) };
}

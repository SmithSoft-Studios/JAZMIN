// Shared conversions between typed values and their text form (used by CSV and XML).

/** Text form of a non-null value. */
export function valueToText(type, value) {
  switch (type) {
    case 'datetime': return value.toISOString();
    case 'binary': return Buffer.from(value).toString('base64');
    case 'json': return JSON.stringify(value);
    default: return String(value);
  }
}

/** JSON literal for a value (exact for int and decimal, which may exceed double precision). */
export function valueToJson(type, value) {
  if (value === null) return 'null';
  switch (type) {
    case 'int':
    case 'decimal': return String(value);
    case 'float': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'datetime': return JSON.stringify(value.toISOString());
    case 'binary': return JSON.stringify(Buffer.from(value).toString('base64'));
    default: return JSON.stringify(value);
  }
}

const INT = /^-?\d+$/;
const FLOAT = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOL = /^(true|false)$/i;

/**
 * Infers column types from text values (null = absent). A column is int/float/bool
 * only when every present value matches; otherwise it stays string.
 */
export function inferTextColumns(names, rows, inferTypes) {
  return names.map((name, i) => {
    let type = null;
    let nullable = false;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) {
        nullable = true;
        continue;
      }
      if (!inferTypes) {
        type = 'string';
        continue;
      }
      const t = INT.test(v) ? 'int' : FLOAT.test(v) ? 'float' : BOOL.test(v) ? 'bool' : 'string';
      if (type === null) type = t;
      else if (type !== t) type = (type === 'int' && t === 'float') || (type === 'float' && t === 'int') ? 'float' : 'string';
    }
    return { name, type: type ?? 'string', nullable };
  });
}

/** Converts a text value into the column's type. */
export function textToValue(type, text) {
  if (text === null || text === undefined) return null;
  switch (type) {
    case 'int': {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : BigInt(text);
    }
    case 'float': return Number(text);
    case 'bool': return text.toLowerCase() === 'true';
    default: return text;
  }
}

/** Turns positional text rows into objects keyed by column name. */
export function toObjects(columns, rows) {
  return rows.map((row) => {
    const out = {};
    columns.forEach((c, i) => {
      out[c.name] = textToValue(c.type, row[i] ?? null);
    });
    return out;
  });
}

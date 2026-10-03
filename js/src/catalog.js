// Catalog messages of spec/jazmin.proto (spec 6), as plain objects:
//   ref       { offset, length, digest? (Buffer) }
//   column    { position, name, type, required, description?, attributes?, unit? }
//   table     { name, columnCount, columnGroups, sortedBy, partitionBy, rowCount, deletedCount, chunkCount,
//               partitions, partitionTable, indexes, deletes }
import { JazminFormatError } from './errors.js';
import { ProtoWriter, bytesOf, readMessage, readPacked, text, toInt64 } from './proto.js';

const TYPE_NAMES = ['', 'bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json'];
const TYPE_IDS = new Map(TYPE_NAMES.map((name, i) => [name, i]));
const DIGEST_SIZE = 32;

const bad = (what) => new JazminFormatError(`Catalog: ${what}`);

/** Numbers stored as differences: the first absolute, then each from the previous one (spec 6). */
function differences(values) {
  const out = new Array(values.length);
  let previous = 0;
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] - previous;
    previous = values[i];
  }
  return out;
}

function cumulative(values) {
  let total = 0;
  return values.map((v) => {
    if (typeof v !== 'number') throw bad('value out of range');
    total += v;
    return total;
  });
}

const num = (v) => {
  if (typeof v !== 'number') throw bad('value out of range');
  return v;
};

// ---- SectionRef --------------------------------------------------------------------------------

function writeRef(ref) {
  return (w) => w.uint(1, ref.offset).uint(2, ref.length).bytes(3, ref.digest);
}

function readRef(buf) {
  const ref = { offset: 0, length: 0 };
  readMessage(buf, (f, v) => {
    if (f === 1) ref.offset = num(v);
    else if (f === 2) ref.length = num(v);
    else if (f === 3) ref.digest = Buffer.from(bytesOf(v));
  });
  return ref;
}

// ---- Header ------------------------------------------------------------------------------------

function writeColumn(c) {
  return (w) => {
    w.uint(1, c.position).string(2, c.name).uint(3, TYPE_IDS.get(c.type)).uint(4, c.required ? 1 : 0)
      .string(5, c.description).string(6, c.attributes).uint(7, c.unit ?? 0);
  };
}

function readColumn(buf) {
  const c = { position: 0, name: '', type: '', required: false, unit: 0 };
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: c.position = num(v); break;
      case 2: c.name = text(v); break;
      case 3: c.type = TYPE_NAMES[v] ?? ''; break;
      case 4: c.required = num(v) !== 0; break;
      case 5: c.description = text(v); break;
      case 6: c.attributes = text(v); break;
      case 7: c.unit = num(v); break;
      default: break;
    }
  });
  if (!c.type) throw bad(`column '${c.name}' has an unknown type`);
  if (c.unit !== 0) throw bad(`column '${c.name}' uses an unknown time unit`);
  return c;
}

export function encodeColumnDefinitions(columns) {
  const w = new ProtoWriter();
  for (const c of columns) w.message(1, writeColumn(c), true);
  return w.toBuffer();
}

export function decodeColumnDefinitions(buf) {
  const columns = [];
  readMessage(buf, (f, v) => { if (f === 1) columns.push(readColumn(v)); });
  return columns;
}

function writePartition(p) {
  return (w) => {
    w.bytes(1, p.id);
    for (const s of p.segments) w.message(2, writeRef(s), true);
  };
}

function readPartition(buf) {
  const p = { id: Buffer.alloc(0), segments: [] };
  readMessage(buf, (f, v) => {
    if (f === 1) p.id = Buffer.from(bytesOf(v));
    else if (f === 2) p.segments.push(readRef(v));
  });
  return p;
}

function writeIndexRef(ix) {
  return (w) => w.string(1, ix.column).string(2, ix.kind).message(3, writeRef(ix.section)).uint(4, ix.segment);
}

function readIndexRef(buf) {
  const ix = { column: '', kind: '', section: null, segment: 0 };
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: ix.column = text(v); break;
      case 2: ix.kind = text(v); break;
      case 3: ix.section = readRef(v); break;
      case 4: ix.segment = num(v); break;
      default: break;
    }
  });
  if (!ix.section) throw bad(`index on '${ix.column}' has no section`);
  return ix;
}

function writeTable(t) {
  return (w) => {
    w.string(1, t.name).uint(2, t.columnCount);
    for (const g of t.columnGroups) {
      w.message(3, (gw) => {
        gw.string(1, g.name);
        for (const c of g.columns ?? []) gw.message(2, writeColumn(c), true);
        gw.uint(3, g.columnCount ?? 0).message(4, g.definitions ? writeRef(g.definitions) : null);
      }, true);
    }
    for (const name of t.sortedBy ?? []) w.always(4, Buffer.from(name, 'utf8'));
    w.string(5, t.partitionBy).uint(6, t.rowCount).uint(7, t.deletedCount).uint(8, t.chunkCount);
    for (const p of t.partitions ?? []) w.message(9, writePartition(p), true);
    w.message(10, t.partitionTable ? writeRef(t.partitionTable) : null);
    for (const ix of t.indexes ?? []) w.message(11, writeIndexRef(ix), true);
    w.message(12, t.deletes ? writeRef(t.deletes) : null);
  };
}

function readTable(buf) {
  const t = {
    name: '', columnCount: 0, columnGroups: [], sortedBy: [], partitionBy: '', rowCount: 0, deletedCount: 0, chunkCount: 0,
    partitions: [], partitionTable: null, indexes: [], deletes: null,
  };
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: t.name = text(v); break;
      case 2: t.columnCount = num(v); break;
      case 3: {
        const g = { name: '', columns: [], columnCount: 0, definitions: null };
        readMessage(v, (gf, gv) => {
          if (gf === 1) g.name = text(gv);
          else if (gf === 2) g.columns.push(readColumn(gv));
          else if (gf === 3) g.columnCount = num(gv);
          else if (gf === 4) g.definitions = readRef(gv);
        });
        t.columnGroups.push(g);
        break;
      }
      case 4: t.sortedBy.push(text(v)); break;
      case 5: t.partitionBy = text(v); break;
      case 6: t.rowCount = num(v); break;
      case 7: t.deletedCount = num(v); break;
      case 8: t.chunkCount = num(v); break;
      case 9: t.partitions.push(readPartition(v)); break;
      case 10: t.partitionTable = readRef(v); break;
      case 11: t.indexes.push(readIndexRef(v)); break;
      case 12: t.deletes = readRef(v); break;
      default: break;
    }
  });
  return t;
}

/** Header message (spec 6.1). */
export function encodeHeader(h) {
  const w = new ProtoWriter(1024);
  for (const f of h.readerFeatures ?? []) w.always(1, Buffer.from(f, 'utf8'));
  for (const f of h.writerFeatures ?? []) w.always(2, Buffer.from(f, 'utf8'));
  w.int64(3, h.created).int64(4, h.modified).uint(5, h.appendCount).string(6, h.metadata);
  for (const t of h.tables) w.message(7, writeTable(t), true);
  if (h.keyring) w.message(8, (k) => k.bytes(1, h.keyring.data).bytes(2, h.keyring.index).bytes(3, h.keyring.files));
  if (h.files) {
    w.message(9, (fw) => {
      for (const d of h.files.directories) fw.message(1, (dw) => dw.string(1, d.group).message(2, writeRef(d.section)), true);
      fw.uint(2, h.files.nextContent).string(3, h.files.package).uint(4, h.files.segment);
    }, true);
  }
  if (h.access) {
    w.message(10, (aw) => aw.message(1, writeRef(h.access.ownerDirectory)).message(2, writeRef(h.access.ownerCatalog)), true);
  }
  for (const d of h.deltas ?? []) w.message(11, writeRef(d), true);
  return w.toBuffer();
}

export function decodeHeader(buf) {
  const h = {
    readerFeatures: [], writerFeatures: [], created: 0, modified: 0, appendCount: 0, metadata: '', tables: [],
    keyring: null, files: null, access: null, deltas: [],
  };
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: h.readerFeatures.push(text(v)); break;
      case 2: h.writerFeatures.push(text(v)); break;
      case 3: h.created = toInt64(v); break;
      case 4: h.modified = toInt64(v); break;
      case 5: h.appendCount = num(v); break;
      case 6: h.metadata = text(v); break;
      case 7: h.tables.push(readTable(v)); break;
      case 8: {
        const k = {};
        readMessage(v, (kf, kv) => {
          if (kf === 1) k.data = Buffer.from(bytesOf(kv));
          else if (kf === 2) k.index = Buffer.from(bytesOf(kv));
          else if (kf === 3) k.files = Buffer.from(bytesOf(kv));
        });
        h.keyring = k;
        break;
      }
      case 9: {
        const files = { directories: [], nextContent: 0, package: '', segment: 0 };
        readMessage(v, (ff, fv) => {
          if (ff === 1) {
            const d = { group: '', section: null };
            readMessage(fv, (df, dv) => {
              if (df === 1) d.group = text(dv);
              else if (df === 2) d.section = readRef(dv);
            });
            if (!d.section) throw bad('file directory without a section');
            files.directories.push(d);
          } else if (ff === 2) files.nextContent = num(fv);
          else if (ff === 3) files.package = text(fv);
          else if (ff === 4) files.segment = num(fv);
        });
        h.files = files;
        break;
      }
      case 10: {
        const access = { ownerDirectory: null, ownerCatalog: null };
        readMessage(v, (af, av) => {
          if (af === 1) access.ownerDirectory = readRef(av);
          else if (af === 2) access.ownerCatalog = readRef(av);
        });
        h.access = access;
        break;
      }
      case 11: h.deltas.push(readRef(v)); break;
      default: break;
    }
  });
  if (h.tables.length === 0) throw bad('the header lists no table');
  return h;
}

// ---- Partition table, deltas, owner catalog ----------------------------------------------------

export function encodePartitionTable(partitions) {
  const w = new ProtoWriter(partitions.length * 48 + 16);
  for (const p of partitions) w.message(1, writePartition(p), true);
  return w.toBuffer();
}

export function decodePartitionTable(buf) {
  const partitions = [];
  readMessage(buf, (f, v) => { if (f === 1) partitions.push(readPartition(v)); });
  return partitions;
}

/**
 * The partitions with these ids (Buffers) in a PartitionTable section, decoding only those: a key holder needs
 * its own few entries, not every partition's (spec 6.3).
 */
export function findPartitions(buf, ids) {
  const found = [];
  let pos = 0;
  const varint = () => {
    let result = 0;
    let multiplier = 1;
    for (let n = 0; n < 8; n++) {
      if (pos >= buf.length) throw bad('partition table is truncated');
      const b = buf[pos++];
      result += (b & 0x7f) * multiplier;
      if (!(b & 0x80)) return result;
      multiplier *= 128;
    }
    throw bad('partition table varint is too long');
  };
  while (pos < buf.length) {
    const tag = varint();
    if (tag !== 0x0a) return decodePartitionTable(buf).filter((p) => ids.some((id) => id.equals(p.id))); // unexpected layout: decode it all
    const length = varint();
    const end = pos + length;
    if (end > buf.length) throw bad('partition table is truncated');
    // Writers put the id first: compare it in place. Any other field order is decoded in full.
    const idFirst = buf[pos] === 0x0a && pos + 1 < end && buf[pos + 1] < 0x80;
    let match = !idFirst;
    for (let k = 0; idFirst && !match && k < ids.length; k++) {
      const id = ids[k];
      if (id.length !== buf[pos + 1] || pos + 2 + id.length > end) continue;
      let same = true;
      for (let j = 0; same && j < id.length; j++) same = id[j] === buf[pos + 2 + j];
      match = same;
    }
    if (match) {
      const p = readPartition(buf.subarray(pos, end));
      if (idFirst || ids.some((id) => id.equals(p.id))) found.push(p);
    }
    pos = end;
  }
  return found;
}

/** Delta: [{ table, partitions }] */
export function encodeDelta(tables) {
  const w = new ProtoWriter();
  for (const t of tables) {
    w.message(1, (tw) => {
      tw.uint(1, t.table);
      for (const p of t.partitions) tw.message(2, writePartition(p), true);
    }, true);
  }
  return w.toBuffer();
}

export function decodeDelta(buf) {
  const tables = [];
  readMessage(buf, (f, v) => {
    if (f !== 1) return;
    const t = { table: 0, partitions: [] };
    readMessage(v, (tf, tv) => {
      if (tf === 1) t.table = num(tv);
      else if (tf === 2) t.partitions.push(readPartition(tv));
    });
    tables.push(t);
  });
  return tables;
}

/** OwnerCatalog: [{ table, indexes }] */
export function encodeOwnerCatalog(tables) {
  const w = new ProtoWriter();
  for (const t of tables) {
    w.message(1, (tw) => {
      tw.uint(1, t.table);
      for (const ix of t.indexes) tw.message(2, writeIndexRef(ix), true);
    }, true);
  }
  return w.toBuffer();
}

export function decodeOwnerCatalog(buf) {
  const tables = [];
  readMessage(buf, (f, v) => {
    if (f !== 1) return;
    const t = { table: 0, indexes: [] };
    readMessage(v, (tf, tv) => {
      if (tf === 1) t.table = num(tv);
      else if (tf === 2) t.indexes.push(readIndexRef(tv));
    });
    tables.push(t);
  });
  return tables;
}

// ---- Chunk directories and statistics (spec 6.3, 6.4) ------------------------------------------

/**
 * One directory segment: { chunks: [{ ordinal, rowStart, rowCount, parts: [{ offset, length, digest? }] }],
 * statistics: [{ columns: [positions], section: ref }] }. Every chunk has `groupCount` parts.
 */
export function encodeChunkDirectory({ chunks, statistics }, withDigests) {
  const parts = chunks.flatMap((c) => c.parts);
  const w = new ProtoWriter(chunks.length * 12 + parts.length * (withDigests ? 40 : 8) + 64);
  w.packed(1, differences(chunks.map((c) => c.ordinal)));
  w.packed(2, differences(chunks.map((c) => c.rowStart)));
  w.packed(3, chunks.map((c) => c.rowCount));
  w.packed(4, differences(parts.map((p) => p.offset)));
  w.packed(5, parts.map((p) => p.length));
  if (withDigests) w.bytes(6, Buffer.concat(parts.map((p) => p.digest)));
  for (const s of statistics) w.message(7, (sw) => sw.packed(1, s.columns).message(2, writeRef(s.section)), true);
  return w.toBuffer();
}

/**
 * One directory segment as lists, without an object per chunk (readers keep chunk details in typed arrays):
 * { ordinals, rowStarts, rowCounts, offsets, lengths, digests (Buffer | null), statistics }; offsets, lengths and
 * digests hold `groupCount` parts per chunk.
 */
export function decodeChunkDirectoryLists(buf, groupCount) {
  let ordinals = [];
  let rowStarts = [];
  const rowCounts = [];
  let offsets = [];
  const lengths = [];
  let digests = null;
  const statistics = [];
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: readPacked(v, ordinals); break;
      case 2: readPacked(v, rowStarts); break;
      case 3: readPacked(v, rowCounts); break;
      case 4: readPacked(v, offsets); break;
      case 5: readPacked(v, lengths); break;
      case 6: digests = Buffer.from(bytesOf(v)); break;
      case 7: {
        const s = { columns: [], section: null };
        readMessage(v, (sf, sv) => {
          if (sf === 1) readPacked(sv, s.columns);
          else if (sf === 2) s.section = readRef(sv);
        });
        if (!s.section) throw bad('statistics block without a section');
        statistics.push(s);
        break;
      }
      default: break;
    }
  });
  ordinals = cumulative(ordinals);
  rowStarts = cumulative(rowStarts);
  offsets = cumulative(offsets);
  const n = ordinals.length;
  if (rowStarts.length !== n || rowCounts.length !== n || offsets.length !== n * groupCount || lengths.length !== n * groupCount) {
    throw bad('chunk directory lists are inconsistent');
  }
  if (digests && digests.length !== n * groupCount * DIGEST_SIZE) throw bad('chunk directory digests are inconsistent');
  for (let i = 0; i < n; i++) num(rowCounts[i]);
  for (let k = 0; k < lengths.length; k++) num(lengths[k]);
  return { ordinals, rowStarts, rowCounts, offsets, lengths, digests, statistics };
}

export function decodeChunkDirectory(buf, groupCount) {
  const { ordinals, rowStarts, rowCounts, offsets, lengths, digests, statistics } = decodeChunkDirectoryLists(buf, groupCount);
  const chunks = new Array(ordinals.length);
  for (let i = 0; i < chunks.length; i++) {
    const parts = new Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
      const k = i * groupCount + g;
      parts[g] = { offset: offsets[k], length: lengths[k], ...(digests ? { digest: digests.subarray(k * DIGEST_SIZE, (k + 1) * DIGEST_SIZE) } : {}) };
    }
    chunks[i] = { ordinal: ordinals[i], rowStart: rowStarts[i], rowCount: rowCounts[i], parts };
  }
  return { chunks, statistics };
}

/** Statistics section: [{ nullCounts: [n], min: [Buffer], max: [Buffer] }], one per covered column. */
export function encodeStatistics(columns) {
  const w = new ProtoWriter(256);
  for (const c of columns) {
    w.message(1, (cw) => {
      cw.packed(1, c.nullCounts);
      for (const b of c.min) cw.always(2, b);
      for (const b of c.max) cw.always(3, b);
    }, true);
  }
  return w.toBuffer();
}

export function decodeStatistics(buf) {
  const columns = [];
  readMessage(buf, (f, v) => {
    if (f !== 1) return;
    const c = { nullCounts: [], min: [], max: [] };
    readMessage(v, (cf, cv) => {
      if (cf === 1) readPacked(cv, c.nullCounts);
      else if (cf === 2) c.min.push(bytesOf(cv));
      else if (cf === 3) c.max.push(bytesOf(cv));
    });
    columns.push(c);
  });
  return columns;
}

// ---- Sorted index directory (spec 8.1) ---------------------------------------------------------

/** { pages: [{ first: Buffer, count, offset, length, digest? }], nulls: ref | null } */
export function encodeIndexDirectory({ pages, nulls }, withDigests) {
  const w = new ProtoWriter(pages.length * 24 + 64);
  for (const p of pages) w.always(1, p.first);
  w.packed(2, pages.map((p) => p.count));
  w.packed(3, differences(pages.map((p) => p.offset)));
  w.packed(4, pages.map((p) => p.length));
  if (withDigests) w.bytes(5, Buffer.concat(pages.map((p) => p.digest)));
  w.message(6, nulls ? writeRef(nulls) : null);
  return w.toBuffer();
}

export function decodeIndexDirectory(buf) {
  const firsts = [];
  const counts = [];
  let offsets = [];
  const lengths = [];
  let digests = null;
  let nulls = null;
  readMessage(buf, (f, v) => {
    switch (f) {
      case 1: firsts.push(bytesOf(v)); break;
      case 2: readPacked(v, counts); break;
      case 3: readPacked(v, offsets); break;
      case 4: readPacked(v, lengths); break;
      case 5: digests = Buffer.from(bytesOf(v)); break;
      case 6: nulls = readRef(v); break;
      default: break;
    }
  });
  offsets = cumulative(offsets);
  const n = firsts.length;
  if (counts.length !== n || offsets.length !== n || lengths.length !== n) throw bad('index directory lists are inconsistent');
  if (digests && digests.length !== n * DIGEST_SIZE) throw bad('index directory digests are inconsistent');
  return {
    pages: firsts.map((first, i) => ({
      first, count: num(counts[i]), offset: offsets[i], length: num(lengths[i]),
      ...(digests ? { digest: digests.subarray(i * DIGEST_SIZE, (i + 1) * DIGEST_SIZE) } : {}),
    })),
    nulls,
  };
}

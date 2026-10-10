// Fuzzing the readers (TASKS S-5): damaged files must fail with a JazminError - never another error, a hang, or a
// runaway allocation. Used by fuzz.test.js (a short run with a fixed seed) and scripts/fuzz.js (long runs).
//
// Whole files: plain (unencrypted) files are damaged section by section, and each damaged section gets a correct
// CRC-32 again, so the damage reaches the decoders instead of stopping at the checksum. Encrypted files would only
// exercise the authenticated decryption; their decoders are the same, and are also fuzzed directly.
import { append, JazminError, open, toJSON, write } from '../src/index.js';
import { crc32 } from '../src/binary.js';
import {
  decodeChunkDirectoryLists, decodeChunkMap, decodeColumnDefinitions, decodeDelta, decodeHeader, decodeIndexDirectory, decodeOwnerCatalog, joinChunkMaps,
  decodePartitionTable, decodeStatistics, findPartitions,
} from '../src/catalog.js';
import { decodeColumnar } from '../src/columnar.js';
import { findKeySlotPage, parseKeySlots, unsealSlot } from '../src/access.js';
import { SortedIndex, TrigramIndex, decodePostingsSection } from '../src/indexes.js';
import { decodeSection } from '../src/section.js';
import { PAGING } from '../src/writer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Small deterministic random generator (mulberry32), so a failing case can be replayed from its seed. */
export function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (list) => list[next.int(list.length)];
  return next;
}

const COLUMNS = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'name', type: 'string', index: ['sorted', 'trigram'] },
  { name: 'amount', type: 'decimal', index: 'sorted' },
  { name: 'score', type: 'float' },
  { name: 'active', type: 'bool' },
  { name: 'when', type: 'datetime' },
  { name: 'blob', type: 'binary' },
  { name: 'extra', type: 'json' },
];

const row = (i) => ({
  id: i === 119 ? 2n ** 62n : i, // the last id beyond 2^53 (rows stay sorted)
  name: i % 9 === 0 ? null : `Person ${i % 23} ${'ab'.repeat(i % 4)}`,
  amount: i % 7 === 0 ? null : `${i}.${String(i % 100).padStart(2, '0')}`,
  score: i % 11 === 0 ? null : i % 13 === 0 ? -0 : i / 3,
  active: i % 5 === 0 ? null : i % 2 === 0,
  when: i % 6 === 0 ? null : new Date(Date.UTC(2020, 0, 1) + i * 3_600_000),
  blob: i % 4 === 0 ? null : Buffer.from([i & 255, 1, 2]),
  extra: i % 8 === 0 ? null : { i, list: [i % 3, 'x'] },
});

/** Nested columns (reader feature nested-columns): a list of objects with a list inside, and an object. */
const NESTED_COLUMNS = [
  {
    name: 'staff', type: 'list', item: {
      type: 'object', fields: [
        { name: 'name', type: 'string' }, { name: 'pay', type: 'decimal' }, { name: 'since', type: 'datetime' },
        { name: 'tags', type: 'list', item: { type: 'string' } },
      ],
    },
  },
  { name: 'head', type: 'object', fields: [{ name: 'city', type: 'string' }, { name: 'score', type: 'float' }, { name: 'open', type: 'bool' }] },
];

const nestedRow = (i) => ({
  staff: i % 6 === 0 ? null : i % 5 === 0 ? [] : [
    { name: `N${i % 7}`, pay: `${i}.5`, since: new Date(Date.UTC(2020, 0, 1 + (i % 9))), tags: ['a', `t${i % 3}`] }, null, { name: null, tags: [] },
  ],
  head: i % 4 === 0 ? null : { city: `C${i % 3}`, score: i / 4, open: i % 2 === 0 },
});

/** Plain files covering the reader's features: indexes in several pages, sort order, appends, embedded files, codecs. */
/** Saved shapes for the corpus file with embedded files: grouped, and a plain list. */
const SHAPES = [
  { name: 'Totals', default: true, description: 'By name', shape: { $groupBy: 'name', $sort: ['name'], $rows: { name: 'name', total: { $sum: 'amount' }, n: { $count: true } } } },
  { name: 'List', shape: { $rows: { id: 'id', name: 'name', when: 'when' } } },
];

export function corpus() {
  const rows = Array.from({ length: 120 }, (_, i) => row(i));
  const base = { columns: COLUMNS, chunkRows: 16, metadata: { title: 'fuzz', n: 1 }, sortedBy: ['id'], [PAGING]: { pageBytes: 96 } };
  const files = [
    write(null, rows, { ...base, codec: 'none' }),
    write(null, rows, { ...base, codec: 'deflate' }),
    write(null, rows.slice(0, 40), { ...base, codec: 'brotli', chunkRows: 64 }),
    write(null, rows, {
      ...base, codec: 'none',
      files: [{ path: 'index.html', content: '<p>x</p>' }, { path: 'a/b.bin', content: Buffer.alloc(300, 7) }],
      package: { entry: 'index.html', title: 'Fuzz' },
      shapes: SHAPES, // saved shapes live in the files directory
    }),
    write(null, rows.slice(0, 60).map((r, i) => ({ ...r, ...nestedRow(i) })), { ...base, columns: [...COLUMNS, ...NESTED_COLUMNS], codec: 'none' }),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-fuzz-'));
  const file = path.join(dir, 'appended.jzm');
  write(file, rows.slice(0, 80), { ...base, codec: 'none' });
  append(file, { insert: rows.slice(80), delete: { id: { lt: 10 } }, codec: 'none', chunkRows: 16 });
  files.push(fs.readFileSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
  return files;
}

/** Section boundaries of a file: [{ at, length }] (the payload follows a 16-byte envelope); trailers are skipped. */
export function sections(buf) {
  const list = [];
  let at = 64;
  const end = buf.length - 44;
  while (at + 16 <= end) {
    // An appended file still holds the trailers of its earlier versions.
    if (buf.subarray(at + 40, at + 44).toString('latin1') === 'JZM1' && crc32(buf.subarray(at, at + 36)) === buf.readUInt32LE(at + 36)) {
      at += 44;
      continue;
    }
    const length = buf.readUInt32LE(at + 8);
    if (at + 16 + length > end) break;
    list.push({ at, length });
    at += 16 + length;
  }
  return list;
}

const SPECIAL = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x0a, 0x12, 0x08];

function fixSectionCrc(buf, s) {
  buf.writeUInt32LE(crc32(buf.subarray(s.at + 16, s.at + 16 + s.length)), s.at + 12);
}

function fixTrailerCrc(buf) {
  const t = buf.length - 44;
  if (t >= 0) buf.writeUInt32LE(crc32(buf.subarray(t, t + 36)), t + 36);
}

/** Changes some bytes of one payload region (bit flips, special values, long varints, copied runs). */
function damage(buf, start, length, rnd) {
  if (start < 0 || length <= 0 || start + length > buf.length) return;
  const at = start + rnd.int(length);
  switch (rnd.int(6)) {
    case 0: buf[at] ^= 1 << rnd.int(8); break;
    case 1: buf[at] = rnd.pick(SPECIAL); break;
    case 2: for (let i = at; i < Math.min(start + length, at + 1 + rnd.int(9)); i++) buf[i] = 0xff; break; // huge varint
    case 3: for (let i = at; i < Math.min(start + length, at + 1 + rnd.int(16)); i++) buf[i] = rnd.int(256); break;
    case 4: {
      const from = start + rnd.int(length);
      const n = Math.min(rnd.int(24) + 1, start + length - Math.max(at, from));
      if (n > 0) buf.copy(buf, at, from, from + n);
      break;
    }
    default: buf[at] = (buf[at] + (rnd() < 0.5 ? 1 : -1)) & 255; break;
  }
}

/** A damaged copy of `file`. */
export function mutate(file, rnd) {
  const buf = Buffer.from(file);
  const list = sections(buf);
  const op = rnd();
  if (op < 0.6 && list.length) {
    for (let k = 1 + (rnd() < 0.3 ? rnd.int(4) : 0); k > 0; k--) {
      const s = rnd.pick(list);
      damage(buf, s.at + 16, s.length, rnd);
      fixSectionCrc(buf, s);
    }
  } else if (op < 0.7 && list.length) {
    const s = rnd.pick(list);
    damage(buf, s.at, 8, rnd); // codec, flags, raw length
  } else if (op < 0.8) {
    if (buf.length < 108) return buf;
    damage(buf, buf.length - 44, 36, rnd); // trailer offsets and lengths
    fixTrailerCrc(buf);
  } else if (op < 0.87) {
    return buf.subarray(0, rnd.int(buf.length)); // truncated
  } else if (op < 0.93) {
    damage(buf, 0, 64, rnd); // preamble
  } else if (list.length > 1) {
    // A whole section's payload replaced by another's (lengths kept).
    const a = rnd.pick(list);
    const b = rnd.pick(list);
    const n = Math.min(a.length, b.length);
    buf.copy(buf, a.at + 16, b.at + 16, b.at + 16 + n);
    fixSectionCrc(buf, a);
  }
  return buf;
}

const FILTERS = [
  null, { id: 5 }, { id: { gte: 30, lt: 60 } }, { name: { contains: 'son 1' } }, { name: { startsWith: 'Person 2' } },
  { amount: { gt: '10.5' } }, { amount: '12.12' }, { score: { lt: 10 } }, { active: true }, { when: { isNull: true } },
  { or: [{ id: { lt: 3 } }, { name: { icontains: 'AB' } }] },
  // Nested columns (the corpus's nested file): their filters, and the statistics of their fields.
  { staff: { any: { name: 'N3', pay: { gt: '5' } } } }, { head: { match: { city: 'C1' } } }, { staff: { all: { tags: { any: 'a' } } } },
  { or: [{ not: { staff: { any: { since: null } } } }, { head: { match: { score: { lt: 3 } } } }] },
];

/** Reads a (possibly damaged) file every way a caller might. Returns null, or the unexpected error. */
export function exercise(buf) {
  try {
    const r = open(buf);
    try {
      void r.columns;
      void r.metadata;
      void r.indexes;
      void r.sortedBy;
      void r.package;
      const n = r.rowCount;
      for (const filter of FILTERS) {
        try {
          r.explain(filter);
          let k = 0;
          for (const x of r.find(filter, { limit: 40 })) if (x && ++k > 40) break;
        } catch (error) {
          if (!(error instanceof JazminError)) throw error;
        }
      }
      if (n > 0) {
        for (const id of [0, Math.floor(n / 2), n - 1]) {
          try {
            r.get(id);
          } catch (error) {
            if (!(error instanceof JazminError)) throw error;
          }
        }
      }
      for (const f of r.files) {
        try {
          r.readFile(f.path);
          r.readFileRange(f.path, 1, 20);
        } catch (error) {
          if (!(error instanceof JazminError)) throw error;
        }
      }
      for (const s of r.shapes) {
        try {
          toJSON(r, { shape: s.name });
        } catch (error) {
          if (!(error instanceof JazminError)) throw error;
        }
      }
      [...r.rows({ select: r.columns.slice(0, 2).map((c) => c.name) })];
    } finally {
      r.close();
    }
    return null;
  } catch (error) {
    return error instanceof JazminError ? null : error;
  }
}

/** Decoders on their own, with damaged or random input. Returns null, or the unexpected error. */
export function exerciseDecoders(input, rnd) {
  const types = ['bool', 'int', 'float', 'decimal', 'string', 'datetime', 'binary', 'json'];
  const attempts = [
    () => decodeHeader(input),
    () => decodeChunkDirectoryLists(input, 1 + rnd.int(3)),
    () => decodeStatistics(input),
    () => decodeIndexDirectory(input),
    () => decodePartitionTable(input),
    () => findPartitions(input, [input.subarray(0, 12)]),
    () => decodeDelta(input),
    () => decodeOwnerCatalog(input),
    () => joinChunkMaps(decodeChunkMap(input), decodeChunkMap(input.subarray(input.length >> 1))),
    () => decodeColumnDefinitions(input),
    () => decodeColumnar(input, Array.from({ length: 1 + rnd.int(4) }, () => rnd.pick([...types, ...NESTED_COLUMNS])), rnd.int(300), 0),
    () => SortedIndex.decodePage(input, rnd.pick(types)),
    () => SortedIndex.decodePage(input, rnd.pick(types), true), // keys as differences (reader feature index-deltas)
    () => TrigramIndex.decode(input),
    () => decodePostingsSection(input),
    () => findKeySlotPage(input, input.subarray(0, 8)),
    () => unsealSlot(parseKeySlots(input), Buffer.alloc(32, 1), Buffer.alloc(32), Buffer.alloc(16)),
    () => decodeSection(input, { sectionId: 'x' }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      if (!(error instanceof JazminError)) return error;
    }
  }
  return null;
}

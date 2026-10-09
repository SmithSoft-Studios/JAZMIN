// Changes made through a document (docs/design/editable-documents.md, spec 7.9): writeChanges makes a change file
// from an open file, as its document's viewer does; applyChanges writes one into the file, checking every change again
// and holding those whose rows changed since the sender's copy.
import { isDeepStrictEqual } from 'node:util';
import { append } from './append.js';
import { JazminKeyError, JazminValidationError } from './errors.js';
import { open, write } from './index.js';
import { JazminKey } from './keys.js';

const VERSION = 1;
const OP = 'jazmin.op';
const SET = 'jazmin.set';
const BEFORE = 'jazmin.before.';
const META = 'jazmin.changes';
const OPS = ['add', 'update', 'delete']; // the order a call's changes are made in
const FIND_BATCH = 500; // keys per query when rows are looked up by key

/** A key's values as text: one row per key, whatever its types. */
const keyText = (row, key) => JSON.stringify(key.map((k) => {
  const v = row[k];
  return v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? `${v}n` : v;
}));
const show = (row, key) => key.map((k) => `${k} ${row[k] instanceof Date ? row[k].toISOString() : String(row[k])}`).join(', ');

/** The reader of the table a change set is about (`reader` itself, or another table of the file opened beside it). */
function tableReader(reader, edit) {
  const name = edit.table ?? reader.tables[0];
  return reader.table === name ? reader : reader.openTable(name);
}

/** Rows by key: Map keyText -> row, read in batches by the key columns. */
function findByKeys(reader, key, rows) {
  const found = new Map();
  const unique = [...new Map(rows.map((r) => [keyText(r, key), r])).values()];
  for (let i = 0; i < unique.length; i += FIND_BATCH) {
    const batch = unique.slice(i, i + FIND_BATCH);
    const filter = key.length === 1
      ? { [key[0]]: { in: batch.map((r) => r[key[0]]) } }
      : { or: batch.map((r) => Object.fromEntries(key.map((k) => [k, r[k]]))) };
    for (const row of reader.find(filter)) found.set(keyText(row, key), row);
  }
  return found;
}

/** A column definition to write a change file with (what a definition needs, at any depth). */
const definition = ({ name, type, nullable, item, fields }) => ({
  name, type, nullable: nullable !== false, ...(item ? { item: definition(item) } : {}), ...(fields ? { fields: fields.map(definition) } : {}),
});

/** A call's changes as [{ op, key, values }], checked against what the document allows. */
function changeList(changes, edit, editable) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw new JazminValidationError('Changes are { update, add, delete }: lists of rows');
  for (const name of Object.keys(changes)) if (!OPS.includes(name)) throw new JazminValidationError(`Changes: unknown '${name}' (update, add, delete)`);
  const out = [];
  const seen = new Set();
  for (const op of OPS) {
    const list = changes[op];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new JazminValidationError(`Changes: ${op} must be a list of rows`);
    if (list.length && op === 'add' && !edit.add) throw new JazminValidationError("This document doesn't allow adding rows");
    if (list.length && op === 'delete' && !edit.delete) throw new JazminValidationError("This document doesn't allow deleting rows");
    for (const row of list) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new JazminValidationError(`Changes: ${op} must be a list of rows (objects)`);
      const key = {};
      for (const k of edit.key) {
        if (row[k] === undefined || row[k] === null) throw new JazminValidationError(`Changes: a row to ${op} without its key column '${k}'`);
        key[k] = row[k];
      }
      const values = {};
      for (const [name, value] of Object.entries(row)) {
        if (edit.key.includes(name)) continue;
        if (op === 'delete') throw new JazminValidationError(`Changes: give the rows to delete by their key only ('${name}' isn't a key column)`);
        if (!editable.has(name)) throw new JazminValidationError(`Column '${name}' can't be changed through this document`);
        values[name] = value === undefined ? null : value;
      }
      if (op === 'update' && !Object.keys(values).length) throw new JazminValidationError(`Changes: the update of ${show(key, edit.key)} changes nothing`);
      const text = keyText(key, edit.key);
      if (seen.has(text)) throw new JazminValidationError(`Changes: ${show(key, edit.key)} appears twice: one change per row`);
      seen.add(text);
      out.push({ op, key, values });
    }
  }
  if (!out.length) throw new JazminValidationError('No changes to save');
  return out;
}

/**
 * A change file (bytes) for changes to `source`, an open file whose document allows them (package.edit): { update:
 * [rows: key + the columns that change], add: [rows], delete: [keys] }. They are checked as far as the sender can (what
 * the document allows, rows this key sees, the values' types), with the earlier values taken from `source`.
 * It is sealed with the submission key of a shared file's access key; give a file that isn't shared its key or
 * password (options.key / options.password).
 */
export function writeChanges(source, changes, { key, password } = {}) {
  const edit = source.package?.edit;
  if (!edit) throw new JazminValidationError("This file's document doesn't allow changes (it has no package.edit)");
  let seal;
  if (source.access) {
    if (source.access.isOwner) throw new JazminValidationError("A shared file's owner changes it directly (update, append), not with a change file");
    if (!source.submissionKey) throw new JazminValidationError('This shared file has no submission keys yet (written before they existed): its owner adds them with any rewrite');
    seal = { key: source.submissionKey };
  } else if (source.encrypted) {
    if (!key && !password) throw new JazminValidationError('Give the key or password the file opens with, to seal its changes with');
    seal = key ? { key } : { password };
  } else {
    seal = {};
  }
  const reader = tableReader(source, edit);
  try {
    const columns = new Map(reader.columns.map((c) => [c.name, c]));
    for (const k of edit.key) if (!columns.has(k)) throw new JazminValidationError(`The key column '${k}' isn't visible with this key`);
    const editable = edit.columns.filter((n) => columns.has(n)); // the ones this key sees
    const list = changeList(changes, edit, new Set(editable));
    const current = findByKeys(reader, edit.key, list.map((c) => c.key));
    const rows = list.map(({ op, key: k, values }) => {
      const now = current.get(keyText(k, edit.key));
      if (op === 'add' && now) throw new JazminValidationError(`A row with ${show(k, edit.key)} is already there: change it instead`);
      if (op !== 'add' && !now) throw new JazminValidationError(`No row with ${show(k, edit.key)} is visible with this key`);
      const set = Object.keys(values);
      const row = { [OP]: op, [SET]: op === 'delete' ? null : set, ...k };
      for (const n of editable) {
        row[n] = n in values ? values[n] : null;
        row[BEFORE + n] = op === 'delete' || (op === 'update' && n in values) ? now[n] : null;
      }
      return row;
    });
    const defs = [
      { name: OP, type: 'string', nullable: false },
      { name: SET, type: 'json' },
      ...edit.key.map((k) => definition(columns.get(k))),
      ...editable.map((n) => ({ ...definition(columns.get(n)), nullable: true })),
      ...editable.map((n) => ({ ...definition(columns.get(n)), name: BEFORE + n, nullable: true })),
    ];
    const metadata = {
      [META]: {
        version: VERSION, file: source.fileId, table: reader.table, key: edit.key, columns: editable, sender: source.access?.keyId ?? null,
        based: { writtenAt: source.writtenAt.toISOString(), appendCount: source.appendCount },
      },
    };
    return write(null, rows, { columns: defs, metadata, ...seal });
  } finally {
    if (reader !== source) reader.close();
  }
}

/**
 * Opens a change file for `target`: a shared file's with the submission key of the grant it was made with (`keyId`,
 * or each grant's in turn), checking that grant as the filing service does; another file's with its own key or
 * password. Returns { reader, grant }.
 */
function openChangeFile(target, change, { key, password, keyId, receivedAt }) {
  if (!target.access) {
    try {
      return { reader: open(change, { ...(key ? { key } : {}), ...(password ? { password } : {}) }), grant: null };
    } catch (error) {
      if (error instanceof JazminKeyError) throw new JazminValidationError("The change file doesn't open with this file's key: it was made for another file");
      throw error;
    }
  }
  const owner = JazminKey.from(key);
  const grants = target.access.grants;
  const candidates = keyId ? grants.filter((g) => g.keyId === keyId) : grants;
  if (keyId && !candidates.length) throw new JazminValidationError(`Key ${keyId} has no grant in this file: unknown or revoked`);
  for (const grant of candidates) {
    let reader;
    try {
      reader = open(change, { key: owner.submissionKey(grant.keyId) });
    } catch (error) {
      if (error instanceof JazminKeyError) continue;
      throw error;
    }
    // A grant that expires: the change file must have been written, and have arrived, before it expired.
    if (grant.expires) {
      const expires = Date.parse(grant.expires);
      const problem = !Number.isFinite(expires) ? `its expiry '${grant.expires}' isn't a date`
        : !(Number(receivedAt) <= expires) ? `it arrived at ${new Date(Number(receivedAt)).toISOString()}, after the key's access expired at ${grant.expires}`
          : reader.writtenAt.getTime() > expires ? `it was written at ${reader.writtenAt.toISOString()}, after the key's access expired at ${grant.expires}` : null;
      if (problem) {
        reader.close();
        throw new JazminValidationError(`Key ${grant.keyId}'s change file can't be applied: ${problem}`);
      }
    }
    return { reader, grant };
  }
  throw new JazminValidationError("The change file doesn't open with the submission key of any key granted this file: it was made by a revoked key, for another file, or changed");
}

/** Whether two columns hold the same type (at any depth; whether the column itself may be empty doesn't count). */
const sameType = (a, b) => isDeepStrictEqual(definition({ ...a, name: '', nullable: true }), definition({ ...b, name: '', nullable: true }));

/**
 * Applies a change file (bytes, or a path) to the file at `path`, as its document allows changes now (package.edit).
 * A shared file is changed with its owner key; the sender is the grant whose submission key opens the change file
 * (`keyId` names it, else each grant is tried), and may change only the rows and columns its grant covers. Rows changed
 * since the sender's copy are held as conflicts; `overwrite: true` applies them too. `dryRun`: everything but the write.
 *   options: { key | password, keyId, overwrite, dryRun, receivedAt (ms; default now: when the file arrived) }
 * Returns { sender, fileChanged, updated, added, deleted, conflicts: [{ op, key, kind ('changed' | 'exists' |
 * 'missing'), columns?: [{ name, before, wanted, now }] }], refused: [{ op, key, reason }] }.
 */
export function applyChanges(path, change, options = {}) {
  const { key, password, keyId = null, overwrite = false, dryRun = false, receivedAt = Date.now() } = options;
  const target = open(path, { ...(key ? { key } : {}), ...(password ? { password } : {}) });
  let plan;
  let tableName;
  let edit;
  try {
    if (target.access && !target.access.isOwner) throw new JazminValidationError("A shared file's changes are applied with its owner key");
    edit = target.package?.edit;
    if (!edit) throw new JazminValidationError("The file doesn't take changes: its document has no package.edit");
    const table = tableReader(target, edit);
    tableName = table.table;
    try {
      const { reader, grant } = openChangeFile(target, change, { key, password, keyId, receivedAt });
      try {
        plan = planChanges(target, table, reader, grant, edit, overwrite);
      } finally {
        reader.close();
      }
    } finally {
      if (table !== target) table.close();
    }
  } finally {
    target.close();
  }
  const { upsert, remove, result } = plan;
  if (!dryRun && (upsert.length || remove.length)) {
    const filter = remove.length === 0 ? undefined : edit.key.length === 1
      ? { [edit.key[0]]: { in: remove.map((r) => r[edit.key[0]]) } }
      : { or: remove.map((r) => Object.fromEntries(edit.key.map((k) => [k, r[k]]))) };
    append(path, {
      ...(key ? { key } : {}), ...(password ? { password } : {}), ...(target.tables.length > 1 ? { table: tableName } : {}),
      ...(upsert.length ? { upsert, keyColumns: edit.key } : {}), ...(filter ? { delete: filter } : {}),
    });
  }
  return result;
}

/** What applying a change file does: the rows to write and delete, and the result. */
function planChanges(target, table, changes, grant, edit, overwrite) {
  const meta = changes.metadata?.[META];
  if (!meta || meta.version !== VERSION) throw new JazminValidationError('This is not a change file (version 1)');
  if (meta.table !== table.table || !isDeepStrictEqual(meta.key, edit.key)) {
    throw new JazminValidationError(`The change file is for table '${meta.table}' by ${JSON.stringify(meta.key)}; this file's document changes '${table.table}' by ${JSON.stringify(edit.key)}`);
  }
  const columns = new Map(table.columns.map((c) => [c.name, c]));
  const changeColumns = new Map(changes.columns.map((c) => [c.name, c]));
  for (const [name, c] of changeColumns) {
    const base = name.startsWith(BEFORE) ? name.slice(BEFORE.length) : name;
    if (name === OP || name === SET) continue;
    const mine = columns.get(base);
    if (!mine) throw new JazminValidationError(`The change file has a column '${base}' this file doesn't have`);
    if (!sameType(mine, c)) throw new JazminValidationError(`Column '${base}' is ${c.type} in the change file, ${mine.type} in this file`);
  }

  // What the sender may touch: a shared file's grant (its partitions and columns), and the document's edit settings.
  const partitionBy = target.access?.partitionBy ?? null;
  const own = grant && grant.rows !== '*' ? new Set(grant.rows) : null;
  const covered = grant && grant.columns !== '*' ? new Set(grant.columns.flatMap((g) => target.access.groupColumns[g] ?? [])) : null;
  const mayWrite = (name) => edit.columns.includes(name) && changeColumns.has(name) && (!covered || covered.has(name));
  const ownsPartition = (row) => !partitionBy || !own || own.has(String(row[partitionBy]));

  const rows = [...changes.rows()];
  const current = findByKeys(table, edit.key, rows);
  const state = new Map(current); // key text -> the row as it stands, or null once deleted
  const touched = new Set();
  const result = { sender: grant?.keyId ?? null, fileChanged: meta.file !== target.fileId, updated: 0, added: 0, deleted: 0, conflicts: [], refused: [] };
  const keyOf = (row) => Object.fromEntries(edit.key.map((k) => [k, row[k]]));

  for (const row of rows) {
    const op = row[OP];
    const k = keyOf(row);
    const text = keyText(row, edit.key);
    const refuse = (reason) => result.refused.push({ op, key: k, reason });
    if (!OPS.includes(op)) { refuse(`unknown operation '${op}'`); continue; }
    if (edit.key.some((name) => row[name] === null || row[name] === undefined)) { refuse('no key'); continue; }
    if (op === 'add' && !edit.add) { refuse("the document doesn't allow adding rows"); continue; }
    if (op === 'delete' && !edit.delete) { refuse("the document doesn't allow deleting rows"); continue; }
    const set = op === 'delete' ? [] : row[SET];
    if (!Array.isArray(set) || set.some((n) => typeof n !== 'string')) { refuse('no list of the columns it sets'); continue; }
    const notAllowed = set.find((n) => !mayWrite(n));
    if (notAllowed !== undefined) { refuse(`column '${notAllowed}' can't be changed by this sender`); continue; }
    const now = state.get(text) ?? null;
    if (now && !ownsPartition(now)) { refuse(`the row is in partition '${now[partitionBy]}', which this sender isn't granted`); continue; }
    if (partitionBy && set.includes(partitionBy) && own && !own.has(String(row[partitionBy]))) { refuse(`partition '${row[partitionBy]}' isn't granted to this sender`); continue; }
    const changedSince = (names) => names.filter((n) => !isDeepStrictEqual(now[n], row[BEFORE + n]))
      .map((n) => ({ name: n, before: row[BEFORE + n], wanted: op === 'delete' ? undefined : row[n], now: now[n] }));

    if (op === 'update' || (op === 'add' && now)) {
      if (!now) { result.conflicts.push({ op, key: k, kind: 'missing' }); continue; }
      if (op === 'add') {
        if (!overwrite) { result.conflicts.push({ op, key: k, kind: 'exists' }); continue; }
      } else {
        const changed = changedSince(set);
        if (changed.length && !overwrite) { result.conflicts.push({ op, key: k, kind: 'changed', columns: changed }); continue; }
      }
      const next = { ...now };
      for (const n of set) next[n] = row[n];
      state.set(text, next);
      touched.add(text);
      result.updated += 1;
    } else if (op === 'add') {
      const next = Object.fromEntries(table.columns.map((c) => [c.name, null]));
      Object.assign(next, k);
      for (const n of set) next[n] = row[n];
      if (partitionBy && !set.includes(partitionBy)) {
        if (own?.size === 1 && columns.get(partitionBy).type === 'string') next[partitionBy] = [...own][0]; // a grant of one partition: rows go there
        else { refuse(`an added row must name its partition (${partitionBy})`); continue; }
      }
      if (!ownsPartition(next)) { refuse(`partition '${next[partitionBy]}' isn't granted to this sender`); continue; }
      const empty = table.columns.find((c) => c.nullable === false && next[c.name] === null);
      if (empty) { refuse(`column '${empty.name}' can't be empty`); continue; }
      state.set(text, next);
      touched.add(text);
      result.added += 1;
    } else {
      if (!now) { result.conflicts.push({ op, key: k, kind: 'missing' }); continue; }
      const changed = changedSince(edit.columns.filter((n) => changeColumns.has(BEFORE + n)));
      if (changed.length && !overwrite) { result.conflicts.push({ op, key: k, kind: 'changed', columns: changed }); continue; }
      state.set(text, null);
      touched.add(text);
      result.deleted += 1;
    }
  }

  const upsert = [];
  const remove = [];
  for (const text of touched) {
    const row = state.get(text);
    if (row) upsert.push(row);
    else if (current.has(text)) remove.push(current.get(text));
  }
  return { upsert, remove, result };
}


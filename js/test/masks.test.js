import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminKeyError, append, compact, issueFileUnlockToken, open, update, write } from '../src/index.js';
import { rowMasker, shownCodePoints, shownText, tableMasks } from '../src/masks.js';

// Masked columns (spec 7.6.8): a column shown masked until its lock opens, with a shown column made by a rule and,
// for masked rows only, an unmasked column.

const ITERATIONS = 1000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-masks-'));
const rows = [
  { id: 1, dept: 'A', name: 'Ann', account: '4821 0393 7712 4821', email: 'thandi@example.com', salary: '52000.00' },
  { id: 2, dept: 'A', name: 'Ben', account: '1111 2222 3333 4444', email: 'ben@example.org', salary: '61000.50' },
  { id: 3, dept: 'B', name: 'Cas', account: '9', email: null, salary: null },
];
const columns = [
  { name: 'id', type: 'int' }, { name: 'dept', type: 'string' }, { name: 'name', type: 'string' },
  { name: 'account', type: 'string', mask: { lock: 'pay', show: { keepFormat: true, last: 4 } } },
  { name: 'email', type: 'string', mask: { lock: 'pay', show: { keepFormat: true } } },
  { name: 'salary', type: 'decimal', mask: { lock: 'hr', rows: { id: { gte: 2 } } } },
];

function staffFile(file = path.join(tmpDir(), 'staff.jzm')) {
  const owner = JazminKey.generate();
  const keys = { staff: owner.createAccessKey(), deptB: owner.createAccessKey(), noMask: owner.createAccessKey() };
  write(file, rows, {
    columns, key: owner, access: {
      partitionBy: 'dept',
      grants: [{ key: keys.staff, rows: '*' }, { key: keys.deptB, rows: ['B'] }, { key: keys.noMask, rows: '*', columns: ['*'] }],
    },
    locks: { pay: { password: 'pw', iterations: ITERATIONS }, hr: { online: true } },
  });
  return { owner, keys, file };
}

const asKey = (file, key) => open(fs.readFileSync(file), { key: key.toString(), accessState: false });

test('what a masked value shows, by each rule', () => {
  assert.equal(shownText({ kind: 'last', last: 4 }, '4821 0393 7712 4821'), '••••4821');
  assert.equal(shownText({ kind: 'last', last: 4 }, '482'), '••••', 'too short to show any of it');
  assert.equal(shownText({ kind: 'firstLast', first: 2, last: 2 }, '8501015009087'), '85••••87');
  assert.equal(shownText({ kind: 'keepFormat', last: 4 }, '4821 0393-7712 4821'), '•••• ••••-•••• 4821');
  assert.equal(shownText({ kind: 'keepFormat', last: 4 }, 'thandi@example.com'), 't•••••@example.com', 'an email keeps its domain');
  assert.equal(shownText({ kind: 'last', last: 2 }, '61000.50'), '••••50');
  assert.equal(shownText({ kind: 'last', last: 4 }, null), null);
});

test('the fast shown text is the same as by code points, for every rule', () => {
  const pieces = ['4821', ' ', '-', '.', '@', 'é', 'ß', 'Ж', '٣', '½', 'x', 'Z', '0', '/', '••', '名'];
  let seed = 7;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const rules = [{ kind: 'last', last: 0 }, { kind: 'last', last: 4 }, { kind: 'firstLast', first: 2, last: 3 }, { kind: 'keepFormat', last: 0 },
    { kind: 'keepFormat', last: 4 }, { kind: 'keepFormat', last: 64 }];
  for (let i = 0; i < 3000; i++) {
    let text = '';
    for (let k = next(12); k > 0; k--) text += pieces[next(pieces.length)];
    for (const rule of rules) assert.equal(shownText(rule, text), shownCodePoints(rule, text), JSON.stringify([rule, text]));
  }
});

test('a key granted a masked column sees it masked, with its shown and unmasked columns, until it unlocks', () => {
  const { keys, file, owner } = staffFile();
  const r = asKey(file, keys.staff);
  assert.deepEqual(r.columns.map((c) => c.name), ['id', 'dept', 'name', 'account_shown', 'email_shown', 'salary_unmasked']);
  assert.deepEqual(r.masked.map((m) => m.at), [3, 3, 3], 'account, email and salary come after id, dept and name');
  assert.deepEqual(r.masked.map((m) => [m.column, m.type, m.group, m.lock.id, m.lock.kind, m.lock.unlocked, m.shown ?? null, m.unmasked ?? null]), [
    ['account', 'string', 'mask.account', 'pay', 'password', false, 'account_shown', null],
    ['email', 'string', 'mask.email', 'pay', 'password', false, 'email_shown', null],
    ['salary', 'decimal', 'mask.salary', 'hr', 'online', false, null, 'salary_unmasked'],
  ]);
  assert.deepEqual([...r.rows()].map((x) => [x.account_shown, x.email_shown, x.salary_unmasked]), [
    ['•••• •••• •••• 4821', 't•••••@example.com', '52000.00'], ['•••• •••• •••• 4444', 'b••@example.org', null], ['9', null, null],
  ]);
  assert.throws(() => [...r.find({ account: '9' })], /account/, 'a filter on a masked column fails as for a hidden one');
  assert.throws(() => r.unlock('pay', { password: 'nope' }), JazminKeyError);
  r.unlock('pay', { password: 'pw' });
  assert.deepEqual([...r.find({ account: '9' })].map((x) => x.id), [3], 'unlocked, it is a column like any other');
  assert.deepEqual(r.masked.map((m) => m.lock.unlocked), [true, true, false]);
  assert.ok(!r.columns.some((c) => c.name === 'salary'), 'its own lock still shuts salary');
  r.unlock('hr', { unlockToken: issueFileUnlockToken(file, owner, 'hr') });
  assert.deepEqual([...r.rows()].map((x) => [x.salary, x.salary_unmasked]), [[null, '52000.00'], ['61000.50', null], [null, null]]);
  // Another table reader of the same file is built again too.
  r.close();
});

test('masks are per grant and per partition; a grant without the masked group never sees it', () => {
  const { keys, file } = staffFile();
  const b = asKey(file, keys.deptB);
  assert.deepEqual([...b.rows()].map((x) => x.id), [3]);
  b.unlock('pay', { password: 'pw' });
  assert.deepEqual([...b.rows()].map((x) => x.account), ['9']);
  b.close();
  const owner = JazminKey.generate();
  const reader = owner.createAccessKey();
  const narrow = write(null, rows, {
    columns, key: owner, access: { columnGroups: { contact: ['name'] }, grants: [{ key: reader, columns: ['contact'] }] },
    locks: { pay: { password: 'pw', iterations: ITERATIONS }, hr: { online: true } },
  });
  const n = open(narrow, { key: reader.toString(), accessState: false });
  assert.deepEqual(n.masked, [], 'not granted the masked groups');
  n.close();
});

test('the owner sees everything; rewrites and appends keep the masks; new rows follow the rows filter', () => {
  const { keys, file, owner } = staffFile();
  const o = open(file, { key: owner });
  assert.deepEqual(o.masked.map((m) => [m.column, m.lock.unlocked]), [['account', true], ['email', true], ['salary', true]]);
  // The owner sees how each is masked, and every lock, also those only masked columns use.
  assert.deepEqual(o.masked.map((m) => [m.show, m.rows ?? null]), [[{ keepFormat: true, last: 4 }, null], [{ keepFormat: true, last: 4 }, null], ['none', { id: { gte: 2 } }]]);
  assert.deepEqual(o.locks.map((l) => [l.id, l.kind, l.unlocked]), [['hr', 'online', true], ['pay', 'password', true]]);
  assert.equal([...o.rows()][1].salary, '61000.50');
  assert.deepEqual(o.writerFeatures.sort(), ['file-locks', 'masked-columns']);
  assert.deepEqual(o.readerFeatures, [], 'no reader feature: older readers read the file, the masked columns hidden');
  o.close();
  const check = (when, expected) => {
    const r = asKey(file, keys.staff);
    assert.equal(r.masked.length, 3, when);
    r.unlock('pay', { password: 'pw' });
    assert.deepEqual([...r.rows()].map((x) => [x.id, x.account, x.account_shown, x.salary_unmasked]), expected, when);
    r.close();
  };
  const before = [[1, '4821 0393 7712 4821', '•••• •••• •••• 4821', '52000.00'], [2, '1111 2222 3333 4444', '•••• •••• •••• 4444', null], [3, '9', '9', null]];
  check('written', before);
  compact(file, { key: owner });
  check('compacted', before);
  update(file, { key: owner, insert: [{ id: 0, dept: 'A', name: 'Dee', account: '7777 8888', salary: '1.00' }] });
  check('updated', [...before, [0, '7777 8888', '•••• 8888', '1.00']]);
  append(file, { key: owner, insert: [{ id: 9, dept: 'B', name: 'Eve', account: '1234 5678', salary: '2.00' }] });
  check('appended', [...before, [0, '7777 8888', '•••• 8888', '1.00'], [9, '1234 5678', '•••• 5678', null]]);
});

test("a row's value goes where the rows filter says, each time it is written", () => {
  const { columns: all, masks } = tableMasks(columns);
  const masker = rowMasker(masks, all);
  const written = (row) => {
    const out = masker(row);
    return [out.salary ?? null, out.salary_unmasked ?? null];
  };
  assert.deepEqual(written({ id: 2, salary: '5.00' }), ['5.00', null], 'matches: masked');
  assert.deepEqual(written({ id: 1, salary: '5.00' }), [null, '5.00'], "doesn't: unmasked");
  assert.deepEqual(written({ id: 2, salary: null, salary_unmasked: '5.00' }), [null, '5.00'], 'only an unmasked value (one the file has): kept');
  assert.deepEqual(written({ id: 2, salary: '5.00', salary_unmasked: 'old' }), ['5.00', null], 'a masked value wins');
});

test('an update unmasks a column for the keys that had it masked, folding its shown and unmasked columns back', () => {
  const { keys, file, owner } = staffFile();
  update(file, { key: owner, masks: { account: null, salary: null } });
  const r = asKey(file, keys.staff);
  assert.deepEqual(r.columns.map((c) => c.name), ['id', 'dept', 'name', 'account', 'salary', 'email_shown']);
  assert.deepEqual(r.masked.map((m) => m.column), ['email']);
  assert.deepEqual([...r.rows()].map((x) => [x.account, x.salary]), [['4821 0393 7712 4821', '52000.00'], ['1111 2222 3333 4444', '61000.50'], ['9', null]]);
  r.close();
  const noMask = asKey(file, keys.noMask);
  assert.ok(!noMask.columns.some((c) => ['account', 'salary'].includes(c.name)), 'a key that never had the columns still has not');
  noMask.close();
  const o = open(file, { key: owner });
  assert.deepEqual(o.masked.map((m) => m.column), ['email']);
  assert.deepEqual(o.writerFeatures.sort(), ['file-locks', 'masked-columns']);
  o.close();
  assert.throws(() => update(file, { key: owner, masks: { account: null } }), /column 'account' isn't masked/);
});

test('an update masks a column anew for the keys that saw it, in a named group or the default one', () => {
  const owner = JazminKey.generate();
  const [contact, other] = [owner.createAccessKey(), owner.createAccessKey()];
  const file = path.join(tmpDir(), 'people.jzm');
  write(file, [{ id: 1, name: 'Ann', phone: '082 555 1234', email: 'ann@example.com' }, { id: 2, name: 'Ben', phone: '083 555 9876', email: 'ben@example.org' }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'phone', type: 'string' }, { name: 'email', type: 'string' }],
    key: owner, access: { columnGroups: { contact: ['phone'] }, grants: [{ key: contact, columns: ['*', 'contact'] }, { key: other, columns: ['*'] }] },
  });
  update(file, {
    key: owner, locks: { pay: { password: 'pw', iterations: ITERATIONS } },
    masks: { phone: { lock: 'pay', show: { last: 4 } }, email: { lock: 'pay', show: { keepFormat: true } } },
  });
  const a = asKey(file, contact);
  assert.deepEqual(a.masked.map((m) => m.column), ['phone', 'email']);
  assert.deepEqual([...a.rows()].map((x) => [x.phone_shown, x.email_shown]), [['••••1234', 'a••@example.com'], ['••••9876', 'b••@example.org']]);
  a.unlock('pay', { password: 'pw' });
  assert.deepEqual([...a.rows()].map((x) => x.phone), ['082 555 1234', '083 555 9876']);
  a.close();
  const b = asKey(file, other);
  assert.deepEqual(b.masked.map((m) => m.column), ['email'], 'phone stays out of reach of a key without its group; email was in the default group');
  b.close();
  // Given again with another rule: the shown values follow it.
  update(file, { key: owner, masks: { phone: { lock: 'pay', show: { first: 3, last: 2 } } } });
  const again = asKey(file, contact);
  assert.deepEqual([...again.rows()].map((x) => x.phone_shown), ['082••••34', '083••••76']);
  again.close();
  assert.throws(() => update(file, { key: owner, masks: { nope: { lock: 'pay' } } }), /masks: no column 'nope'/);
  const plain = path.join(tmpDir(), 'plain.jzm');
  write(plain, [{ id: 1 }], { columns: [{ name: 'id', type: 'int' }] });
  assert.throws(() => update(plain, { masks: {} }), /masks need a shared file/);
});

test('masks are checked', () => {
  const owner = JazminKey.generate();
  const access = { grants: [{ key: owner.createAccessKey() }] };
  const base = { key: owner, access, locks: { pay: { password: 'pw', iterations: ITERATIONS } } };
  const col = (mask) => [{ name: 'id', type: 'int' }, { name: 'account', type: 'string', mask }];
  assert.throws(() => write(null, [], { columns: col({ lock: 'pay' }), key: owner }), /masked columns need an access-controlled file/);
  assert.throws(() => write(null, [], { ...base, columns: col({ lock: 'nope' }) }), /Column 'account': mask: no lock 'nope' \(locks: pay\)/);
  assert.throws(() => write(null, [], { ...base, columns: col({}) }), /needs the lock that opens it/);
  assert.throws(() => write(null, [], { ...base, columns: col({ lock: 'pay', show: { last: 99 } }) }), /show.last must be a whole number from 0 to 64/);
  assert.throws(() => write(null, [], { ...base, columns: col({ lock: 'pay', show: { column: 'label' } }) }), /show.column 'label' is not a column/);
  assert.throws(() => write(null, [], { ...base, columns: col({ lock: 'pay', hide: true }) }), /unknown option 'hide'/);
  assert.throws(() => write(null, [], { ...base, columns: [...col({ lock: 'pay', show: { last: 4 } }), { name: 'account_shown', type: 'string' }] }),
    /a column 'account_shown' is there already/);
  assert.throws(() => write(null, [], { ...base, access: { ...access, columnGroups: { money: ['account'] } }, columns: col({ lock: 'pay' }) }), /in two column groups/);
  assert.throws(() => write(null, [], { ...base, columns: col({ lock: 'pay' }), locks: { pay: null } }), /no lock 'pay' to remove|no lock 'pay'/);
  // A shown column the owner fills: no rule, the values as given.
  const own = write(null, [{ id: 1, account: '12345', label: 'Savings ending 45' }], {
    ...base, columns: [...col({ lock: 'pay', show: { column: 'label' } }), { name: 'label', type: 'string' }],
  });
  const r = open(own, { key: access.grants[0].key.toString(), accessState: false });
  assert.deepEqual([...r.rows()], [{ id: 1, label: 'Savings ending 45' }]);
  assert.equal(r.masked[0].shown, 'label');
  r.close();
});

test("an unlock reaches the readers of the file's other tables, opened before it", () => {
  const owner = JazminKey.generate();
  const key = owner.createAccessKey();
  const file = write(null, { notes: [{ n: 1 }], people: rows }, {
    tables: [{ name: 'notes', columns: [{ name: 'n', type: 'int' }] }, { name: 'people', columns }],
    key: owner, access: { grants: [{ key }] },
    locks: { pay: { password: 'pw', iterations: ITERATIONS }, hr: { online: true } },
  });
  const notes = open(file, { key: key.toString(), accessState: false });
  const people = notes.openTable('people');
  assert.deepEqual(notes.masked, []);
  assert.equal(people.masked.length, 3);
  assert.ok(!people.columns.some((c) => c.name === 'account'));
  notes.unlock('pay', { password: 'pw' });
  assert.deepEqual([...people.rows()].map((x) => x.account), ['4821 0393 7712 4821', '1111 2222 3333 4444', '9']);
  people.close();
  notes.close();
});

test('the package says how viewers show revealed values, by column; checked', () => {
  const owner = JazminKey.generate();
  const base = {
    columns, key: owner, access: { grants: [{ key: owner.createAccessKey() }] },
    locks: { pay: { password: 'pw', iterations: ITERATIONS }, hr: { online: true } }, files: [{ path: 'index.html', content: '<p>Staff</p>' }],
  };
  const bytes = write(null, rows, { ...base, package: { entry: 'index.html', masks: { salary: { reveal: 'column', seconds: 0, whenHidden: true, idleSeconds: 120 } } } });
  assert.deepEqual(open(bytes, { key: owner }).package.masks, { salary: { reveal: 'column', seconds: 0, whenHidden: true, idleSeconds: 120 } });
  assert.throws(() => write(null, rows, { ...base, package: { masks: { salary: { reveal: 'all' } } } }), /package.masks.salary.reveal: 'value' or 'column'/);
  assert.throws(() => write(null, rows, { ...base, package: { masks: { salary: { seconds: -1 } } } }), /a whole number of seconds from 0 to 86400/);
  assert.throws(() => write(null, rows, { ...base, package: { masks: { salary: { blur: true } } } }), /unknown setting 'blur'/);
});

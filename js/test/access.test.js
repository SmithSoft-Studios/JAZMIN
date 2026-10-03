import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JazminAccessKey, JazminFormatError, JazminKey, JazminKeyError, JazminValidationError, JazminWriter, open, write,
} from '../src/index.js';

const owner = JazminKey.generate();
const bob = owner.createAccessKey();
const sally = owner.createAccessKey();
const carol = owner.createAccessKey(); // issued but never granted

const columns = [
  { name: 'id', type: 'int', nullable: false, index: 'sorted' },
  { name: 'country', type: 'string', index: 'sorted' },
  { name: 'name', type: 'string' },
  { name: 'salary', type: 'float' },
  { name: 'idNumber', type: 'string' },
];
const countries = ['ZA', 'NA', 'BW', null];
// Deliberately interleaved: every row starts a new chunk, the worst case for partitioning.
const rows = Array.from({ length: 40 }, (_, i) => ({
  id: i, country: countries[i % 4], name: `Person ${i}`, salary: 1000 + i, idNumber: `ID-${i}`,
}));

const access = {
  partitionBy: 'country',
  columnGroups: { pii: ['salary', 'idNumber'] },
  grants: [
    { key: bob, rows: ['ZA'], columns: ['*'], label: 'Bob' },
    { key: sally.toString(), rows: ['BW', 'NA'], columns: '*', label: 'Sally' },
  ],
};
const file = write(null, rows, { columns, key: owner, access });
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));

test('the owner sees every row and column, with indexes and the grant list', () => {
  const r = open(file, { key: owner });
  assert.deepEqual([...r.rows()], rows);
  assert.equal(r.access.isOwner, true);
  assert.deepEqual(r.access.grants.map((g) => [g.label, g.keyId, g.rows, g.columns]),
    [['Bob', bob.id, ['ZA'], ['*']], ['Sally', sally.id, ['BW', 'NA'], '*']]);
  assert.equal(r.explain({ id: 7 }).strategy, 'index');
});

test('Bob sees only his rows, and not the restricted columns', () => {
  const r = open(file, { key: bob.toString() });
  const visible = ['id', 'country', 'name'];
  assert.deepEqual(r.columns.map((c) => c.name), visible);
  assert.deepEqual([...r.rows()], rows.filter((x) => x.country === 'ZA').map((x) => pick(x, visible)));
  assert.equal(r.rowCount, 10);
  assert.equal(r.hiddenRowCount, 30);
  assert.deepEqual(r.access.visiblePartitions, ['ZA']);
  assert.equal(r.access.grants, undefined); // only the owner sees who has access
  assert.deepEqual(r.indexes, []); // indexes would reveal other groups' values
  assert.deepEqual([...r.find({ name: { contains: '12' } })].map((x) => x.id), [12]);
  // Hidden columns' names are locked too (spec 7.6.5): to Bob, 'salary' does not exist.
  assert.throws(() => [...r.find({ salary: { gt: 0 } })], /unknown column 'salary'/);
  assert.throws(() => r.get(1), JazminKeyError); // row 1 is NA
  assert.equal(r.get(0).name, 'Person 0');
});

test('Sally sees her partitions including the restricted columns', () => {
  const r = open(file, { key: sally });
  assert.deepEqual([...r.rows()], rows.filter((x) => x.country === 'BW' || x.country === 'NA'));
  assert.deepEqual([...r.find({ country: 'NA', salary: { gt: 1030 } })].map((x) => x.id), [33, 37]);
  assert.equal(r.explain({ country: 'NA' }).chunksSkipped, 10); // the BW chunks, by group name alone
});

test('a key that was never granted, or a key from another owner, is rejected', () => {
  assert.throws(() => open(file, { key: carol }), /not been granted/);
  const stranger = JazminKey.generate().createAccessKey();
  assert.throws(() => open(file, { key: stranger }), /not signed by the owner of this key/);
  assert.throws(() => open(file, { key: JazminKey.generate() }), /not signed by the owner/);
  assert.throws(() => open(file), JazminKeyError);
  assert.throws(() => open(file, { password: 'x' }), JazminKeyError);
});

test('content is encrypted and tampering is detected', () => {
  assert.ok(!file.includes(Buffer.from('Person 1')));
  assert.ok(!file.includes(Buffer.from('salary')));

  const chunk = Buffer.from(file);
  chunk[100] ^= 1; // inside the first chunk part
  assert.throws(() => [...open(chunk, { key: owner }).rows()], JazminFormatError);

  // Rewriting the public key in the slot section breaks the owner check or the signature.
  const slotsAt = file.lastIndexOf(Buffer.from('"owner":"'));
  const forged = Buffer.from(file);
  forged[slotsAt + 12] = forged[slotsAt + 12] === 0x41 ? 0x42 : 0x41;
  assert.throws(() => open(forged, { key: bob }));
});

test('only the owner key can create an access-controlled file, and grants must come from that owner', () => {
  assert.throws(() => write(null, rows, { columns, key: bob, access }), JazminValidationError);
  assert.throws(() => write(null, rows, { columns, password: 'x', access }), JazminValidationError);
  const other = JazminKey.generate().createAccessKey();
  assert.throws(() => write(null, rows, { columns, key: owner, access: { grants: [{ key: other }] } }), /different owner/);
});

test('without partitionBy, grants cover all rows; access keys round-trip as text', () => {
  const f = write(null, rows, { columns, key: owner, access: { columnGroups: { pii: ['salary'] }, grants: [{ key: bob, columns: ['*'] }] } });
  const r = open(f, { key: JazminAccessKey.parse(bob.toString()) });
  assert.equal(r.rowCount, 40);
  assert.ok(!r.columns.some((c) => c.name === 'salary'));
  assert.equal(new JazminWriter(null, { columns, key: owner, access: {} }).rowCount, 0);
});

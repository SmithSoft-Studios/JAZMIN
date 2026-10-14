import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JazminKey, JazminValidationError, open, update, write } from '../src/index.js';

// Links between a file's tables (docs/design/table-links.md): declared in the file (metadata 'jazmin.links'), checked
// when written (tables, columns, types), kept through renames, and checked against the rows (missing, empty, repeated).

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-links-'));
const clientColumns = [{ name: 'clientId', type: 'string' }, { name: 'name', type: 'string' }];
const txColumns = [{ name: 'clientId', type: 'string' }, { name: 'amount', type: 'decimal' }];
const link = { name: 'client', from: { table: 'transactions', columns: ['clientId'] }, to: { table: 'clients', columns: ['clientId'] } };
const clients = [{ clientId: 'C1', name: 'Ann' }, { clientId: 'C2', name: 'Ben' }, { clientId: 'C2', name: 'Ben again' }, { clientId: 'C4', name: 'Dee' }];
const transactions = [ // in clientId order, the one with no client first (empty values sort first)
  { clientId: null, amount: '5' }, { clientId: 'C1', amount: '1' }, { clientId: 'C1', amount: '2' }, { clientId: 'C2', amount: '3' },
  { clientId: 'C3', amount: '4' }, { clientId: 'C5', amount: '6' }, { clientId: 'C5', amount: '7' },
];

function file(sorted, extra = {}) {
  const target = path.join(temp(), 'statements.jzm');
  write(target, { clients, transactions }, {
    tables: [
      { name: 'clients', columns: clientColumns, ...(sorted ? { sortedBy: ['clientId'] } : {}) },
      { name: 'transactions', columns: txColumns, ...(sorted ? { sortedBy: ['clientId'] } : {}) },
    ],
    links: [link],
    ...extra,
  });
  return target;
}

test('links declared when written, read back, and checked: the same answer side by side (sorted) or by keys held', () => {
  for (const sorted of [true, false]) {
    const target = file(sorted, { metadata: { title: 'Statements' } });
    const r = open(target);
    assert.deepEqual(r.links, [link]);
    assert.equal(r.metadata.title, 'Statements');
    const [check] = r.checkLinks({ limit: 1 });
    r.close();
    assert.equal(check.method, sorted ? 'merge' : 'hash');
    // 7 rows: C1, C1, C2 found; C3, C5, C5 missing; one with no client.
    assert.deepEqual([check.rows, check.empty, check.missing, check.duplicateTargets], [7, 1, 3, 1], `sorted ${sorted}`);
    assert.deepEqual([check.examples, check.duplicateExamples], [[['C3']], [['C2']]]);
  }
});

test('links are checked when written, replaced or removed by update(), and follow a renamed table', () => {
  const target = file(false);
  const refused = (links, pattern) => assert.throws(() => update(target, { links }), (e) => e instanceof JazminValidationError && pattern.test(e.message));
  refused([{ ...link, to: { table: 'nope', columns: ['clientId'] } }], /Link 'client': to table 'nope' isn't in the file/);
  refused([{ ...link, to: { table: 'clients', columns: ['nope'] } }], /table 'clients' has no column 'nope'/);
  refused([{ ...link, to: { table: 'clients', columns: ['name', 'clientId'] } }], /from and to need as many columns/);
  refused([link, link], /Link 'client' is declared twice/);
  refused([{ ...link, from: { table: 'transactions', columns: ['amount'] } }], /transactions\.amount is decimal but clients\.clientId is string/);

  update(target, { renameTables: { transactions: 'tx' } });
  let r = open(target);
  assert.deepEqual(r.links[0].from, { table: 'tx', columns: ['clientId'] });
  r.close();
  assert.throws(() => update(target, { removeTables: ['tx'] }), /Link 'client' uses table 'tx', which is being removed/);
  update(target, { removeTables: ['tx'], links: [] });
  r = open(target);
  assert.deepEqual([r.tables, r.links, Object.keys(r.metadata)], [['clients'], [], []]);
  r.close();
});

test('a link within one table (a manager), and a shared file: each key checks the rows it sees', () => {
  const dir = temp();
  const people = path.join(dir, 'people.jzm');
  write(people, [{ id: 1, manager: null }, { id: 2, manager: 1 }, { id: 3, manager: 9 }], {
    columns: [{ name: 'id', type: 'int' }, { name: 'manager', type: 'int' }],
    links: [{ name: 'manager', from: { table: '', columns: ['manager'] }, to: { table: '', columns: ['id'] } }],
  });
  let r = open(people);
  assert.deepEqual(r.checkLinks().map((c) => [c.rows, c.empty, c.missing, c.examples]), [[3, 1, 1, [[9]]]]);
  r.close();

  const owner = JazminKey.generate();
  const ann = owner.createAccessKey();
  const shared = path.join(dir, 'shared.jzm');
  write(shared, { clients: clients.filter((c) => c.name !== 'Ben again'), transactions: transactions.filter((t) => t.clientId) }, {
    key: owner, access: { grants: [{ key: ann, rows: ['C1', 'C3'] }] },
    tables: [{ name: 'clients', columns: clientColumns, partitionBy: 'clientId' }, { name: 'transactions', columns: txColumns, partitionBy: 'clientId' }],
    links: [link],
  });
  r = open(shared, { key: ann });
  const [check] = r.checkLinks();
  r.close();
  assert.deepEqual([check.rows, check.missing, check.examples], [3, 1, [['C3']]]); // Ann sees C1 and C3's transactions; C3 has no client
});

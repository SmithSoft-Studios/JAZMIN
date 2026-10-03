import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JazminAccessExpiredError, JazminKey, JazminUnlockRequiredError, JazminValidationError,
  append, inspect, issueUnlockToken, listUnlockTokens, open, update, write,
} from '../src/index.js';
import { grantExpiry } from '../src/expiry.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0); // when the file is written
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-expiry-')), name);
const memoryStore = () => {
  const records = new Map();
  return { records, read: (name) => records.get(name), write: (name, text) => records.set(name, text) };
};

const columns = [{ name: 'section', type: 'string' }, { name: 'amount', type: 'float' }];
const rows = [{ section: 'A', amount: 1 }, { section: 'B', amount: 2 }];

/** The scenario from the requirement: user1 2 hours, user2 2 weeks (online), user3 5 years. */
function scenario() {
  const owner = JazminKey.generate();
  const [user1, user2, user3] = [owner.createAccessKey(), owner.createAccessKey(), owner.createAccessKey()];
  const file = tmp('statement.jzm');
  write(file, rows, {
    columns, key: owner, now: T0,
    access: {
      grants: [
        { key: user1, expiresIn: '2h', label: 'user1' },
        { key: user2, expiresIn: '14d', mode: 'online', label: 'user2' },
        { key: user3, expiresIn: '5y', label: 'user3' },
      ],
    },
  });
  return { owner, user1, user2, user3, file };
}

const read = (file, options) => {
  const r = open(file, options);
  try {
    return [...r.rows()].length;
  } finally {
    r.close();
  }
};

test('expiry parsing: relative durations, calendar years and absolute dates', () => {
  assert.equal(grantExpiry({ expiresIn: '2h' }, T0), T0 + 2 * HOUR);
  assert.equal(grantExpiry({ expiresIn: '14d' }, T0), T0 + 14 * DAY);
  assert.equal(grantExpiry({ expiresIn: '5y' }, T0), Date.UTC(2031, 9, 1, 8, 0, 0));
  assert.equal(grantExpiry({ expiresIn: 90_000 }, T0), T0 + 90_000);
  assert.equal(grantExpiry({ expires: '2027-01-01T00:00:00Z' }, T0), Date.UTC(2027, 0, 1));
  assert.equal(grantExpiry({}, T0), undefined);
  assert.throws(() => grantExpiry({ expiresIn: 'soon' }, T0), JazminValidationError);
});

test('offline keys open until they expire, then are refused', () => {
  const { user1, user3, file } = scenario();
  assert.equal(read(file, { key: user1, now: T0 + HOUR, accessState: memoryStore() }), 2);
  assert.throws(() => read(file, { key: user1, now: T0 + 3 * HOUR, accessState: memoryStore() }), (e) =>
    e instanceof JazminAccessExpiredError && /expired at 2026-10-01T10:00:00.000Z/.test(e.message));
  assert.equal(read(file, { key: user3, now: T0 + 4 * 365 * DAY, accessState: memoryStore() }), 2);
  assert.throws(() => read(file, { key: user3, now: Date.UTC(2031, 9, 2), accessState: memoryStore() }), JazminAccessExpiredError);
  const r = open(file, { key: user3, now: T0, accessState: memoryStore() });
  assert.deepEqual([r.access.online, r.access.expires], [false, '2031-10-01T08:00:00.000Z']);
  r.close();
});

test('the clock cannot be set earlier than the signed file date', () => {
  const { user3, file } = scenario();
  assert.throws(() => read(file, { key: user3, now: T0 - DAY, accessState: memoryStore() }), /earlier than when this file was written/);
  assert.equal(read(file, { key: user3, now: T0 - 60_000, accessState: memoryStore() }), 2); // within the 5-minute tolerance
});

test('setting the clock back after an access is detected', () => {
  const { user1, file } = scenario();
  const state = memoryStore();
  assert.equal(read(file, { key: user1, now: T0 + 100 * 60_000, accessState: state }), 2);
  assert.throws(() => read(file, { key: user1, now: T0 + 30 * 60_000, accessState: state }), /Clock rollback detected/);
  assert.equal(read(file, { key: user1, now: T0 + 97 * 60_000, accessState: state }), 2); // small drift tolerated

  // Editing the record to an earlier time is detected; deleting it is the documented limit.
  const [name, text] = [...state.records][0];
  state.records.set(name, JSON.stringify({ ...JSON.parse(text), lastSeen: T0 }));
  assert.throws(() => read(file, { key: user1, now: T0 + 30 * 60_000, accessState: state }), /access record for this file was modified/);
});

test('the default state store keeps one record per file and key in a directory', () => {
  const { user1, file } = scenario();
  const dir = path.join(path.dirname(file), 'state');
  read(file, { key: user1, now: T0 + HOUR, accessState: { dir } });
  const records = fs.readdirSync(dir);
  assert.deepEqual(records, [`${inspect(file).fileId}.${user1.id}.json`]);
  assert.throws(() => read(file, { key: user1, now: T0 + 10 * 60_000, accessState: { dir } }), /Clock rollback detected/);
});

test('online keys need an unlock token, which the key service issues only until expiry', () => {
  const { owner, user2, user3, file } = scenario();
  let required;
  try {
    open(file, { key: user2, now: T0 });
  } catch (error) {
    required = error;
  }
  assert.ok(required instanceof JazminUnlockRequiredError);
  assert.deepEqual([required.fileId, required.keyId], [inspect(file).fileId, user2.id]);

  // Key service side (holds the owner key or the listed tokens):
  const token = issueUnlockToken(file, owner, required.keyId, { now: T0 + DAY });
  assert.equal(read(file, { key: user2, unlockToken: token, now: T0 + DAY, accessState: memoryStore() }), 2);
  assert.throws(() => issueUnlockToken(file, owner, user2, { now: T0 + 15 * DAY }), JazminAccessExpiredError);
  assert.throws(() => issueUnlockToken(file, owner, user3), /offline grant/);
  assert.throws(() => read(file, { key: user2, unlockToken: token, now: T0 + 15 * DAY, accessState: memoryStore() }), JazminAccessExpiredError);

  const other = scenario();
  const wrong = issueUnlockToken(other.file, other.owner, other.user2, { now: T0 }); // a token from another file
  assert.ok(wrong.startsWith('jzu1-'));
  assert.throws(() => open(file, { key: user2, unlockToken: wrong, now: T0 }), /unlock token is not valid/);
  assert.deepEqual(listUnlockTokens(file, owner).map((t) => [t.keyId, t.label, t.expires, t.token]),
    [[user2.id, 'user2', '2026-10-15T08:00:00.000Z', token]]);
});

test('the owner is never limited by expiry', () => {
  const { owner, file } = scenario();
  assert.equal(read(file, { key: owner, now: Date.UTC(2040, 0, 1) }), 2);
  const r = open(file, { key: owner });
  assert.deepEqual(r.access.grants.map((g) => [g.label, g.mode, g.expires]), [
    ['user1', 'offline', '2026-10-01T10:00:00.000Z'],
    ['user2', 'online', '2026-10-15T08:00:00.000Z'],
    ['user3', 'offline', '2031-10-01T08:00:00.000Z'],
  ]);
  r.close();
});

test('updates and appends drop expired grants; online tokens survive rewrites', () => {
  const { owner, user1, user2, user3, file } = scenario();
  const token = issueUnlockToken(file, owner, user2, { now: T0 });
  const result = update(file, { key: owner, insert: [{ section: 'C', amount: 3 }], now: T0 + 3 * HOUR });
  assert.equal(result.expiredGrantsRemoved, 1);
  assert.throws(() => open(file, { key: user1, now: T0 + HOUR, accessState: false }), /not been granted/);
  assert.equal(read(file, { key: user2, unlockToken: token, now: T0 + 4 * HOUR, accessState: memoryStore() }), 3);

  const appended = append(file, { key: owner, insert: [{ section: 'D', amount: 4 }], now: T0 + 15 * DAY });
  assert.equal(appended.expiredGrantsRemoved, 1); // user2's two weeks are over
  assert.throws(() => open(file, { key: user2, unlockToken: token, now: T0 + DAY, accessState: false }), /not been granted/);
  assert.equal(read(file, { key: user3, now: T0 + 16 * DAY, accessState: memoryStore() }), 4);
});

test('a grant that has already expired when the file is written gets no key slot', () => {
  const owner = JazminKey.generate();
  const late = owner.createAccessKey();
  const file = tmp('late.jzm');
  write(file, rows, { columns, key: owner, now: T0, access: { grants: [{ key: late, expires: T0 - HOUR }] } });
  assert.throws(() => open(file, { key: late, now: T0 - 2 * HOUR }), /not been granted/);
  assert.throws(() => write(null, rows, { columns, key: owner, access: { grants: [{ key: late, mode: 'later' }] } }), /mode must be/);
});

// Cost of access control on the section-by-section workload: the same 1.37M statement lines
// (5,000 sections) written as a plain file and as an access-controlled file with one partition
// per section, then read by the owner and by a client key that may see a single section.
// Run: node --max-semi-space-size=2 bench/access.js [sections=5000] [linesPerSection=274]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JazminKey, JazminWriter, open } from '../src/index.js';

const sections = Number(process.argv[2] ?? 5000);
const lines = Number(process.argv[3] ?? 274);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazmin-access-'));
const id = (s) => `ACC${String(s).padStart(6, '0')}`;
const columns = [
  { name: 'section', type: 'string', index: 'sorted' },
  { name: 'line', type: 'int' },
  { name: 'description', type: 'string' },
  { name: 'amount', type: 'float' },
  { name: 'balance', type: 'float' },
];
const owner = JazminKey.generate();
const client = owner.createAccessKey();
const target = id(Math.floor(sections * 0.73));

function build(file, options) {
  const start = performance.now();
  const writer = new JazminWriter(file, { columns, ...options });
  for (let s = 0; s < sections; s++) {
    for (let l = 0; l < lines; l++) {
      writer.writeRow({ section: id(s), line: l, description: `Payment ref ${(s * 1000 + l).toString(36)}`, amount: l * 1.5, balance: s + l });
    }
  }
  writer.finish();
  return { ms: performance.now() - start, mb: fs.statSync(file).size / 1048576 };
}

function time(fn, repeat = 20) {
  fn(); // warm up
  const start = performance.now();
  for (let i = 0; i < repeat; i++) fn();
  return (performance.now() - start) / repeat;
}

const plain = path.join(dir, 'plain.jzm');
const secured = path.join(dir, 'access.jzm');
const results = [];
const plainBuild = build(plain, { key: owner, sortedBy: ['section'] });
const accessBuild = build(secured, {
  key: owner,
  sortedBy: ['section'],
  access: { partitionBy: 'section', columnGroups: { money: ['amount', 'balance'] }, grants: [{ key: client, rows: [target], columns: ['*'] }] },
});
results.push(['Write, single-key encrypted', `${(plainBuild.ms / 1000).toFixed(1)} s, ${plainBuild.mb.toFixed(1)} MB`]);
results.push(['Write, access-controlled (5,000 partitions)', `${(accessBuild.ms / 1000).toFixed(1)} s, ${accessBuild.mb.toFixed(1)} MB`]);

const openRead = (file, key) => () => {
  const r = open(file, { key });
  const rows = [...r.find({ section: target })];
  r.close();
  return rows;
};
results.push(['Open + read one section: single-key file', `${time(openRead(plain, owner)).toFixed(2)} ms`]);
results.push(['Open + read one section: owner key, access file', `${time(openRead(secured, owner)).toFixed(2)} ms`]);
results.push(['Open + read own section: client key', `${time(openRead(secured, client)).toFixed(2)} ms`]);

const reader = open(secured, { key: owner });
results.push(['Per section, file already open (owner)', `${time(() => [...reader.find({ section: id(Math.floor(Math.random() * sections)) })], 500).toFixed(2)} ms`]);
reader.close();
results.push(['Peak process memory', `${Math.round(process.resourceUsage().maxRSS / 1024)} MB`]);

console.log(`\nJAZMIN access-control benchmark - Node ${process.version}: ${(sections * lines).toLocaleString()} lines, ${sections} sections\n`);
const width = Math.max(...results.map(([l]) => l.length));
for (const [label, value] of results) console.log(`${label.padEnd(width)}  ${value}`);
fs.rmSync(dir, { recursive: true, force: true });

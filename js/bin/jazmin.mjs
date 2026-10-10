#!/usr/bin/env node
// The jazmin command-line tool (GitHub issue #15): inspect, query, explain, advise, convert, keygen and script. Keys are
// read from the environment or a file and never printed, except by keygen.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { JazminError, JazminKey, exportFile, fromCSV, fromXML, importJSONFile, inspect, open, portableScript } from '../src/index.js';

const HELP = {
  main: `jazmin - inspect and query JAZMIN (.jzm) files

Usage: jazmin <command> [options]

Commands:
  inspect <file>    What a file holds: format, encryption, tables, columns, rows, chunks, indexes
  query <file>      Rows matching a filter, as JSON lines, JSON or CSV
  explain <file>    How a query runs; with --analyze, what it read
  advise <file>     Layout advice: how many chunks a value spans, and a better sortedBy or chunkRows
  convert <in> <out>  JSON, JSON Lines, CSV or XML to .jzm, or .jzm to JSON, CSV or XML
  keygen            A new key (or, with --access, an access key from the owner key)
  script <file>     The file as a script, which a page opened from disk opens with JazminBrowser.openScript()

Keys: set JAZMIN_KEY (key text), JAZMIN_PASSWORD or JAZMIN_UNLOCK_TOKEN, or pass --key-file, --password-file or
--unlock-token-file. Keys are never printed, except by keygen.

Run "jazmin <command> --help" for a command's options.`,
  inspect: `Usage: jazmin inspect <file> [--table <name>]

Prints a JSON description of the file. Without a key, an encrypted file shows only its format and flags.`,
  query: `Usage: jazmin query <file> [--filter <json>] [--select a,b] [--offset n] [--limit n] [--format jsonl|json|csv] [--table <name>]

Prints the matching rows: one JSON object per line (jsonl, the default), a JSON array, or CSV.
Filter example: --filter '{"country":"ZA","balance":{"gt":100}}'`,
  explain: `Usage: jazmin explain <file> [--filter <json>] [--analyze] [--select a,b] [--offset n] [--limit n] [--table <name>]

Prints how the query runs (index or scan). With --analyze it runs the query and adds what it read:
rows, bytesRead, chunksRead, indexPagesRead, columnsDecoded and ms.`,
  advise: `Usage: jazmin advise <file> --column <name> [--column <name> ...] [--json] [--table <name>]

For each column: how many chunks the rows of one value lie in, and what reading one value costs. Suggests a sortedBy
or chunkRows that would make those lookups read less, and partitions that compact({ regroup: true }) would merge.
Reads only chunk directories and statistics, not rows.`,
  convert: `Usage: jazmin convert <input> <output> [--filter <json>] [--sorted-by a,b] [--table <name>]

  data.json|data.jsonl|data.csv|data.xml -> data.jzm   column types are inferred; with JAZMIN_KEY (or JAZMIN_PASSWORD)
                                                       the file is encrypted; --sorted-by needs rows in that order
  data.jzm -> data.json|data.csv|data.xml              streamed with bounded memory; --filter exports matching rows`,
  keygen: `Usage: jazmin keygen [--access]

Prints a new key. With --access, prints a new access key issued from the owner key (JAZMIN_KEY or --key-file); grant
it rows and columns with grantAccess() or update({ grant }).`,
  script: `Usage: jazmin script <file.jzm> [<file.js>] [--name <name>]

Writes the file as a script (default: <file.jzm>.js beside it). Pages opened from disk can't read a file beside them,
but they can load a script, from any folder: JazminBrowser.openScript('<file.js>', { password }) opens it. The file
inside stays as it is (still encrypted), so no key is needed here. The page holds the whole file in memory: for files
up to about 20 MB. --name names the file inside (default: its file name).`,
};

const KEY_OPTIONS = { 'key-file': { type: 'string' }, 'password-file': { type: 'string' }, 'unlock-token-file': { type: 'string' } };

class UsageError extends Error {}

function readSecret(file, variable) {
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return process.env[variable] || undefined;
}

/** Reader options from the key options and the environment. */
function keyOptions(values) {
  const options = { key: readSecret(values['key-file'], 'JAZMIN_KEY'), password: readSecret(values['password-file'], 'JAZMIN_PASSWORD') };
  const unlockToken = readSecret(values['unlock-token-file'], 'JAZMIN_UNLOCK_TOKEN');
  if (unlockToken) options.unlockToken = unlockToken;
  return options;
}

function parse(args, options) {
  const { values, positionals } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true });
  return { values, positionals };
}

function fileArgument(positionals) {
  if (positionals.length !== 1) throw new UsageError('Give one file');
  if (!fs.existsSync(positionals[0])) throw new JazminError(`No such file: ${positionals[0]}`);
  return positionals[0];
}

function openReader(file, values) {
  const reader = open(file, keyOptions(values));
  return values.table ? reader.openTable(values.table) : reader;
}

const number = (text, name) => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number`);
  return n;
};

function filterOf(text) {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`--filter is not valid JSON: ${text}`);
  }
}

/** A row value as JSON: dates as ISO text, BigInts as text, binary as base64. */
const jsonValue = (v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v);
const jsonRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, jsonValue(v)]));
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const value = jsonValue(v);
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const out = (text) => process.stdout.write(`${text}\n`);

const commands = {
  inspect(args) {
    const { values, positionals } = parse(args, { ...KEY_OPTIONS, table: { type: 'string' } });
    const file = fileArgument(positionals);
    const facts = { file: path.basename(file), bytes: fs.statSync(file).size, ...inspect(file) };
    const keys = keyOptions(values);
    if ((facts.encrypted || facts.accessControlled) && !keys.key && !keys.password) {
      out(JSON.stringify({ ...facts, note: 'Set JAZMIN_KEY or JAZMIN_PASSWORD (or --key-file) to see the tables' }, null, 2));
      return;
    }
    const reader = openReader(file, values);
    try {
      out(JSON.stringify({
        ...facts,
        tables: reader.tables,
        table: reader.table,
        rows: reader.rowCount,
        hiddenRows: reader.hiddenRowCount,
        deletedRows: reader.deletedRowCount,
        chunks: reader.chunkCount,
        sortedBy: reader.sortedBy ?? [],
        columns: reader.columns.map(({ name, type, nullable, item, fields }) => ({ name, type, nullable, ...(item ? { item } : {}), ...(fields ? { fields } : {}) })),
        indexes: reader.indexes,
        access: reader.access,
        files: reader.files.length,
        metadata: reader.metadata,
      }, null, 2));
    } finally {
      reader.close();
    }
  },

  query(args) {
    const { values, positionals } = parse(args, {
      ...KEY_OPTIONS, table: { type: 'string' }, filter: { type: 'string' }, select: { type: 'string' },
      offset: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string', default: 'jsonl' },
    });
    if (!['jsonl', 'json', 'csv'].includes(values.format)) throw new UsageError('--format must be jsonl, json or csv');
    const file = fileArgument(positionals);
    const reader = openReader(file, values);
    try {
      const select = values.select ? values.select.split(',').map((c) => c.trim()) : undefined;
      const rows = reader.find(filterOf(values.filter), { select, offset: number(values.offset, 'offset'), limit: number(values.limit, 'limit') });
      if (values.format === 'csv') {
        const names = select ?? reader.columns.map((c) => c.name);
        out(names.map(csvCell).join(','));
        for (const row of rows) out(names.map((n) => csvCell(row[n])).join(','));
      } else if (values.format === 'json') {
        out(JSON.stringify([...rows].map(jsonRow), null, 2));
      } else {
        for (const row of rows) out(JSON.stringify(jsonRow(row)));
      }
    } finally {
      reader.close();
    }
  },

  explain(args) {
    const { values, positionals } = parse(args, {
      ...KEY_OPTIONS, table: { type: 'string' }, filter: { type: 'string' }, analyze: { type: 'boolean' },
      select: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' },
    });
    const file = fileArgument(positionals);
    const reader = openReader(file, values);
    try {
      const select = values.select ? values.select.split(',').map((c) => c.trim()) : undefined;
      out(JSON.stringify(reader.explain(filterOf(values.filter), {
        analyze: values.analyze, select, offset: number(values.offset, 'offset'), limit: number(values.limit, 'limit'),
      }), null, 2));
    } finally {
      reader.close();
    }
  },

  advise(args) {
    const { values, positionals } = parse(args, { ...KEY_OPTIONS, table: { type: 'string' }, column: { type: 'string', multiple: true }, json: { type: 'boolean' } });
    const file = fileArgument(positionals);
    if (!values.column?.length) throw new UsageError('Name at least one --column you filter on');
    const reader = openReader(file, values);
    try {
      const advice = reader.advise({ columns: values.column });
      if (values.json) {
        out(JSON.stringify(advice, null, 2));
        return;
      }
      const kb = (b) => `${Math.round(b / 1024).toLocaleString('en-US')} KB`;
      out(`${advice.rows.toLocaleString('en-US')} rows in ${advice.chunks} chunks (about ${advice.rowsPerChunk.toLocaleString('en-US')} rows, ${kb(advice.bytesPerChunk)} each)`
        + `, sorted by ${advice.sortedBy.length ? advice.sortedBy.join(', ') : 'nothing'}`);
      for (const c of advice.columns) {
        out(c.chunksPerValue === null ? `${c.column}: no statistics`
          : `${c.column}: one value's rows lie in about ${c.chunksPerValue} chunk(s), about ${kb(c.bytesPerValue)} to read${c.indexed ? ' (indexed)' : ''}`);
      }
      if (advice.partitions.length) out(`${advice.partitions.length} partitions, ${Math.max(...advice.partitions.map((p) => p.chunks))} chunks at most in one`);
      out(advice.suggestions.length ? advice.suggestions.map((s) => `- ${s}`).join('\n') : 'No suggestions: lookups of these columns read about as little as they can.');
    } finally {
      reader.close();
    }
  },

  convert(args) {
    const { values, positionals } = parse(args, { ...KEY_OPTIONS, table: { type: 'string' }, filter: { type: 'string' }, 'sorted-by': { type: 'string' } });
    if (positionals.length !== 2) throw new UsageError('Give an input file and an output file');
    const [input, output] = positionals;
    if (!fs.existsSync(input)) throw new JazminError(`No such file: ${input}`);
    const extension = (p) => path.extname(p).slice(1).toLowerCase();
    const [from, to] = [extension(input), extension(output)];
    if (from === 'jzm') {
      if (!['json', 'csv', 'xml'].includes(to)) throw new UsageError('A .jzm file converts to .json, .csv or .xml');
      const reader = openReader(input, values);
      try {
        exportFile(reader, to, output, { filter: filterOf(values.filter) ?? undefined });
      } finally {
        reader.close();
      }
      return;
    }
    if (to !== 'jzm') throw new UsageError('One of the two files must be a .jzm file');
    const { key, password } = keyOptions(values);
    const options = Object.fromEntries(Object.entries({ key, password, sortedBy: values['sorted-by']?.split(',').map((c) => c.trim()) }).filter(([, v]) => v !== undefined));
    if (from === 'json' || from === 'jsonl') importJSONFile(input, output, options);
    else if (from === 'csv') fromCSV(fs.readFileSync(input, 'utf8'), output, options);
    else if (from === 'xml') fromXML(fs.readFileSync(input, 'utf8'), output, options);
    else throw new UsageError('Convert .json, .jsonl, .csv or .xml to .jzm');
  },

  keygen(args) {
    const { values } = parse(args, { ...KEY_OPTIONS, access: { type: 'boolean' } });
    if (!values.access) {
      out(JazminKey.generate().export());
      return;
    }
    const ownerText = keyOptions(values).key;
    if (!ownerText) throw new UsageError('--access needs the owner key: set JAZMIN_KEY or pass --key-file');
    const accessKey = JazminKey.parse(ownerText).createAccessKey();
    out(accessKey.export());
    process.stderr.write(`Key id ${accessKey.id}. Grant it rows and columns with grantAccess() or update({ grant }).\n`);
  },

  script(args) {
    const { values, positionals } = parse(args, { name: { type: 'string' } });
    if (positionals.length < 1 || positionals.length > 2) throw new UsageError('Give a .jzm file, and where to write the script if not beside it');
    const [input, output = `${input}.js`] = positionals;
    if (!fs.existsSync(input)) throw new JazminError(`No such file: ${input}`);
    fs.writeFileSync(output, portableScript(input, { name: values.name }));
  },
};

function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(HELP.main);
    return 0;
  }
  if (!commands[command]) {
    process.stderr.write(`Unknown command '${command}'.\n\n${HELP.main}\n`);
    return 2;
  }
  if (args.includes('--help') || args.includes('-h')) {
    out(HELP[command]);
    return 0;
  }
  try {
    commands[command](args);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      process.stderr.write(`${error.message}\n\n${HELP[command]}\n`);
      return 2;
    }
    if (error instanceof JazminError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));

# Queries with arrow functions in JavaScript

Status: approved 2026-10-10 (TASKS J-10); built as described. USER-GUIDE 8.4 is the user-facing text.

## What people get

LINQ-style queries in Node and the browser, written with arrow functions. The reader still uses the file's indexes,
statistics and sort order, and decodes only the columns a query reads:

```js
import { from } from '@smithsoft-studios/jazmin';

const big = from(transactions)
  .where((t) => t.category === 'Travel' && t.amount < -5000)   // becomes { category: 'Travel', amount: { lt: -5000 } }
  .orderByDescending((t) => t.date)
  .select((t) => ({ when: t.date, where: t.merchant, amount: t.amount }))
  .take(20)
  .toArray();

const city = 'Durban';
const theirs = from(clients)
  .where((c, $) => c.city === $.city, { city })            // values from outside: the second argument (see below)
  .join(from(transactions), (c) => c.id, (t) => t.client, (c, t) => ({ name: c.name, amount: t.amount }))
  .groupBy((x) => x.name, (name, rows) => ({ name, spent: rows.sum((x) => x.amount) }))
  .toArray();

// In the browser the same, awaited: await JazminBrowser.from(reader).where(...).toArray()
```

## How a function becomes a filter

LINQ in C# gets a description of the lambda from the compiler (an expression tree). JavaScript has no such thing,
so the library reads the function's text (`fn.toString()`) and translates what it can into the filter language:

| In the function | Filter |
|---|---|
| `t.city === 'Durban'`, `==`, `!==`, `<`, `<=`, `>`, `>=` | `eq`, `ne`, `lt`, … (a column on one side, a literal or `$.name` on the other) |
| `&&`, `\|\|`, `!`, parentheses | `and`, `or`, `not` |
| `t.name.includes('x')`, `.startsWith('x')`, `t.name.toLowerCase().includes('x')` | `contains`, `startsWith`, `icontains` |
| `['ZA', 'NA'].includes(t.country)`, `$.list.includes(t.country)` | `in` |
| `t.note == null`, `t.note === null` | `isNull` |
| `t.active`, `!t.active` | `eq true`, `eq false` |
| `t.address.city === 'Durban'` (a nested column's field) | the field's path |

- **Always correct, fast where it can be.** The translated part only narrows the rows read (indexes, statistics,
  chunks skipped). The function itself then runs on each of those rows, so a function the library can't fully read
  (a helper call, a regular expression, a block body) still gives the right answer: it just reads more.
  `explain()` shows the filter that was used, and which parts of the function weren't translated.
- **Values from outside the function:** the function's text doesn't carry the values of variables it uses (`city`
  above). The function still runs with them, so the answer is right, but the filter can't use them. To let indexes
  use them, pass them as the second argument and read them through the second parameter: `(c, $) => c.city ===
  $.city, { city }`. `explain()` names variables it couldn't use.
- **Only the columns read are decoded:** the columns a query's functions name (`t.date`, `t.merchant`), or all of
  them when a function passes the whole row on (`helper(t)`).

## The rest of a query

| Method | Runs |
|---|---|
| `where(fn, values?)` | As above |
| `select(fn)` | The columns it names are the ones read; the function shapes each row |
| `orderBy`, `orderByDescending`, `thenBy`, `thenByDescending` | Nothing to sort when it follows the file's `sortedBy`; otherwise in memory |
| `skip(n)`, `take(n)` | As the reader's offset and limit when nothing runs in memory before them; otherwise after |
| `join(inner, outerKey, innerKey, result)` | The inner query is read once, its rows kept by key; the outer query streams past |
| `groupJoin(inner, outerKey, innerKey, result)` | The same, with each outer row's matches as a list |
| `groupBy(key, result?)` | In memory, by key |
| `count()`, `sum(fn)`, `min(fn)`, `max(fn)`, `average(fn)`, `first()`, `firstOrDefault()`, `any()` | `count()` of a translated `where` counts without decoding rows; the others read |
| `toArray()`, `for … of` (Node), `for await … of` (browser) | Run the query |
| `explain()` | The filter used, columns read, what ran in memory, and what wasn't translated |

The groups `groupBy` gives have the same methods (`rows.sum((x) => x.amount)`), in memory.

## Where it lives

- `js/src/lambda.js`: the translator (a small parser for the expressions above; the rest is left untranslated), shared
  by both readers.
- `from(reader)` in the library (synchronous, as `find`), `JazminBrowser.from(reader)` in the browser reader (async).
- No format change; .NET keeps LINQ (`AsQueryable<T>()`).

## Limits

- Code that tools have rewritten (minified, or compiled to older JavaScript) still works, as long as it stays an
  expression; `function (t) { return t.a === 1; }` is read too. Anything else simply isn't translated.
- No sub-query inside `select` (the .NET library turns those into one lookup): use `groupJoin`.
- Large `join`s and `groupBy`s hold their rows in memory, as LINQ to Objects does.

## Tests

The same queries as plain JavaScript over every row give the same results (many cases, every operator, nested fields,
nulls, values passed and not); `explain()` shows the expected filter and columns; index use measured on the demo
files; Node and the browser reader give the same results.

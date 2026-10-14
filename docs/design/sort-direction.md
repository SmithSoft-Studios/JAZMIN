# Sort direction: descending, and other orders

Status: **the owner asked (2026-10-14) for new ways of sorting kept as backward compatible as possible**: see
"A compatible design" at the end, which needs no new format version.

## Today

A table's sort order (`sortedBy`, spec 6.7) is always **ascending, with empty values first**, compared as the column's
type compares (numbers by value, dates by time, text by its characters, so `B` comes before `a`). Readers rely on it:
they find a value of the first sort column by searching the chunks' minimums and maximums. Queries can return rows in
any order (`orderBy: '-amount'`), but a descending order reads every matching row to sort them.

## The options

**A. Read a sorted table backwards, as fast as forwards** (no format change; recommended first)

```js
reader.rows({ reverse: true });                        // newest first, in a file sorted by date
reader.find({ account: 'A1' }, { reverse: true, limit: 50 });
```

The file stays sorted ascending; the reader walks the chunks from the last and each chunk's rows from the end. The
latest 50 transactions then cost what the first 50 cost now. Viewers and Scout use it for "newest first", and
`orderBy: '-date'` on the first sort column uses it automatically. Every existing file gains it.

**B. Store a descending order** (`sortedBy: [{ column: 'date', descending: true }]`; a format change)

The rows are kept newest first in the file itself. With A, this mostly changes where appends go: in a descending file
new rows would have to come before the old ones, which an append cannot do (it adds at the end), so every new row
would need a rewrite. Older readers would misread the order, so such files would carry a reader feature and older
versions would refuse them. Recommendation: not needed if A is built.

**C. Other orders: text compared without case or accents, numbers inside text, empty values last** (a format change)

- **Ignoring case and accents** (`apple`, `Banana`, `Émile` in that order) and **natural order** (`A2` before `A10`)
  change how values compare, so indexes, statistics and searches must all compare the same way. Each would be a
  per-column *collation* in the format, with a reader feature that older versions refuse.
- **Without a format change** the same is possible with a helper column: store `name_sort` (the name lowercased,
  accents removed, numbers padded) and sort by it. Scout could add such a column for you ("Sort by name, ignoring
  case").
- **Empty values last** can be had with A: read backwards and the empty values come last (in reverse).

## Decisions for the owner

1. Build **A** (fast backwards reading)? Recommended.
2. Is **B** (stored descending order) still wanted once A exists?
3. Which of **C** matter (case and accents, natural numbers, empty values last), and is the helper column (no format
   change) good enough?

## In Scout

The sort editor (Details → Change Indexes & Sort Order) would show, for each sort column, **Ascending**, and with A,
"readers can also read it newest first"; with B, **Descending**; with C, the comparison (exact, ignoring case, natural).

## A compatible design (owner's answer, 2026-10-14)

The format's rule for additions (spec 12) allows it without a new version:

- **A new optional table field `sort`** describes the order, column by column: `descending`, empty values `first` or
  `last`, and how text compares (`exact`, `nocase`: ignoring case and accents, `natural`: numbers inside text by value).
  Readers ignore fields they do not know.
- **Plain ascending order** (exact, empty values first) is also written as today's `sorted_by`, so older readers keep
  using it.
- **Any other order** leaves `sorted_by` empty. Older readers (1.0 to 1.5) then see an unsorted table: they read every
  row correctly, only without the order's speed-ups. They never refuse the file and never misread it.
- **Older writers** rebuild the header from what they understand, so an append or rewrite by 1.0 to 1.5 drops `sort`:
  the table then counts as unsorted, which is still correct. (To be confirmed by a test with the published 1.5.0 of both
  libraries.)
- **New readers** use `sort`: rows in the declared order without sorting them, reading forwards or backwards (option A,
  for every file), range searches on the first sort column in either direction, and merges on update in that order.
- **New writers** check rows against the declared order, and the comparison is the same everywhere (indexes and
  statistics keep comparing exactly, so filters mean what they mean today).
- **Writer features:** the format says a writer MUST refuse to modify a file with a writer feature it does not know,
  but 1.0 to 1.5 never checked. New writers will check, so a later feature can rely on it.

What it costs: a `nocase` or `natural` comparison is slower than an exact one when rows are written or merged (a key
is made per value); reading is unchanged.


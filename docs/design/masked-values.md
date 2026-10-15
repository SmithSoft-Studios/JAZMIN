# Masked values: columns shown masked until a password or 2FA

Status: **proposed** (2026-10-15), for the owner's review. Decided already (2026-10-15, #190): whole columns first,
with the format ready for single values; a masked value shows `••••` and, if the owner chooses, a part of it, kept as a
separate ordinary column that can be sorted and indexed; the owner sets how long a revealed value shows (default 30 s,
or off); free in the libraries and the viewer like locks (the editor in Scout Pro); in 1.7.0. This note proposes the
rest and lists what is still the owner's to decide (at the end).

## The idea in plain words

A shared file can have a column whose values are **masked**: people whose key sees the column see that it is there and
see `••••` (or a part the owner allows, such as the last four digits), but not the value. To see it, they unlock it
with a password, a 2FA check at the owner's key service, or both, exactly as a locked file opens (spec 6.8.1). A
revealed value shows for a while, then masks again.

Examples: a supplier's bank account (`•••• •••• 4821`), an ID number in an HR file (`••••••••••083`), a salary in a list
the whole team sees (`••••`, or a band such as `R40k–R50k` the owner writes), a patient's diagnosis code.

**What it protects, and what it can't.** Until unlocked, the value isn't in the reader's memory at all: it isn't
decrypted. So a leaked access key doesn't leak masked values. Once revealed, a value on screen can be copied or
photographed. The re-masking below is about people walking away from an open screen, not about stopping the person
who unlocked it.

## How it works (for developers)

Today a shared file's columns are in **column groups**, each encrypted with its own key; a grant either has a group's
secret (in its key slot, spec 7.6.4) or doesn't. A **masked column** is a column in a group of its own whose secret,
in each key slot that grants it, is **sealed under a lock** instead of given as it is:

- The slot's bundle gets `maskedColumns: { "<group>": { "lock": "<id>", "sealed": "<b64>" } }` and the lock's
  `{ kind, salt, iterations, keyService }`, the same locks as 6.8.1 (one password or 2FA check can open masked columns
  and locked files together). `sealed` is the group secret under the lock key, as file keys are.
- **Older readers** (1.0–1.6) ignore the bundle member they don't know: to them the masked column is a column their key
  doesn't see, which is hidden. They never show a masked value and never fail.
- The **owner** holds every lock (as for files), so the owner reads, rewrites and changes masked columns normally.
- The **shown part** is an ordinary column the owner adds next to it (`account` masked, `account_shown` with
  `•••• •••• 4821`): it is stored, sorted and indexed like any column, and a grant sees it as usual. The writer can make
  it from the masked value by a rule (below), or the owner gives the values.
- **Single values (rows):** the masked column may be null in rows that don't need masking, and the ordinary column of
  the same name, unmasked, holds those rows' values; a reader shows the unmasked value where there is one and the mask
  otherwise. That lets an owner mask only some rows (only directors' salaries) without a lock per cell. Built in 1.7 as
  format support; the editor and viewers handle whole columns first.

Library sketch:

```js
write('staff.jzm', rows, {
  key: owner, access: { partitionBy: 'dept', grants },
  columns: [..., { name: 'salary', type: 'decimal', mask: { lock: 'pay', shown: { column: 'salary_shown', rule: 'none' } } }],
  locks: { pay: { online: true } },
});
reader.columns;                     // salary: { masked: { lock: 'pay', kind: 'online', unlocked: false } }
row.salary;                         // undefined (masked); row.salary_shown: '••••'
reader.unlock('pay', { unlockToken });   // then rows have salary
```

## What a masked value shows (the shown part): options

| Option | Example (`4821 0393 7712 4821`) | Notes |
|---|---|---|
| **Nothing** | `••••` | The default. |
| **Last N characters** | `••••4821` (N = 4) | Bank accounts, cards, phone numbers. |
| **First N and last M** | `48••••21` | IDs where the start tells a type. |
| **Keep the format** | `•••• •••• •••• 4821` | Masks letters and digits, keeps spaces and punctuation; with last N. Emails: `t•••••@example.com` (domain kept). |
| **A value the owner writes** | `Visa ending 4821`, `R40k–R50k` | Any text per row, from the owner's data: a band, a category, a reference. |

The shown column is computed when the file is written (rules) or given by the owner; it is never derived by the viewer,
so a viewer never holds the full value to mask it.

## Showing a revealed value, and bystanders

What the viewers (the web viewer, Scout, document pages) do, set per column by the owner with sensible defaults:

| Behaviour | Proposed default | Owner can |
|---|---|---|
| **Reveal one value at a time** (click a cell) or the whole column | One value | Allow the whole column |
| **Re-mask after a time** | 30 s | Change it, or turn it off (shown while unlocked) |
| **Re-mask when the window is hidden or loses focus** (another tab, another app, the screen locks) | On | Turn off |
| **Re-mask after no input** (mouse, keyboard, touch) | 60 s | Change it, or turn off |
| **Forget the unlock** (ask for the password or 2FA again) | When the file is closed | Also after N minutes idle |
| **A Hide button** and a visible countdown on revealed values | On | — |
| **Leave revealed values out of printing, PDFs and screenshots made by the viewer** | Masked in them | Allow |

With "off", a revealed value stays shown while the column is unlocked, but the window and idle rules still re-mask it
unless they are turned off too, so walking away still hides it.

## Audit

With an online lock, the key service records who unlocked which column of which file, and when. A password lock leaves
no record. Viewers can also report a reveal to the page that embeds them (`jazmin:revealed`), for systems that log it.

## Compatibility

- Format version stays 1.0. The new members are optional; files without masked columns are unchanged.
- Older readers see a masked column as hidden (not granted) and the shown column as normal. Older writers: a file with
  masked columns names the writer feature `masked-columns`; 1.7 refuses to modify a file with a writer feature it
  doesn't know, but 1.0–1.6 don't check, and an append by them would write key slots without the masked secrets, so
  the masked column becomes unreadable for access keys (the owner still has it, and a 1.7 rewrite restores it). The
  release notes say to modify such files with 1.7 or later, as for locks.

## Decisions for the owner

1. **Shown part:** the five options above, all of them? (Recommended: all five; "Keep the format" covers cards, phones
   and emails.)
2. **Bystanders:** the defaults in the table (one value at a time, 30 s, re-mask when hidden or after 60 s without
   input, forget the unlock when the file closes)?
3. **Viewer reports** of reveals (`jazmin:revealed`) to the embedding page: build it? (Recommended: yes, opt-in by the
   page.)
4. **Single values:** the "masked for some rows" format support in 1.7, with viewers handling it in 1.7 as well, or the
   format only in 1.7 and viewers later? (Recommended: both in 1.7, since the reader merges the two columns and viewers
   just show what the reader gives.)

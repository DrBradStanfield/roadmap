# The web upload list: the screen (PR 2)

Status: draft for review, 2026-11-21. Built unmounted: production keeps drawing ReviewTable's grid.
Engine (merged): `uploadList` (packages/health-core/src/upload-list.ts) and `uploadView` (upload-view.ts).
Stories: US-13 AC5, AC10, AC12, AC21, AC24, AC26; US-02 AC4, AC7; US-12; US-14 AC11-13.

## The one rule

The screen draws what the engine exposes and adds no rule. It never decides whether a row saves, is in
error, blocks Save or takes typing, nor which caption shows. It never parses a number and never counts.
It owns one thing: the draft of the focused input.

## Layout, top to bottom

1. Summary: `view.summary`, then `view.alreadySaved` and `view.refused` when set.
2. Progress while files are read: `view.progress.line`, `view.progress.zip`, and Stop (`view.stop.label`).
3. Day controls: one per `list.days` entry, in its order, before any row (the iPhone puts its day
   sections first too). Each shows the file's name (`view.files.rows` by `fileId`), its words (below)
   and a date input. The input shows `chosen ?? day ?? ''`. A full date commits on change; '' is ignored.
4. The rows: one list (`<ul>`) holding every `list.rows` row, keyed by `row.key`, in engine order.
   Rows with `attention` always show. The rest carry `hidden` while "Show all" is closed. A row is never
   moved between parents, so a status change never remounts it or its input.
5. "Show all n" / "Hide": one button after the list, `list.showAll` / `list.hide`, drawn while
   `list.showAll` is set or the list is open. View state (a plain toggle, exempt from the mode rule).
6. Files: `view.files.row`, then each file's name and status (`view.files.rows`), then `view.notices`
   and the failed files' Try again (`view.sections` kind `failed`, `retry`). `view.documents.line`
   when letters will be saved (their editing is out of scope here; see Needs Brad).
7. The Save bar, sticky at the bottom: Save (`view.save.label`), Cancel, and under them one live
   region with `view.save.why` and `view.save.error`.
8. The done screen replaces 1-7: ✓, `view.done.line`, `archived`, `unstored`, each `skipped` and
   `notSaved` line, then Done (`view.doneLabel`).

## A row's parts

| Part | Drawn from | Reuses |
| --- | --- | --- |
| Tick | `row.ticked`; sends `{tick: ref, on}` | native checkbox |
| Label | `row.label` | `.bt-name-label` look |
| Number input | only when `row.input === 'number'`; value: the draft while it names the row, else `row.typed?.text ?? row.shown.text` | `.bt-input`, `.bt-input-error` (styles.css) |
| Unit | `row.shown.unit` | `.bt-cell-unit` |
| Caption | `row.caption`, when it is not the same words as `row.error` | `.review-overview-footer` look |
| Error | `row.error` | `--color-error`, as `.upload-error` |
| Replace | when `row.replaces`; checked `row.replacing`; sends `{replace: ref, correctsId: on ? row.replaces : null}` | `REVIEW_CELL_TEXT.replace` |
| Held value | `row.held`, beside Replace, muted (not struck through: it stays unless Replace is on) | `--color-text-secondary` |

The input is a plain `<input type="text" inputMode="decimal">`, not `NumericInputCell`: that cell
validates, waits on ranges, grades and filters keys (`blockBadNumericKeys`, `numericCellText`), all
rules the engine now owns. Held text must reach the engine as typed. Every control is disabled while
`view.editable` is false.

## The draft (the one state the screen owns)

`type Draft = null | { key: string; text: string }`, changed only by a pure
`transition(draft, event)` (widget-src/src/lib/upload-list-draft.ts) with a table test. Events:
`type` (key, text), `commit` (blur, Enter, Save press), `focus` (key), `escape`, `rows` (the keys that
take input now). A commit sends `{typed: ref, text, unit: row.shown.cell?.unit ?? null}` and drops the
draft; the input then shows what the engine returned. Typing in, or focusing, another row commits the
old draft first. Escape drops it unsent. A draft whose row no longer takes input is dropped.

Save press: commit any draft, re-read the view synchronously (`reread()`), then save only if
`save.enabled`; else move focus to the control of `save.blockers[0].at`.

## Keyboard and screen reader

- Focus order is DOM order: day controls, then each visible row (tick, input, Replace), Show all,
  files, Save, Cancel. Enter commits and keeps focus; Escape drops the draft (and only then stops the
  key, so a later mount's Escape-to-close still works with no draft).
- Refused Save: focus goes to the element whose `data-at` is the blocker's `at`: a row's input (its
  tick when `input: 'none'`), or a day control's date input. A blocker row always has `attention`,
  so it is never hidden.
- Names (US-13 AC10, value-free): tick and input are named `row.label`; the input is described by
  its unit, caption and error (`aria-describedby`), `aria-invalid` when `row.error`. Replace is named
  by its visible word and described by the row's label and the held value. A day input is named by
  its words below and described by the file's name.
- Flag: the engine exposes no row `name`. Two LDL rows on one report read the same ("LDL
  Cholesterol"), where AC10 names the column's day in words. `ValueRow.replaceLabel` exists only on
  the view's rows, not on `ListRow`. Engine PR: a `name` (and Replace label) on `ListRow`.
- The save line is one `role="status"` region, so the refusal and a failed save are heard.

## Phone first

At 375 px each row is two lines: tick, label, Replace on the first; input and unit, caption, error
on the second. From 600 px the input sits on the label's line. No horizontal scroll at either width.
The Save bar is sticky at the bottom, as `.review-actions` is today.

## Strings and their sources

| String | Source |
| --- | --- |
| summary, already-in-record count, run refusal | `view.summary`, `view.alreadySaved`, `view.refused` |
| progress, ZIP line, Stop | `view.progress`, `view.stop.label` (`UPLOAD_TEXT`) |
| row label | `row.label` (engine) |
| row caption | `row.caption` (`NOT_SAVED_TEXT`, `REVIEW_CELL_TEXT.alreadyInRecord`, `UPLOAD_TEXT.chooseDay`, `UPLOAD_TEXT.replaces`, `IMPORT_REVIEW_TEXT.conflictKept`) |
| row error | `row.error` (cell-input.ts guidance, `rangeMessage`, the write's words) |
| Replace | `REVIEW_CELL_TEXT.replace` |
| Show all n / Hide | `list.showAll`, `list.hide` (`IMPORT_REVIEW_TEXT`) |
| test day control | `UPLOAD_TEXT.dayOfTest` |
| undated previous column | ReviewTable.tsx `pickHints`: "Pick a day in {month} before {day}", with `longDate` |
| dated column | `UPLOAD_TEXT.dayOfTest`, with the printed day by `longDate` |
| files | `view.files.row`, `view.files.rows[].status`, `view.notices[].line` |
| Try again | `view.sections` failed `retry` (`UPLOAD_TEXT.retryAll`) |
| letters | `view.documents.line` |
| Save, why, error | `view.save.label`, `view.save.why`, `view.save.error` |
| Saving... | ReviewTable.tsx (shown while `view.phase === 'saving'`) |
| Cancel | ReviewTable.tsx |
| done lines, Done | `view.done`, `view.doneLabel` |

## Needs Brad

1. The "check these" heading. `IMPORT_REVIEW_TEXT.checkTitle(n)` needs a count, and the screen may not
   count. The engine gives the unsure count (`view.sections` unsure) but the list shows every row with
   `attention` (errors and touched rows too), so that title would be wrong. Drawn: no heading. Engine
   PR: a `check` title on `UploadList`, or Brad drops the heading.
2. Words for a dated previous column's day control. None exist. Drawn meanwhile: "Day of the test"
   with the printed day in words, which stays true.
3. The undated previous column's words live only in ReviewTable.tsx (upload-view.ts says so). Drawn
   meanwhile with the same words; they move into upload-text.ts before ReviewTable is deleted.
4. A row's accessible name (above): no day in it.
5. Letters: their title, kind and date controls (ReviewFileSections) are not on this screen yet.
6. A "check" row has no caption: `captionOf` returns null for `check`, and `ListRow` carries neither
   the reasons' words nor the extractor's question (`ValueRow.question`, `unitNote`). The person sees
   the row but not why to check it. Engine PR: a caption for `check`.
7. Rows waiting for a day carry no `attention`, so an undated report's rows sit behind "Show all"
   with only the day control and Save's line in view. The engine's call; noted, not changed.

## What a later PR does

Mounts UploadList from UploadModal in place of ReviewTable, runs Save through the shared
`uploadSave`, and deletes ReviewTable, ReviewMatrix, review-matrix.ts and import-review-view.ts.

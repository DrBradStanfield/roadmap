# The web upload list: the screen (PR 2)

Status: draft for review, 2026-11-21, round two (engine gaps closed by PRs 1946 and 1949). Built
unmounted: production keeps drawing ReviewTable's grid.
Engine: `uploadList` (packages/health-core/src/upload-list.ts) and `uploadView` (upload-view.ts).
Stories: US-13 AC5, AC10, AC12, AC21, AC24, AC26; US-02 AC4, AC7; US-12; US-14 AC11-13.

## The one rule

The screen draws what the engine exposes and adds no rule. It never decides whether a row saves, is in
error, blocks Save or takes typing, nor which caption, reason or heading shows. It never parses a
number and never counts. It owns one thing: the draft of the focused text input.

## Layout, top to bottom

1. Summary: `view.summary`, then `view.alreadySaved` and `view.refused` when set.
2. Progress while files are read: `view.progress.line`, `view.progress.zip`, and Stop (`view.stop.label`).
3. Day controls: one per `list.days` entry, in its order, before any row (the iPhone puts its day
   sections first too). Each shows `label`, a dated column's `printedLine`, `fileName`, and the grid's
   own picker (DraftDateCell.tsx). With no day the picker starts empty and shows `hint`, never a day
   that reads as picked. A full date commits on change; '' is ignored.
4. `list.check` as the heading, `list.checkNote` under it, when set.
5. The rows: one `<ul>` holding every `list.rows` row, keyed by `row.key`, in engine order. Rows with
   `attention` show; the rest carry `hidden` while "Show all" is closed, so the rows with attention come
   first. Open, every row stands in engine order: AC26 says a row never moves, so the screen never
   re-sorts by `attention`, which changes as the person types.
6. "Show all n" / "Hide": `list.showAll` / `list.hide`, drawn while `list.showAll` is set or the list
   is open. View state (a plain toggle, exempt from the mode rule).
7. Letters: `view.documents.line`, then each letter's title (text input), kind (`kinds` as a select)
   and date (DraftDateCell, `setDate` as its hint while it has none, `removeDate` as a link), as the
   iPhone draws them. Changes go out as `{document: DocumentFix}`; the title commits through the draft.
8. Files: `view.files.row`, each file's name and status, `view.notices`, and Try again (`view.sections`
   kind `failed`, `retry`).
9. The Save bar, sticky: one `role="status"` line with `view.save.why` and `view.save.error`, then Save
   (`view.save.label`) and Cancel.
10. The done screen replaces 1-9: ✓, `view.done.line`, `archived`, `unstored`, each `skipped` and
    `notSaved` line, then Done (`view.doneLabel`).

## A row's parts

| Part | Drawn from | Reuses |
| --- | --- | --- |
| Tick | `row.ticked`; sends `{tick: ref, on}` | native checkbox |
| Label | `row.label` | `.bt-name-label` look |
| Number input | only when `row.input === 'number'`; else `row.shown.text` as text. Value: the draft while it names the row, else `row.typed?.text ?? row.shown.text` | `.bt-input` |
| Unit | `row.shown.unit` | `.bt-cell-unit` look |
| Caption | `row.caption`, unless it is `row.error`'s words; a conflict's `row.held` leads it | `.review-overview-footer` look |
| Reasons | each of `row.reasons`, one line under the caption | `.bt-cell-question` (the grid's note for the extractor's question) |
| Error | `row.error` | `--color-error`, as `.upload-error` |
| Replace | when `row.replaces`; named `row.replaceLabel`, described by the row's label and the held value | `REVIEW_CELL_TEXT.replace` |

The input is a plain `<input type="text" inputMode="decimal">`, not `NumericInputCell`: that cell
validates, waits on ranges, grades and filters keys, all rules the engine owns. Held text must reach
the engine as typed. Every control is disabled while `view.editable` is false.

## The draft (the one state the screen owns)

`type Draft = null | { key: string; text: string }`, changed only by a pure `transition(draft, event)`
(widget-src/src/lib/upload-list-draft.ts) with a table test. A key is a row's (`fileId:ref`) or a
letter's title (`title:<fileId>`). A commit sends `{typed: ref, text, unit: row.shown.cell?.unit ?? null}`
or `{document: {title}}` and drops the draft; the input then shows what the engine returned. Focus or
typing moving to another input commits the old draft first. Escape drops it unsent. A draft whose input
is gone is dropped. Save press: commit, re-read the view (`reread()`), save if `save.enabled`, else
focus the control of `save.blockers[0].at`.

## Keyboard and screen reader

- Focus order is DOM order: day pickers, each visible row (tick, input, Replace), Show all, letters,
  files, Save, Cancel. Enter commits and keeps focus; Escape drops the draft, and stops the key only
  then, so a later mount's Escape-to-close still works.
- Refused Save: focus goes to the blocker's control (`data-at`): a row's input (its tick when it takes
  none) or a day's picker button. A blocker row always has `attention`, so it is never hidden.
- Names: tick and input are named `row.label`, the day picker its `label`; the input is described by
  its unit, caption, reasons and error. The engine's fuller names (`ListRow.name`, `DayControl.name`)
  await Brad's yes (docs/decisions-for-brad.md, Open): one constant, `ENGINE_NAMES` in
  widget-src/src/lib/upload-list-names.ts, switches every control to them.

## Phone first

At 375 px a row is tick, label and Replace on one line, then its number and unit, caption, reasons and
error under the label. From 600 px the number sits on the label's line. No horizontal scroll at 375 or
1280 px (checked in WebKit).

## Strings and their sources

| String | Source |
| --- | --- |
| summary, already-in-record count, run refusal | `view.summary`, `view.alreadySaved`, `view.refused` |
| progress, ZIP line, Stop | `view.progress`, `view.stop.label` |
| heading, its note | `list.check`, `list.checkNote` (`IMPORT_REVIEW_TEXT`) |
| row label, caption, reasons, error, Replace name | `row.label`, `row.caption`, `row.reasons`, `row.error`, `row.replaceLabel` |
| Replace | `REVIEW_CELL_TEXT.replace` |
| Show all n / Hide | `list.showAll`, `list.hide` |
| day controls | `label`, `printedLine`, `hint`, `fileName` (`UPLOAD_TEXT`, `DAY_CONTROL_TEXT`) |
| letters | `view.documents` line, title, kinds, `setDate`, `removeDate`; "Document title", "Document date" from ReviewFileSections.tsx |
| files, Try again | `view.files`, `view.notices`, `view.sections` failed `retry` |
| Save, why, error | `view.save.label`, `view.save.why`, `view.save.error` |
| Saving..., Cancel | ReviewTable.tsx |
| done lines, Done | `view.done`, `view.doneLabel` |

## Needs Brad

1. Accessible names (decisions-for-brad.md, Open): his yes flips `ENGINE_NAMES`.
2. A label for a conflict's saved value. No existing words name it on the list; the grid shows it bare
   (ReviewMatrix.tsx `bt-cell-conflict-old`). Its only near words are a context cell's title "Already
   saved at this date". Drawn meanwhile: the saved value leads the caption, so it reads "2.9 mmol/L
   Your record already has a different value for this day. It stays as it is."

## What the engine still does not expose

- A letter's text: `view.documents` has no body, so the list cannot show the letter as the iPhone
  does (`DocumentText`) or as the grid's preview does.

## What a later PR does

Mounts UploadList from UploadModal in place of ReviewTable, runs Save through the shared `uploadSave`,
checks the Shopify build ships UploadList.css, and deletes ReviewTable, ReviewMatrix, review-matrix.ts
and import-review-view.ts.

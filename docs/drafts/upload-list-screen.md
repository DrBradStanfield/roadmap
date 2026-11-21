# The web upload list: the screen (PR 2)

Status: draft for review, 2026-11-22, round four (the engine's units, picker, page words and letter text, PR 1951). Built
unmounted: production keeps drawing ReviewTable's grid.
Engine: `uploadList` (packages/health-core/src/upload-list.ts), `uploadView` (upload-view.ts) and `uploadListPage`
(upload-list-page.ts).
Stories: US-13 AC5, AC10, AC12, AC21, AC24, AC26; US-02 AC4, AC7; US-12; US-14 AC11-13.

## The one rule

The screen draws what the engine exposes and adds no rule. It never decides whether a row saves, is in
error, blocks Save or takes typing, nor which caption, reason or heading shows. It never parses a
number and never counts. It owns one thing: the draft of the focused text input, with the unit it was typed in.
Its view state, by owner ruling: Show all (open from the start while `list.check` is null), and the row holding the
draft or the focus, which is never hidden.

## Layout, top to bottom

1. Summary: `view.summary`, then `view.alreadySaved` and `view.refused` when set.
2. Progress while files are read: `view.progress.line`, `view.progress.zip`, and Stop (`view.stop.label`).
3. `list.check` as the heading, `list.checkNote` under it, when set.
4. The rows under their days: rows grouped by `row.section` (fixed per row), groups in the order of each day's
   first row. Each group opens with its `DayControl`: `label`, a dated column's `printedLine`, `fileName`, a picker
   showing `picker` (one named button, the native date input beside it, never nested), and `hint` beside it.
   A row never moves group, so a status change never remounts it (K3e). Rows with `attention` show; the rest carry
   `hidden` while "Show all" is closed. Open, rows stand in engine order: AC26 says a row never moves.
5. "Show all n" / "Hide" (`list.showAll` / `list.hide`) as the list's last row, at the label indent.
6. Letters: `view.documents.line`, then each letter's title (text input), kind (`kinds` as a select)
   and date (the list's picker, `setDate` while it has none, `removeDate` as a link), and its text (`page.letters`) as
   plain text in the grid's preview box, as the iPhone draws them. Changes go out as `{document: DocumentFix}`; the title commits through the draft.
7. Not saved: `view.sections` kind `notSaved` (title, lines, footer), as the iPhone draws it.
8. Files: `view.files.row`, each file's name and status, `view.notices`, and Try again (`view.sections`
   kind `failed`, `retry`); quiet (13px, secondary) while every file says the same.
9. The Save bar, sticky: one `role="status"` line with `view.save.why` and `view.save.error`, then Save
   (`page.save`) and the close button (`page.close`). Save is never hidden; with nothing to save it is refused and
   its line says `view.save.why` ("Nothing new to save").
10. The done screen replaces 1-9: ✓, `view.done.line`, `archived`, `unstored`, each `skipped` and
    `notSaved` line, then Done (`view.doneLabel`).

## A row's parts

| Part | Drawn from | Reuses |
| --- | --- | --- |
| Tick and label | one `<label>`, 44px; `row.ticked`; sends `{tick: ref, on}` | native checkbox, brand accent |
| Number input | only when `row.input === 'number'`; else `row.shown.text` as text. Value: the draft while it names the row, else `row.typed?.text ?? row.shown.text` | `.bt-input` |
| Unit | `row.unit.label`; a chip when `row.unit.toggle` (a press asks for that unit); Lp(a)'s three when `row.unit.choices`, `current` marked; neither while the row holds text | UnitChip.tsx, LpaUnitControl.tsx |
| Caption | `row.caption`, unless it is `row.error`'s words; a conflict's `row.held` leads it, muted, a separate word | `.review-overview-footer` look |
| Replace | its own line under the caption, 44px; named `row.replaceLabel`, described by the row's label and the held value | `REVIEW_CELL_TEXT.replace` |
| Reasons | each of `row.reasons`; the input then takes the warning underline | `.bt-cell-question`, `.bt-cell-low-confidence` |
| Error | `row.error`, `role="alert"` | `--color-error`, as `.upload-error` |

The input is a plain `<input type="text" inputMode="decimal">`, not `NumericInputCell`: that cell
validates, waits on ranges, grades and filters keys, all rules the engine owns. Held text must reach
the engine as typed. Paste and drop share NumericInputCell's interception (`insertedText`): the text goes in place
of the selection, line breaks as visible spaces, so "1\n2" never joins into 12 (US-02 AC4). Every control is disabled while `view.editable` is false.

## The draft (the one state the screen owns)

`type Draft = null | { key: string; text: string }`, changed only by a pure `transition(draft, event)`
(widget-src/src/lib/upload-list-draft.ts) with a table test. A key is a row's (`fileId:ref`) or a
letter's title (`title:<fileId>`). A draft keeps `row.unit.typeIn` from its first keystroke; a commit sends
`{typed: ref, text, unit}`
or `{document: {title}}` and drops the draft; the input then shows what the engine returned. Focus or
typing moving to another input commits the old draft first. Enter while an input method composes does nothing. Escape drops it unsent. A draft whose input
is gone is dropped. Save press: commit, re-read the view (`reread()`), save if `save.enabled`, else
focus the control of `save.blockers[0].at`.

## Keyboard and screen reader

- Focus order is DOM order: each day's picker then its visible rows (tick, input, Replace), Show all, letters,
  files, Save, Cancel. Enter commits and keeps focus; Escape drops the draft, and stops the key only
  then, so a later mount's Escape-to-close still works.
- Refused Save: focus goes to the blocker's control (`data-at`): a row's input (its tick when it takes
  none) or a day's picker button, named by its label and described by its hint and file. A blocker row always
  has `attention`, so it is never hidden.
- Names: tick and input are named `row.label`, the day picker its `label`; the input is described by
  its unit, caption, reasons and error. The engine's fuller names (`ListRow.name`, `DayControl.name`)
  await Brad's yes (docs/decisions-for-brad.md, Open): one constant, `ENGINE_NAMES` in
  widget-src/src/lib/upload-list-names.ts, switches every control to them. A letter's title is labelled by its
  visible "Document title" and its file name; its kind select by its file name alone (no word for it yet).

## Phone first

At 375 px a row is tick and label, then its number and unit, caption, Replace, reasons and error at the
label's indent. From 600 px fixed tracks (tick, label 16em, value 12em) put every number on one edge beside
its name, and the reasons start at the value. No horizontal scroll at 375 or 1280 px (checked in WebKit).
The widget has no dark theme, so dark mode draws as light.

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
| Save, Saving..., Cancel, Close | `page.save`, `page.close` (`UPLOAD_TEXT`) |
| not saved | `view.sections` notSaved title, lines, footer |
| letters' labels | "Document title", "Date:" (ReviewFileSections.tsx) |
| done lines, Done | `view.done`, `view.doneLabel` |

## Needs Brad

1. Accessible names (decisions-for-brad.md, Open): his yes flips `ENGINE_NAMES`.
2. A label for a conflict's saved value. No existing words name it on the list; the grid shows it bare
   (ReviewMatrix.tsx `bt-cell-conflict-old`). Its only near words are a context cell's title "Already
   saved at this date". Drawn meanwhile: the saved value leads the caption, so it reads "2.9 mmol/L
   Your record already has a different value for this day. It stays as it is."
3. A word for a letter's kind select ("Type"). Drawn meanwhile with no visible label; named by its file.

## What the engine still does not expose

- A letter's file name: the screen looks it up in `view.files` by file id.

## Units, for the mount PR

A unit press calls `unitTo(metric, unit)` or `lpaUnitTo(unit)`. The mount wires them to the web's setters
(hooks/useUnits.ts `handleToggleFieldUnit(METRIC_TO_FIELD[metric])`, which turns to the other unit as the
engine's `toggle` names; lib/lpa-unit.ts `useLpaUnit`'s setter), and the engine reads them back through `unitOf`.

## What a later PR does

Mounts UploadList from UploadModal in place of ReviewTable, wires the unit presses, runs Save through the shared `uploadSave`,
checks the Shopify build ships UploadList.css, and deletes ReviewTable, ReviewMatrix, review-matrix.ts
and import-review-view.ts.

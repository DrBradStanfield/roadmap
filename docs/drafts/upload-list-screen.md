# The web upload list: the screen (PR 2)

Status: draft for review, 2026-11-22, round seven (the final re-check's T1-T6). Built
unmounted: production keeps drawing ReviewTable's grid.
Engine: `uploadList` (packages/health-core/src/upload-list.ts), `uploadView` (upload-view.ts) and `uploadListPage`
(upload-list-page.ts).
Stories: US-13 AC5, AC10, AC12, AC21, AC24, AC26; US-02 AC4, AC7; US-12; US-14 AC11-13.

## The one rule

The screen draws what the engine exposes and adds no rule. It never decides whether a row saves, is in
error, blocks Save or takes typing, nor which caption, reason or heading shows. It never parses a
number and never counts. It owns one thing: the draft of the focused text input, with the unit it was typed in and that unit's label.
Its view state, by owner ruling: Show all, a latch; the row holding the focus; and the list's last announcement.
Show all's latch is set once, when the review first has rows (open while `list.check` is null, else closed); after
that only its press changes it. Rows with `attention`, the draft's row and the focused row always show; so does every
row shown since Show all was last pressed, so no row hides under the person's hand (K3i).

## Layout, top to bottom

1. Summary: `view.summary`, then `view.alreadySaved` and `view.refused` when set.
2. Progress while files are read: `view.progress.line`, `view.progress.zip`, and Stop (`view.stop.label`).
3. `list.check` as the heading, `list.checkNote` under it, when set.
4. The rows under their days: rows grouped by `row.section` (fixed per row), groups in the order of each day's
   first row. Each group opens with its `DayControl`: `label`, a dated column's `printedLine`, `fileName`, a picker
   showing `pickerLine` (one named button, the native date input beside it, never nested), and `hint` beside it.
   A row never moves group, so a status change never remounts it (K3e). Rows with `attention` show; the rest carry
   `hidden` while "Show all" is closed (the latch above). Open, rows stand in engine order: AC26 says a row never moves.
   `.upload-list-row[hidden]` sets `display: none` itself: the modal draws through a portal on body, outside
   `.health-tool [hidden]`, and the row's `display: grid` would otherwise win (checked in WebKit).
5. "Show all n" / "Hide" (`list.showAll` / `list.hide`) as the list's last row, at the label indent.
6. Letters: `view.documents.line`, then each letter's title (text input), kind (`kinds` as a select)
   and date (the list's picker showing `page.letters[].pickerLine`, `removeDate` as a link), and its preview
   (`page.letters[].preview`, the grid's 300-character cut) as plain text in the grid's preview box, as the iPhone draws them. Changes go out as `{document: DocumentFix}`; the title commits through the draft.
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
| Unit | `row.unit.label`; a chip when `row.unit.toggle` (a press commits any open draft, then asks for that unit); Lp(a)'s three when `row.unit.choices`, `current` marked; neither while the row holds text. While a draft is open on the row: the label captured at its first keystroke, and no control | UnitChip.tsx, LpaUnitControl.tsx |
| Printed | `row.printed` under the value, in the grid's `.bt-cell-printed` note style; it describes the input (US-13 AC11) | `.bt-cell-printed` |
| Caption | `row.caption`, unless it is `row.error`'s words; a conflict's `row.held` leads it, muted, a separate word | `.review-overview-footer` look |
| Replace | its own line under the caption, 44px; named `row.replaceLabel`, described by the row's label, the held value and a hidden text of the value it would write, `row.shown.text` and `row.unit.label` exactly; none while the row holds text or a draft (that text is no value Replace could write) | `REVIEW_CELL_TEXT.replace` |
| Reasons | each of `row.reasons`; the input then takes the warning underline | `.bt-cell-question`, `.bt-cell-low-confidence` |
| Error | `row.error`, as text; announced by the list, not the row (below) | `--color-error`, as `.upload-error` |

The input is a plain `<input type="text" inputMode="decimal">`, not `NumericInputCell`: that cell
validates, waits on ranges, grades and filters keys, all rules the engine owns. Held text must reach
the engine as typed. Paste and drop share NumericInputCell's interception (`insertedText`): the text goes in place
of the selection, line breaks as visible spaces, so "1\n2" never joins into 12 (US-02 AC4). Every control is disabled while `view.editable` is false.

## The draft (the one state the screen owns)

`type Draft = null | { key: string; text: string; unit: CellUnit | null; unitLabel: string | null }`, changed only by
a pure `transition(draft, event)` (widget-src/src/lib/upload-list-draft.ts) with a table test. A key is a row's
(`fileId:ref`) or a letter's title (`title:<fileId>`). A draft keeps `row.unit.typeIn` and `row.unit.label` from its
first keystroke; the label is drawn beside the input while the draft is open, so it never names a unit the commit does
not write (Codex R1). A commit sends `{typed: ref, text, unit}` or `{document: {title}}` and drops the draft; the input
then shows what the engine returned. Focus or typing moving to another input commits the old draft first, and so does
a unit press (iOS Safari may not blur on a tap of a control that takes no focus). Enter while an input method composes
does nothing. Escape drops it unsent. A draft whose input is gone is dropped.

Save press: commit, then read the view (`reread()`), save if `save.enabled`, else focus the control of
`save.blockers[0].at`. The host's contract (on `UploadListProps.reread`): `choose` applies a choice before it returns,
and `reread()` returns the view of the state after every `choose` already called, read from the flow's live state,
never React state. useUploadFlow's `send` (hooks/useUploadFlow.ts, the port's `send`) sets `live.current` to the
transition's state before it returns. A commit by blur or Enter has therefore landed before any press, and a second
press reads the first's save. The round-five ruling that allowed an awaited, promise-returning `choose` is withdrawn
(round seven, T1): the promise path was a hidden mode, did not await a commit made by blur or Enter, and let a second
press read the view from before the commit. `choose` returns `void`, so restoring it fails the typecheck.

## Keyboard and screen reader

- Focus order is DOM order: each day's picker then its visible rows (tick, input, Replace), Show all, letters,
  files, Save, Cancel. Enter commits and keeps focus; Escape drops the draft, and stops the key only
  then, so a later mount's Escape-to-close still works.
- Refused Save: focus goes to the blocker's control (`data-at`): a row's input (its tick when it takes
  none) or a day's picker button, named by its label and described by its hint and file. A blocker row always
  has `attention`, so it is never hidden.
- Names: tick and input are named `row.label`, the day picker its `label`; the input is described by
  its unit (Lp(a)'s: the one unit shown, never all three), caption, reasons and error. The picker's name replaces its
  content, so the day it shows is its description, before its hint and file.
- Errors: no row is an alert. The list owns one `aria-live="polite"` region (a check after a blur never cuts off the
  next field's name) and says in it each error text a person's choice made, keyed on row and text: a row's new error,
  or a new text on a row that had one (held "abc", then "1,234" asks which number, US-13 AC12). A review that opens with
  errors, a unit press, a choice the engine refuses and an engine step say nothing.
- Day picker by keyboard (WebKit 26.4, Safari semantics): Tab reaches text fields only, Option+Tab (or Safari's "Press
  Tab to highlight each item") the button; Enter and Space call `showPicker()`, focus stays on the button. Without
  `showPicker` (Safari before 16) the press clicks the input instead. Not verified: choosing a day inside the native
  popover by keyboard, and VoiceOver (neither can be scripted). Owner ruling: keep the button and its click fallback.
- The engine's fuller names (`ListRow.name`, `DayControl.name`) await Brad's yes (docs/decisions-for-brad.md, Open): one constant, `ENGINE_NAMES` in
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
| day controls | `label`, `printedLine`, `pickerLine`, `hint`, `fileName` (`UPLOAD_TEXT`, `DAY_CONTROL_TEXT`) |
| printed note | `row.printed` |
| letters | `view.documents` line, title, kinds, `removeDate`; `page.letters[].pickerLine`, `preview`; "Document title", "Document date" from ReviewFileSections.tsx |
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

## For the mount PR

- The adapter calls the flow's synchronous `send` for `choose` and reads `live.current` (never React state) for
  `reread`. A test through the real `useUploadFlow` types a correction, presses Save without a blur, and finds the
  correction in what was saved.
- Unit presses must SET the unit the chip names. `unitTo(metric, unit)` and `lpaUnitTo(unit)` carry it; the web's
  `handleToggleFieldUnit(METRIC_TO_FIELD[metric])` (hooks/useUnits.ts) only flips, which can disagree with the chip
  while the record's units are held (US-34 AC7a). Wire a setter, or assert the flip lands on `unit`. Lp(a): lib/lpa-unit.ts
  `useLpaUnit`'s setter. The engine reads both back through `unitOf`.
- The modal's portal sits outside `.health-tool`: `[hidden]` (handled in UploadList.css), the `--bt-ink-*` tokens the
  unit controls and the grid's notes read (UploadList.css carries five: 50, 200, 500, 700, 900), and the font (`.health-tool` sets it; the grid's unit pill sets
  its own) are not inherited there. The harness gives its portal root `font-family: var(--font-family-base)`; the mount
  must give the modal (or the list) the same. Check each in the live store.
- Scope the `--bt-ink-*` tokens once on the modal root, or pin the three copies (styles.css `.health-tool`,
  `.bt-timeline`, UploadList.css `.upload-list`) equal by a test (R7).
- Reconcile the engine's "Show all n" count with the rows the screen keeps shown after a press (R5a).
- The Files block's quiet styling (13px, secondary while every file says the same) is a screen decision (R5b).
- K3 copies the DayControl-to-change mapping (`test` / `previous` / `columnDay`) rather than deriving it (R5c).
- Untested at mount: paste and line breaks in a letter title; the live region once `view.done` ends the list; the CSS
  under the real modal portal; Clarity masking of the hidden proposed-value span; VoiceOver and keyboard date picking
  in real Safari, on a Mac and an iPhone (the native popover could not be scripted).
- `ENGINE_NAMES` awaits Brad (Needs Brad 1).
- UploadList.css must ship in the Shopify build: check the built CSS holds `.upload-list-row[hidden]`.

## What a later PR does

Mounts UploadList from UploadModal in place of ReviewTable, wires the unit presses, runs Save through the shared `uploadSave`,
does the list above, and deletes ReviewTable.tsx, ReviewMatrix.tsx, lib/review-matrix.ts and import-review-view.ts,
with whatever only they import.

// Test support: the K3 property's harness and properties, run by components/UploadList.k3.part*.test.tsx, 40 seeds each.
/**
 * K3, the web upload list's screen property (US-13 AC26, web list PR 2; seeded, mulberry32, no dependency). Each run
 * interleaves a person's DOM steps (focus, type, blur, Enter, Escape, tick, Replace, a day, Show all, a letter's title,
 * kind and date, a Save press with and without focus on Save) with the engine's (a file's read landing before another's
 * rows, another writer changing the record, a Save answering) and unit presses (a row's chip, Lp(a)'s choices, the whole system). The pick holds
 * a row whose input takes none and rows with reasons. After every step:
 *   K3a the draft is none, or names a row whose input takes typing or a letter's title, and it is the one the person's
 *       steps left; each letter's title input shows its draft, else the engine's title;
 *   K3b the screen sent the engine exactly what the person's steps say (a press on a tick or Replace is pointerdown, the
 *       blur's commit, then the click, and acts on the box as drawn before the press, T8) (a cleared letter date is `{date: null}`; a cleared
 *       lab day sends nothing, as the grid), worked out by the engine's own `transition` from
 *       the state before the step (a commit is `{typed: ref, text, unit}`, the unit on screen when the person started
 *       typing, read by this test from the screen then, never from the component; a Save press with a draft is commit, re-read,
 *       then Save if the view allows it, else the focus on the first blocker's control);
 *   K3c the last text typed at a row and not cancelled is the draft's, or the engine holds it (held text, or the edit
 *       `typedCommit` makes of it), until the person changes that row again;
 *   K3d the DOM's inputs are the engine's rows: one text input per row with `input: 'number'`, none otherwise, showing
 *       the draft while it names the row, else the held text, else the shown number; each row sits under its own day;
 *       a row with `printed` shows it, one without shows no note; each picker button shows exactly its `pickerLine`;
 *   K3e no row's node, nor its input, is ever replaced while its row stands (status changes and rows landing before it);
 *   K3f the row being typed in, or holding the focus, is never hidden;
 *   K3g held text keeps the unit label it was typed under, whatever unit chip or Lp(a) choice was pressed since;
 *   K3h the unit label beside an open draft is the one on screen at its first keystroke, whatever was pressed since (S1);
 *       a unit press with a draft open commits it first, with no blur (S2, checked by K3b);
 *   K3i no row that was visible becomes hidden on a step that is not a press of Show all, and Show all's state changes
 *       only on its press (S4: a latch); it starts closed and stays closed until that press (T11);
 *   K3j the list's announcement changes only on a person's step where a row has an error text it did not have (from the
 *       engine's rows), never on an engine step; a step of one choice says each such text; no row is an alert (S7, T2, T3).
 * Mutations it was shown failing on (PR body): M1 commit skipped on focus moving to another row; M2 the input's value
 * read from a stale local copy; M3 day groups keyed by index; M4 a letter's title draft never sent; M5 the draft's unit
 * re-read from the row at commit; M6 a row hidden whatever its draft or focus; M7 held text labelled by the row's unit now;
 * M8 an open draft labelled by the row's unit now; M9 Show all a live expression of `list.check`; M10 a unit press that
 * leaves the draft to a blur; M11 every current error announced on each change; M12 a day picker's words made by the
 * screen; M13 the printed note dropped; M14 announcements keyed on the row alone; M15 `acted` kept after a choice that
 * changed nothing; M16 a cleared letter date dropped; M17 a tick or Replace press that sends the box's state after the
 * blur's commit, not as drawn when pressed (the code before T8); M18 Show all opening by itself when nothing needs
 * checking (the withdrawn ruling); M19 a press's claim kept after a cancelled press (the code before T12). (The promise path of Save, restored, fails the typecheck: `choose` returns void.) Synthetic values only.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { typedCommit } from '@roadmap/health-core/cell-input';
import { core, DAY, EMPTY, extra, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { valueAt } from '@roadmap/health-core/import-review';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { bulkAppendValues, type BulkRow } from '@roadmap/health-core/record-edits';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import { NO_CHOICES, type ChoiceChange } from '@roadmap/health-core/upload-choices';
import { transition, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import type { DayControl, ListRow } from '@roadmap/health-core/upload-list';
import { lostReplaces, reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { engineSee, UploadListHost, type ListHost } from './upload-list-host';
import { controlAt } from '../components/UploadList';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Open = Extract<UploadState, { phase: 'open' }>;
type File = Open['files'][number];
const COLUMN = '2026-09-15';
const X0: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: DAY, unrecognized: [], document: null,
  // Lp(a) out of range: f0 lands with an error, an engine step that must say nothing (T3).
  values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', question: 'Is this HbA1c?', unitGuessed: true }), core({ metric: 'lpa', valueSI: 9000, displayValue: 9000, displayUnit: 'nmol/L' })], additionalValues: [extra()],
};
const X1: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: null, unrecognized: [], document: null,
  values: [core({ valueSI: 500, displayValue: 500 }), core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' }), core({ valueSI: 3.4, displayValue: 3.4, recordedAt: COLUMN }), core({ metric: 'lpa', valueSI: 900, displayValue: 900, displayUnit: 'nmol/L' })],
  additionalValues: [extra({ name: 'Vitamin B12', value: 300, unit: 'pmol/L' })],
};
/** X1 with nothing to check, so a run can start with Show all open (K3i). */
const X1_CLEAN: UnifiedExtractionResult = {
  ...X1, values: [core({ valueSI: 3.0, displayValue: 3.0 }), core({ valueSI: 3.4, displayValue: 3.4, recordedAt: COLUMN }), core({ metric: 'lpa', valueSI: 90, displayValue: 90, displayUnit: 'nmol/L' })],
};
const LETTER: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Clinic letter', documentDate: '2026-10-20', contentMarkdown: 'Plan', metadata: {} },
};
const file = (id: string, status: File['status']): File => ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status });
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });
const RECORDS: RoadmapFile[] = [EMPTY, ...[[LDL(3.1)], [LDL(2.0)], [LDL(2.0, COLUMN)], [LDL(2.0), LDL(2.5, COLUMN)]].map((rows) => bulkAppendValues(EMPTY, rows, NOW).file)];
const TEXTS = ['3.4', 'abc', '', '1,234', '12.9', '500', '2', '3..5', '0.5'];
const DAYS = ['2026-10-20', '2026-09-01', '2026-12-01', ''];
const TITLES = ['Cardiology letter', '', 'Clinic letter'];
const KINDS = ['clinic_letter', 'scan_result', 'other'];

/** The person's model of the draft: the text typed into the focused input and not yet committed or cancelled. */
/** `unit`: the unit on screen when the person started typing it (Codex R2), read from what the screen showed then. */
type Draft = { key: string; text: string; unit: CellUnit | null; label: string | null } | null;
/** `label`: for held text, the unit label on screen when it was typed, which it keeps (K3g). */
type Held = { key: string; text: string; expect: 'hold' | 'edit' | 'none'; value?: number; label?: string | null };

const rowEl = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`);
const textInput = (li: Element | null) => li?.querySelector<HTMLInputElement>('input[type="text"]') ?? null;
/** A row's unit as drawn: its label, its chip's label, or the one of Lp(a)'s three marked. */
const unitLabel = (key: string) => {
  const line = rowEl(key)?.querySelector('.upload-list-unit');
  return line?.querySelector('[aria-checked="true"]')?.textContent ?? line?.textContent ?? null;
};
const docEl = (fileId: string) => document.querySelector<HTMLLIElement>(`li[data-doc="${fileId}"]`);
/** The text input a draft key names: a row's number, or a letter's title (`title:<fileId>`). */
const inputOf = (key: string) => (key.startsWith('title:') ? textInput(docEl(key.slice(6))) : textInput(rowEl(key)));
const rowOfInput = (el: Element | null) => {
  if (!(el instanceof HTMLInputElement) || el.type !== 'text') return null;
  const doc = el.closest<HTMLLIElement>('li[data-doc]')?.dataset.doc;
  return doc ? `title:${doc}` : el.closest<HTMLLIElement>('li[data-key]')?.dataset.key ?? null;
};

export function runSequence(seed: number, steps: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const f0: File = rand() < 0.6 ? file('f0', { s: 'sending', attempt: 1 }) : file('f0', { s: 'read', extraction: X0, choices: NO_CHOICES });
  const initial: Open = { phase: 'open', platform: 'web', run: 1, files: [f0, file('f1', { s: 'read', extraction: rand() < 0.35 ? X1_CLEAN : X1, choices: NO_CHOICES }), file('f2', { s: 'read', extraction: LETTER, choices: NO_CHOICES })], started: NOW, firstRead: NOW };
  const record0 = pick(RECORDS);
  const host = { current: null as ListHost | null };
  render(<UploadListHost initial={initial} record={record0} now={NOW} host={host} />);
  const h = host.current!;
  const trace: string[] = [];
  let everPressed = false;
  let draft = null as Draft;
  let held = null as Held | null;
  const nodes = new Map<string, { li: Element; input: HTMLInputElement | null }>();
  const fail = (prop: string, msg: string) => { throw new Error(`${prop} seed ${seed}: ${msg}\n  steps: ${trace.join(' > ')}`); };

  const see = (s: UploadState, record: RoadmapFile) => engineSee(s, record, NOW, h.units());
  /** K3j: the rows with an error before a step, and each error a row newly had during it (a commit, then a tick, say). */
  // From the engine's rows alone, never the screen: an error text a row did not have just before each choice (T2).
  let hadError = new Map<string, string | null>();
  const madeErrors = new Set<string>();
  // Each takes rows the step already read from the engine: K3 stays inside CI's 60 s budget.
  const errorsOf = (rows: ListRow[]) => new Map(rows.map((x) => [x.key, x.error]));
  const newErrorsIn = (now: Map<string, string | null>, since: Map<string, string | null>) => [...now].filter(([k, e]) => e && since.get(k) !== e).map(([, e]) => e!);
  const noteErrors = (now: Map<string, string | null>) => {
    for (const e of newErrorsIn(now, hadError)) madeErrors.add(e);
    hadError = now;
  };
  /** The state after a commit of `d`, by the engine's own transition. */
  const committed = (s: UploadState, record: RoadmapFile, d: Draft): UploadState => {
    if (!d) return s;
    if (d.key.startsWith('title:')) return transition(s, { type: 'chose', id: d.key.slice(6), change: { document: { title: d.text } }, now: NOW }).state;
    const row = see(s, record).list.rows.find((r) => r.key === d.key);
    if (!row) return s;
    const change: ChoiceChange = { typed: row.ref, text: d.text, unit: d.unit };
    const after = transition(s, { type: 'chose', id: row.fileId, change, now: NOW }).state;
    if (after !== s) held = heldOf(s, row, d.text, d.unit, d.label);
    noteErrors(errorsOf(see(after, record).list.rows));
    return after;
  };
  /** What the engine must hold for text committed at `row` (K3c), from `typedCommit` on the choices before. */
  const heldOf = (s: UploadState, row: ListRow, text: string, unit: CellUnit | null, label: string | null): Held | null => {
    const f = 'files' in s ? s.files.find((x) => x.id === row.fileId) : undefined;
    if (f?.status.s !== 'read') return null;
    const at = valueAt(f.status.extraction, row.ref)!;
    if (!text.trim()) return { key: row.key, text, expect: 'none' };
    const c = typedCommit(text, at, f.status.choices.edits[row.ref], unit);
    if (!c) return null;
    return c.kind === 'hold' ? { key: row.key, text, expect: 'hold', label } : c.kind === 'edit' ? { key: row.key, text, expect: 'edit', value: c.value } : { key: row.key, text, expect: 'none' };
  };
  /** A Save press: any draft committed, then Save if the view allows it (K3b). */
  const pressed = (s: UploadState, record: RoadmapFile, d: Draft): { state: UploadState; focus: string | null } => {
    const after = committed(s, record, d);
    const { view, review } = see(after, record);
    if (view.save.enabled) return { state: transition(after, { type: 'saveStarted', reviewed: reviewedWrites(review) }).state, focus: null };
    return { state: after, focus: view.save.blockers[0]?.at ?? null };
  };

  const visible = (rows: ListRow[], test: (r: ListRow) => boolean) => rows.filter((r) => test(r) && rowEl(r.key) && !rowEl(r.key)!.hidden);
  const focusMoves = (el: HTMLElement) => {
    // Any focus off the draft's input commits it (blur).
    const leaving = draft !== null && el !== inputOf(draft.key);
    act(() => el.focus());
    return leaving;
  };

  for (let step = 0; step < steps; step++) {
    const before = h.state();
    // The done screen draws no list: a run that saved has nothing more to step through.
    if (before.phase === 'done') break;
    const record = h.record();
    const { list } = see(before, record);
    const rows = list.rows;
    let expected: UploadState = before;
    let focusAt: string | null | undefined;
    const active = document.activeElement as HTMLElement | null;
    const activeRow = rowOfInput(active);
    const wasShown = new Set([...document.querySelectorAll<HTMLElement>('li[data-key]')].filter((li) => !li.hidden).map((li) => li.dataset.key!));
    const wasOpen = document.querySelector('.review-disclosure')?.getAttribute('aria-expanded') ?? null;
    hadError = errorsOf(rows);
    const stepStart = hadError;
    madeErrors.clear();
    let engineStep = false;
    const sentBefore = h.sent.length;
    const pressesBefore = h.presses.length;
    const wasSaid = document.querySelector('.upload-list [aria-live]')?.textContent ?? null;
    let toggled = false;
    const r = rand();
    if (r < 0.2) {
      const titles = see(before, record).view.documents?.rows.map((d) => `title:${d.fileId}`) ?? [];
      const target = [...visible(rows, (x) => x.input === 'number').map((x) => x.key), ...titles].filter((k) => !inputOf(k)!.disabled);
      if (!target.length) continue;
      const k = pick(target);
      trace.push(`focus ${k}`);
      if (focusMoves(inputOf(k)!)) { expected = committed(before, record, draft); draft = null; }
    } else if (r < 0.38) {
      if (!activeRow || (active as HTMLInputElement).disabled) continue;
      const text = pick(activeRow.startsWith('title:') ? TITLES : TEXTS);
      trace.push(`type "${text}"`);
      if ((active as HTMLInputElement).value !== text) {
        // The unit the row is typed in as the person starts typing (the engine's `unit.typeIn`, drawn as its label).
        const onScreen = activeRow.startsWith('title:') ? null : see(before, record).list.rows.find((x) => x.key === activeRow)!.unit.typeIn;
        fireEvent.change(active!, { target: { value: text } });
        const label = activeRow.startsWith('title:') ? null : unitLabel(activeRow);
        draft = draft?.key === activeRow ? { ...draft, text } : { key: activeRow, text, unit: onScreen, label };
        if (held?.key === activeRow) held = null;
      }
    } else if (r < 0.44) {
      if (!activeRow) continue;
      trace.push('Enter');
      fireEvent.keyDown(active!, { key: 'Enter' });
      expected = committed(before, record, draft);
      draft = null;
    } else if (r < 0.48) {
      if (!activeRow) continue;
      trace.push('Escape');
      fireEvent.keyDown(active!, { key: 'Escape' });
      draft = null;
    } else if (r < 0.53) {
      if (!active || active === document.body) continue;
      trace.push('blur');
      if (draft) { expected = committed(before, record, draft); draft = null; }
      act(() => active.blur());
    } else if (r < 0.62) {
      const target = visible(rows, () => true).filter((x) => !rowEl(x.key)!.querySelector<HTMLInputElement>('.upload-list-tick')!.disabled);
      if (!target.length) continue;
      // Half the time, the row holding the draft: its own tick pressed while its input has the focus (T8).
      const own = draft && target.find((x) => x.key === draft!.key);
      const row = own && rand() < 0.5 ? own : pick(target);
      const tick = rowEl(row.key)!.querySelector<HTMLInputElement>('.upload-list-tick')!;
      trace.push(`tick ${row.key}`);
      // A mouse press: pointerdown, the blur it causes (the draft commits), then the click. It acts on the tick as drawn
      // before the press (`row`, the engine's row then), never as the commit left it.
      fireEvent.pointerDown(tick);
      if (focusMoves(tick)) { expected = committed(before, record, draft); draft = null; }
      fireEvent.click(tick);
      expected = transition(expected, { type: 'chose', id: row.fileId, change: { tick: row.ref, on: !row.ticked }, now: NOW }).state;
      if (held?.key === row.key) held = null;
    } else if (r < 0.67) {
      const target = visible(rows, (x) => x.replaces !== null).filter((x) => !rowEl(x.key)!.querySelector<HTMLInputElement>('.upload-list-replace input')!.disabled);
      if (!target.length) continue;
      const row = pick(target);
      const box = rowEl(row.key)!.querySelector<HTMLInputElement>('.upload-list-replace input')!;
      trace.push(`replace ${row.key}`);
      fireEvent.pointerDown(box);
      if (focusMoves(box)) { expected = committed(before, record, draft); draft = null; }
      const rowMid = see(expected, record).list.rows.find((x) => x.key === row.key)!;
      fireEvent.click(box);
      // As drawn before the press (T8): on unless it showed on.
      if (rowMid.replaces !== null) expected = transition(expected, { type: 'chose', id: row.fileId, change: { replace: row.ref, correctsId: row.replacing ? null : rowMid.replaces }, now: NOW }).state;
      if (held?.key === row.key) held = null;
    } else if (r < 0.74) {
      const days = list.days.filter((d) => !document.querySelector<HTMLInputElement>(`[data-at="${d.key}"] input`)!.disabled);
      if (!days.length) continue;
      const d: DayControl = pick(days);
      const el = document.querySelector<HTMLInputElement>(`[data-at="${d.key}"] input`)!;
      const day = pick(DAYS);
      trace.push(`day ${d.key} "${day}"`);
      if (focusMoves(controlAt(document, d.key)!)) { expected = committed(before, record, draft); draft = null; }
      if (el.value !== day) {
        fireEvent.change(el, { target: { value: day } });
        const change: ChoiceChange = d.source === 'test' ? { testDay: day } : d.source === 'previous' ? { previousDay: day } : { columnDay: d.printed, day };
        if (day) expected = transition(expected, { type: 'chose', id: d.fileId, change, now: NOW }).state;
      }
    } else if (r < 0.77) {
      const button = document.querySelector<HTMLButtonElement>('.review-disclosure');
      if (!button) continue;
      trace.push('show all');
      if (focusMoves(button)) { expected = committed(before, record, draft); draft = null; }
      fireEvent.click(button);
      toggled = true;
      everPressed = true;
    } else if (r < 0.84) {
      const button = document.querySelector<HTMLButtonElement>('.review-save-btn');
      if (!button || button.disabled) continue;
      const focused = rand() < 0.5;
      trace.push(focused ? 'Save' : 'Save, focus kept');
      if (focused && focusMoves(button)) { expected = committed(before, record, draft); draft = null; }
      fireEvent.click(button);
      const press = pressed(expected, record, draft);
      expected = press.state;
      focusAt = press.focus;
      draft = null;
    } else if (r < 0.88) {
      if (before.phase !== 'open' || !before.files.some((f) => f.id === 'f0' && f.status.s === 'sending')) continue;
      trace.push('f0 read');
      engineStep = true;
      const e: UploadEvent = { type: 'answered', run: 1, id: 'f0', extraction: X0, legacy: false, now: NOW };
      act(() => h.send(e));
      expected = transition(before, e).state;
    } else if (r < 0.91) {
      const doc = docEl('f2');
      if (!doc || before.phase === 'saving') continue;
      const which = rand();
      if (which < 0.4) {
        const select = doc.querySelector('select')!;
        const kind = pick(KINDS);
        trace.push(`kind ${kind}`);
        if (focusMoves(select)) { expected = committed(before, record, draft); draft = null; }
        if (select.value !== kind) {
          fireEvent.change(select, { target: { value: kind } });
          expected = transition(expected, { type: 'chose', id: 'f2', change: { document: { kind } }, now: NOW }).state;
        }
      } else if (which < 0.8) {
        const day = pick(DAYS);
        const date = doc.querySelector<HTMLInputElement>('input[type="date"]')!;
        trace.push(`letter date "${day}"`);
        if (focusMoves(doc.querySelector<HTMLElement>('.upload-list-document-date button')!)) { expected = committed(before, record, draft); draft = null; }
        if (date.value !== day) {
          fireEvent.change(date, { target: { value: day } });
          // A cleared letter date is unknown (US-13 AC6): the same change as "Remove the date" (T7).
          expected = transition(expected, { type: 'chose', id: 'f2', change: { document: { date: day || null } }, now: NOW }).state;
        }
      } else {
        const remove = doc.querySelector<HTMLButtonElement>('.upload-list-remove-date');
        if (!remove) continue;
        trace.push('remove letter date');
        if (focusMoves(remove)) { expected = committed(before, record, draft); draft = null; }
        fireEvent.click(remove);
        expected = transition(expected, { type: 'chose', id: 'f2', change: { document: { date: null } }, now: NOW }).state;
      }
    } else if (r < 0.93) {
      // A unit press: a row's chip, Lp(a)'s choices, or the whole system, typing or not (a press moves the focus first).
      const how = rand();
      const chips = [...document.querySelectorAll<HTMLButtonElement>('li[data-key]:not([hidden]) .upload-list-unit button')];
      if (how < 0.6 && chips.length) {
        const chip = pick(chips);
        // A tap that moves no focus (iOS Safari), or a click that does: either way the draft is sent before the press (S2).
        const tap = rand() < 0.5;
        trace.push(`unit ${chip.closest<HTMLElement>('li')!.dataset.key} ${chip.textContent}${tap ? ', no focus' : ''}`);
        if (!tap && focusMoves(chip)) { expected = committed(before, record, draft); draft = null; }
        // Lp(a)'s marked choice is no press: it changes nothing.
        if (chip.getAttribute('aria-checked') !== 'true') { expected = committed(expected, record, draft); draft = null; }
        fireEvent.click(chip);
      } else {
        const unit: CellUnit = rand() < 0.5 ? 'si' : 'conventional';
        trace.push(`units ${unit}`);
        engineStep = true;
        act(() => h.setUnits(() => unit));
      }
    } else if (r < 0.96) {
      const next = pick(RECORDS);
      trace.push(`record ${RECORDS.indexOf(next)}`);
      engineStep = true;
      act(() => h.setRecord(next));
      const lost = lostReplaces(uploadReview(before, next, NOW), before);
      expected = lost.length ? transition(before, { type: 'replacesLost', lost }).state : before;
    } else {
      if (before.phase !== 'saving') continue;
      const ok = rand() < 0.2;
      trace.push(ok ? 'saved' : 'save failed');
      engineStep = true;
      const e: UploadEvent = ok ? { type: 'saved', run: 1, attempt: before.attempt, outcome: { values: 1, documents: 0, archived: 0 } } : { type: 'saveFailed', run: 1, attempt: before.attempt, message: 'Network' };
      act(() => h.send(e));
      expected = transition(before, e).state;
    }

    // K3b: exactly what the person's steps say reached the engine.
    if (JSON.stringify(h.state()) !== JSON.stringify(expected)) fail('K3b', 'the engine state is not what the steps sent');
    if (focusAt) {
      const want = controlAt(document, focusAt);
      if (document.activeElement !== want) fail('K3b', `a refused Save left the focus off its blocker ${focusAt}`);
    }
    const after = see(h.state(), h.record());
    const live = after.view.done ? [] : after.list.rows;
    if (!live.length) { draft = null; held = null; nodes.clear(); }
    // K3h: the label beside an open draft is the one at its first keystroke.
    if (draft && !draft.key.startsWith('title:') && rowEl(draft.key) && unitLabel(draft.key) !== draft.label) {
      fail('K3h', `${draft.key} was typed under ${draft.label}, its open draft now labelled ${unitLabel(draft.key)}`);
    }
    // K3i: Show all is a latch; nothing shown hides unless it is pressed.
    // K3i: Show all starts closed (T11); until the person presses it, it stays closed.
    const expanded = document.querySelector('.review-disclosure')?.getAttribute('aria-expanded');
    if (!everPressed && expanded === 'true') fail('K3i', `Show all opened before any press, on "${trace[trace.length - 1]}"`);
    if (!toggled) {
      for (const key of wasShown) if (rowEl(key)?.hidden) fail('K3i', `${key} was shown and hid on "${trace[trace.length - 1]}"`);
      const isOpen = document.querySelector('.review-disclosure')?.getAttribute('aria-expanded') ?? null;
      if (wasOpen !== null && isOpen !== null && isOpen !== wasOpen) fail('K3i', `Show all went ${wasOpen} -> ${isOpen} on "${trace[trace.length - 1]}"`);
    }
    // K3j: an announcement only for an error text a row did not have before the person's step; never on an engine step,
    // never a row alert; and a step that sent one choice and no unit press says every error text it made.
    if (document.querySelector('.upload-list [role="alert"]')) fail('K3j', 'a row is an alert');
    const nowSaid = document.querySelector('.upload-list [aria-live]')?.textContent ?? null;
    // The done screen has no list, so no announcement: a Save past a refused row's error now reaches it (US-13 AC27).
    if (engineStep && !after.view.done && nowSaid !== wasSaid) fail('K3j', `announced "${nowSaid}" on the engine's step "${trace[trace.length - 1]}"`);
    const errorsAfter = errorsOf(after.list.rows);
    const made = after.view.done ? [] : newErrorsIn(errorsAfter, stepStart);
    const oneChoice = h.sent.slice(sentBefore).filter((e) => e.type === 'chose').length === 1 && h.presses.length === pressesBefore;
    if (!engineStep && oneChoice && nowSaid !== null) for (const e of made) if (!nowSaid.includes(e)) fail('K3j', `"${e}" appeared on "${trace[trace.length - 1]}" and was not said ("${nowSaid}")`);
    if (!engineStep) noteErrors(errorsAfter);
    // It says only errors a row newly had in this step, and nothing else.
    const rest = [...madeErrors].reduce((t, e) => t.split(e).join(''), nowSaid ?? '');
    if (wasSaid !== null && nowSaid !== null && nowSaid !== wasSaid && (!madeErrors.size || rest.trim())) {
      fail('K3j', `announced "${nowSaid}" with no new error on "${trace[trace.length - 1]}"`);
    }
    // K3a
    const shownDraft = document.querySelector<HTMLElement>('.upload-list')?.dataset.draft ?? null;
    if (shownDraft !== (draft?.key ?? null)) fail('K3a', `the screen's draft is ${shownDraft}, the person's ${draft?.key ?? null}`);
    const letters = (after.view.documents?.rows ?? []).map((d) => `title:${d.fileId}`);
    if (draft && !letters.includes(draft.key) && live.find((x) => x.key === draft!.key)?.input !== 'number') fail('K3a', `the draft names ${draft.key}, which takes no input`);
    // K3f: the row being typed in, or holding the focus, is never hidden (B5).
    const focusedRow = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('li[data-key]');
    if (draft && !letters.includes(draft.key) && rowEl(draft.key)?.hidden) fail('K3f', `${draft.key} holds the draft and is hidden`);
    if (focusedRow?.hidden) fail('K3f', `${focusedRow.dataset.key} holds the focus and is hidden`);
    for (const d of after.view.done ? [] : after.view.documents?.rows ?? []) {
      const want = draft?.key === `title:${d.fileId}` ? draft.text : d.title;
      if (textInput(docEl(d.fileId))?.value !== want) fail('K3d', `letter ${d.fileId} title shows "${textInput(docEl(d.fileId))?.value}", want "${want}"`);
    }
    // K3c
    if (held) {
      const f = h.state().phase === 'done' || !('files' in h.state()) ? undefined : (h.state() as Open).files.find((x) => `${x.id}:` === held!.key.slice(0, x.id.length + 1));
      const ref = held.key.slice(held.key.indexOf(':') + 1);
      const choices = f?.status.s === 'read' ? f.status.choices : null;
      const typed = choices?.typed?.[ref];
      const ok = draft?.key === held.key ? textInput(rowEl(held.key))?.value === draft.text
        : !choices || (held.expect === 'hold' ? typed?.text === held.text : !typed && (held.expect !== 'edit' || choices.edits[ref] === held.value));
      if (!ok) fail('K3c', `${held.key}: "${held.text}" typed and committed, the engine holds ${JSON.stringify({ typed, edit: choices?.edits[ref] })}`);
      // K3g: held text keeps the unit label it was typed under, whatever unit presses came since.
      if (held.expect === 'hold' && draft?.key !== held.key && typed?.text === held.text && unitLabel(held.key) !== held.label) {
        fail('K3g', `${held.key} holds "${held.text}" typed in ${held.label}, now labelled ${unitLabel(held.key)}`);
      }
    }
    // K3d, K3e
    const lis = [...document.querySelectorAll<HTMLLIElement>('li[data-key]')];
    // Under each day, in the order of each day's first row; in engine order within a day (B4).
    const sections = [...new Set(live.map((x) => x.section))];
    const order = sections.flatMap((sec) => live.filter((x) => x.section === sec).map((x) => x.key));
    if (lis.map((li) => li.dataset.key).join() !== order.join()) fail('K3d', 'the DOM rows are not the engine rows under their days');
    for (const li of lis) if (li.closest<HTMLElement>('[data-section]')?.dataset.section !== live.find((x) => x.key === li.dataset.key)?.section) fail('K3d', `${li.dataset.key} is not under its day`);
    for (const d of after.list.days) {
      const text = document.querySelector(`[data-at="${d.key}"] .upload-list-picker-button`)?.textContent;
      if (!after.view.done && text !== d.pickerLine) fail('K3d', `day ${d.key} button shows "${text}", the engine "${d.pickerLine}"`);
    }
    for (const l of after.view.done ? [] : after.page.letters) {
      const text = docEl(l.fileId)?.querySelector('.upload-list-picker-button')?.textContent;
      if (text !== l.pickerLine) fail('K3d', `letter ${l.fileId} date button shows "${text}", the engine "${l.pickerLine}"`);
    }
    for (const row of live) {
      const li = rowEl(row.key)!;
      if ((li.querySelector('.bt-cell-printed')?.textContent ?? null) !== row.printed) fail('K3d', `${row.key} printed note "${li.querySelector('.bt-cell-printed')?.textContent}", the engine "${row.printed}"`);
      const input = textInput(li);
      if ((input !== null) !== (row.input === 'number')) fail('K3d', `${row.key} input ${input !== null}, engine says ${row.input}`);
      const want = draft?.key === row.key ? draft.text : row.typed?.text ?? row.shown.text;
      if (input && input.value !== want) fail('K3d', `${row.key} shows "${input.value}", want "${want}"`);
      const seen = nodes.get(row.key);
      if (seen && (seen.li !== li || seen.input !== input)) fail('K3e', `${row.key} was remounted (${trace[trace.length - 1]})`);
      nodes.set(row.key, { li, input });
    }
  }
  cleanup();
}

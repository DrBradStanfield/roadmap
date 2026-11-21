// @vitest-environment jsdom
/**
 * K3, the web upload list's screen property (US-13 AC26, web list PR 2; seeded, mulberry32, no dependency). Each run
 * interleaves a person's DOM steps (focus, type, blur, Enter, Escape, tick, Replace, a day, Show all, a Save press with
 * and without focus on Save) with the engine's (a file's read landing before another's rows, another writer changing
 * the record, a Save answering). After every step:
 *   K3a the draft is none, or names a row whose input takes typing, and it is the one the person's steps left;
 *   K3b the screen sent the engine exactly what the person's steps say, worked out by the engine's own `transition` from
 *       the state before the step (a commit is `{typed: ref, text, unit}`; a Save press with a draft is commit, re-read,
 *       then Save if the view allows it, else the focus on the first blocker's control);
 *   K3c the last text typed at a row and not cancelled is the draft's, or the engine holds it (held text, or the edit
 *       `typedCommit` makes of it), until the person changes that row again;
 *   K3d the DOM's inputs are the engine's rows: one text input per row with `input: 'number'`, none otherwise, showing
 *       the draft while it names the row, else the held text, else the shown number;
 *   K3e no row's node, nor its input, is ever replaced while its row stands (status changes and rows landing before it).
 * Mutations it was shown failing on (PR body): M1 commit skipped on focus moving to another row; M2 the input's value
 * read from a stale local copy. Synthetic values only.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';
import { typedCommit } from '@roadmap/health-core/cell-input';
import { core, DAY, EMPTY, extra, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { valueAt } from '@roadmap/health-core/import-review';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { bulkAppendValues, type BulkRow } from '@roadmap/health-core/record-edits';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { NO_CHOICES, type ChoiceChange } from '@roadmap/health-core/upload-choices';
import { transition, type UploadEvent, type UploadState } from '@roadmap/health-core/upload-flow';
import type { DayControl, ListRow } from '@roadmap/health-core/upload-list';
import { lostReplaces, reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { engineSee, UploadListHost, type ListHost } from '../testing/upload-list-host';

afterEach(cleanup);

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
  values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [extra()],
};
const X1: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: null, unrecognized: [], document: null,
  values: [core({ valueSI: 500, displayValue: 500 }), core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' }), core({ valueSI: 3.4, displayValue: 3.4, recordedAt: COLUMN })],
  additionalValues: [extra({ name: 'Vitamin B12', value: 300, unit: 'pmol/L' })],
};
const file = (id: string, status: File['status']): File => ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status });
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });
const RECORDS: RoadmapFile[] = [EMPTY, ...[[LDL(3.1)], [LDL(2.0)], [LDL(2.0, COLUMN)], [LDL(2.0), LDL(2.5, COLUMN)]].map((rows) => bulkAppendValues(EMPTY, rows, NOW).file)];
const TEXTS = ['3.4', 'abc', '', '1,234', '12.9', '500', '2', '3..5', '0.5'];
const DAYS = ['2026-10-20', '2026-09-01', '2026-12-01', ''];

/** The person's model of the draft: the text typed into the focused input and not yet committed or cancelled. */
type Draft = { key: string; text: string } | null;
type Held = { key: string; text: string; expect: 'hold' | 'edit' | 'none'; value?: number };

const rowEl = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`);
const textInput = (li: Element | null) => li?.querySelector<HTMLInputElement>('input[type="text"]') ?? null;
const rowOfInput = (el: Element | null) => (el instanceof HTMLInputElement && el.type === 'text' ? el.closest<HTMLLIElement>('li[data-key]')?.dataset.key ?? null : null);

function runSequence(seed: number, steps: number) {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const f0: File = rand() < 0.6 ? file('f0', { s: 'sending', attempt: 1 }) : file('f0', { s: 'read', extraction: X0, choices: NO_CHOICES });
  const initial: Open = { phase: 'open', platform: 'web', run: 1, files: [f0, file('f1', { s: 'read', extraction: X1, choices: NO_CHOICES })], started: NOW, firstRead: NOW };
  const record0 = pick(RECORDS);
  const host = { current: null as ListHost | null };
  render(<UploadListHost initial={initial} record={record0} now={NOW} host={host} />);
  const h = host.current!;
  const trace: string[] = [];
  let draft = null as Draft;
  let held = null as Held | null;
  const nodes = new Map<string, { li: Element; input: HTMLInputElement | null }>();
  const fail = (prop: string, msg: string) => { throw new Error(`${prop} seed ${seed}: ${msg}\n  steps: ${trace.join(' > ')}`); };

  const see = (s: UploadState, record: RoadmapFile) => engineSee(s, record, NOW, () => 'si');
  /** The state after a commit of `d`, by the engine's own transition. */
  const committed = (s: UploadState, record: RoadmapFile, d: Draft): UploadState => {
    if (!d) return s;
    const row = see(s, record).list.rows.find((r) => r.key === d.key);
    if (!row) return s;
    const change: ChoiceChange = { typed: row.ref, text: d.text, unit: row.shown.cell?.unit ?? null };
    const after = transition(s, { type: 'chose', id: row.fileId, change, now: NOW }).state;
    if (after !== s) held = heldOf(s, row, d.text);
    return after;
  };
  /** What the engine must hold for text committed at `row` (K3c), from `typedCommit` on the choices before. */
  const heldOf = (s: UploadState, row: ListRow, text: string): Held | null => {
    const f = 'files' in s ? s.files.find((x) => x.id === row.fileId) : undefined;
    if (f?.status.s !== 'read') return null;
    const at = valueAt(f.status.extraction, row.ref)!;
    if (!text.trim()) return { key: row.key, text, expect: 'none' };
    const c = typedCommit(text, at, f.status.choices.edits[row.ref], row.shown.cell?.unit ?? null);
    if (!c) return null;
    return c.kind === 'hold' ? { key: row.key, text, expect: 'hold' } : c.kind === 'edit' ? { key: row.key, text, expect: 'edit', value: c.value } : { key: row.key, text, expect: 'none' };
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
    const leaving = draft !== null && el !== textInput(rowEl(draft.key));
    act(() => el.focus());
    return leaving;
  };

  for (let step = 0; step < steps; step++) {
    const before = h.state();
    const record = h.record();
    const { list } = see(before, record);
    const rows = list.rows;
    let expected: UploadState = before;
    let focusAt: string | null | undefined;
    const active = document.activeElement as HTMLElement | null;
    const activeRow = rowOfInput(active);
    const r = rand();
    if (r < 0.2) {
      const target = visible(rows, (x) => x.input === 'number' && !textInput(rowEl(x.key))!.disabled);
      if (!target.length) continue;
      const k = pick(target).key;
      trace.push(`focus ${k}`);
      if (focusMoves(textInput(rowEl(k))!)) { expected = committed(before, record, draft); draft = null; }
    } else if (r < 0.38) {
      if (!activeRow || (active as HTMLInputElement).disabled) continue;
      const text = pick(TEXTS);
      trace.push(`type "${text}"`);
      if ((active as HTMLInputElement).value !== text) {
        fireEvent.change(active!, { target: { value: text } });
        draft = { key: activeRow, text };
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
      const row = pick(target);
      const tick = rowEl(row.key)!.querySelector<HTMLInputElement>('.upload-list-tick')!;
      trace.push(`tick ${row.key}`);
      if (focusMoves(tick)) { expected = committed(before, record, draft); draft = null; }
      const mid = expected;
      const rowMid = see(mid, record).list.rows.find((x) => x.key === row.key)!;
      fireEvent.click(tick);
      expected = transition(mid, { type: 'chose', id: row.fileId, change: { tick: row.ref, on: !rowMid.ticked }, now: NOW }).state;
      if (held?.key === row.key) held = null;
    } else if (r < 0.67) {
      const target = visible(rows, (x) => x.replaces !== null).filter((x) => !rowEl(x.key)!.querySelector<HTMLInputElement>('.upload-list-replace input')!.disabled);
      if (!target.length) continue;
      const row = pick(target);
      const box = rowEl(row.key)!.querySelector<HTMLInputElement>('.upload-list-replace input')!;
      trace.push(`replace ${row.key}`);
      if (focusMoves(box)) { expected = committed(before, record, draft); draft = null; }
      const rowMid = see(expected, record).list.rows.find((x) => x.key === row.key)!;
      fireEvent.click(box);
      if (rowMid.replaces !== null) expected = transition(expected, { type: 'chose', id: row.fileId, change: { replace: row.ref, correctsId: rowMid.replacing ? null : rowMid.replaces }, now: NOW }).state;
      if (held?.key === row.key) held = null;
    } else if (r < 0.74) {
      const days = list.days.filter((d) => !document.querySelector<HTMLInputElement>(`input[data-at="${d.key}"]`)!.disabled);
      if (!days.length) continue;
      const d: DayControl = pick(days);
      const el = document.querySelector<HTMLInputElement>(`input[data-at="${d.key}"]`)!;
      const day = pick(DAYS);
      trace.push(`day ${d.key} "${day}"`);
      if (focusMoves(el)) { expected = committed(before, record, draft); draft = null; }
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
      const e: UploadEvent = { type: 'answered', run: 1, id: 'f0', extraction: X0, legacy: false, now: NOW };
      act(() => h.send(e));
      expected = transition(before, e).state;
    } else if (r < 0.95) {
      const next = pick(RECORDS);
      trace.push(`record ${RECORDS.indexOf(next)}`);
      act(() => h.setRecord(next));
      const lost = lostReplaces(uploadReview(before, next, NOW), before);
      expected = lost.length ? transition(before, { type: 'replacesLost', lost }).state : before;
    } else {
      if (before.phase !== 'saving') continue;
      const ok = rand() < 0.2;
      trace.push(ok ? 'saved' : 'save failed');
      const e: UploadEvent = ok ? { type: 'saved', run: 1, attempt: before.attempt, outcome: { values: 1, documents: 0, archived: 0 } } : { type: 'saveFailed', run: 1, attempt: before.attempt, message: 'Network' };
      act(() => h.send(e));
      expected = transition(before, e).state;
    }

    // K3b: exactly what the person's steps say reached the engine.
    if (JSON.stringify(h.state()) !== JSON.stringify(expected)) fail('K3b', 'the engine state is not what the steps sent');
    if (focusAt) {
      const want = document.querySelector(`[data-at="${focusAt}"]`);
      if (document.activeElement !== want) fail('K3b', `a refused Save left the focus off its blocker ${focusAt}`);
    }
    const after = see(h.state(), h.record());
    const live = after.view.done ? [] : after.list.rows;
    if (!live.length) { draft = null; held = null; nodes.clear(); }
    // K3a
    const shownDraft = document.querySelector<HTMLElement>('.upload-list')?.dataset.draft ?? null;
    if (shownDraft !== (draft?.key ?? null)) fail('K3a', `the screen's draft is ${shownDraft}, the person's ${draft?.key ?? null}`);
    if (draft && live.find((x) => x.key === draft!.key)?.input !== 'number') fail('K3a', `the draft names ${draft.key}, which takes no input`);
    // K3c
    if (held) {
      const f = h.state().phase === 'done' || !('files' in h.state()) ? undefined : (h.state() as Open).files.find((x) => `${x.id}:` === held!.key.slice(0, x.id.length + 1));
      const ref = held.key.slice(held.key.indexOf(':') + 1);
      const choices = f?.status.s === 'read' ? f.status.choices : null;
      const typed = choices?.typed?.[ref];
      const ok = draft?.key === held.key ? textInput(rowEl(held.key))?.value === draft.text
        : !choices || (held.expect === 'hold' ? typed?.text === held.text : !typed && (held.expect !== 'edit' || choices.edits[ref] === held.value));
      if (!ok) fail('K3c', `${held.key}: "${held.text}" typed and committed, the engine holds ${JSON.stringify({ typed, edit: choices?.edits[ref] })}`);
    }
    // K3d, K3e
    const lis = [...document.querySelectorAll<HTMLLIElement>('li[data-key]')];
    if (lis.map((li) => li.dataset.key).join() !== live.map((x) => x.key).join()) fail('K3d', 'the DOM rows are not the engine rows');
    for (const row of live) {
      const li = rowEl(row.key)!;
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

describe('K3: the web upload list keeps the person\'s input and draws the engine (US-13 AC26)', () => {
  it('over seeded runs of interleaved screen and engine steps', () => {
    for (let seed = 1; seed <= 120; seed++) runSequence(seed, 45);
  });
});

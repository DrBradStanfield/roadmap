/**
 * US-13 AC24: a dated previous column's day as a choice (`columnDay`), the web's picker for a column
 * that printed its own day. A real past day moves the column's values; a partial or future pick is
 * kept, so the column shows it, and the report waits (`needsColumnDay`); a column day for no real past
 * day a value printed is refused. The schema takes the choice and refuses a malformed one. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW, recordWith } from './import-review.test-helpers';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { choose, NO_CHOICES, type ChoiceChange, type FileChoices } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { UPLOAD_EVENT, UPLOAD_STATE } from './upload-schema';
import { UPLOAD_TEXT } from './upload-text';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces } from './upload-review';
import { uploadList } from './upload-list';
import { uploadView } from './upload-view';

const COLUMN = '2026-05-01';
/** A report on 1 Oct with an LDL printed in a previous column on `day`, and one on the report's own day. */
const prev = (day: string = COLUMN): UnifiedExtractionResult => ({
  classification: 'lab_report', reportDate: '2026-10-01', values: [core({ recordedAt: day }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })],
  additionalValues: [], unrecognized: [], document: null,
});
const read = (x: UnifiedExtractionResult, choices: FileChoices = NO_CHOICES): UploadFile =>
  ({ id: 'lab', name: 'lab.pdf', bytes: 1, hash: 'h-lab', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices } });
const open = (x: UnifiedExtractionResult, choices?: FileChoices): UploadState =>
  ({ phase: 'open', platform: 'web', run: 1, files: [read(x, choices)], started: NOW, firstRead: NOW });
const days = (s: UploadState) => uploadReview(s, EMPTY, NOW).classification.rows.map((r) => r.recordedAt.slice(0, 10)).sort();

describe('US-13 AC24: a dated previous column\'s day', () => {
  it('a real past day moves the column\'s values, and only those; null puts them back', () => {
    const picked = choose(NO_CHOICES, { columnDay: COLUMN, day: '2026-05-02' }, NOW, prev());
    expect(picked?.columnDays).toEqual({ [COLUMN]: expect.stringMatching(/^2026-05-02/) });
    expect(days(open(prev(), picked!))).toEqual(['2026-05-02', '2026-10-01']);
    const back = choose(picked!, { columnDay: COLUMN, day: null }, NOW, prev());
    expect(back?.columnDays).toEqual({});
    expect(days(open(prev(), back!))).toEqual([COLUMN, '2026-10-01']);
  });

  it('a partial or future pick is kept; nothing of the report is written and Save waits for a day', () => {
    for (const day of ['2999-01-01', 'partial:2026:5:']) {
      const picked = choose(NO_CHOICES, { columnDay: COLUMN, day }, NOW, prev());
      expect(picked?.columnDays).toEqual({ [COLUMN]: day });
      const s = open(prev(), picked!);
      const review = uploadReview(s, EMPTY, NOW);
      expect(review.labFiles[0]).toMatchObject({ needsDay: true, needsColumnDay: true, needsTestDay: false, needsPreviousDay: false });
      expect(review.classification.rows).toEqual([]);
      expect(uploadView(s, EMPTY, NOW, review, false).save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay });
    }
  });

  // One rule for every previous column (`previousDay`, orchestrator ruling 2026-11-21): a previous result is before the report's day.
  it('a pick on or after the report\'s day waits, as the undated column\'s does', () => {
    for (const day of ['2026-10-01', '2026-10-05']) {
      const s = open(prev(), choose(NO_CHOICES, { columnDay: COLUMN, day }, NOW, prev())!);
      expect(uploadReview(s, EMPTY, NOW).labFiles[0], day).toMatchObject({ needsDay: true, needsColumnDay: true });
      expect(days(s), day).toEqual([]);
    }
    // The test's day the person picked is the report's day: a column pick after it waits too.
    const picked = choose({ ...NO_CHOICES, testDay: '2026-09-01' }, { columnDay: COLUMN, day: '2026-09-10' }, NOW, prev())!;
    expect(uploadReview(open(prev(), picked), EMPTY, NOW).labFiles[0]).toMatchObject({ needsColumnDay: true });
  });

  it('an undated report: any real past day is taken until the test\'s day is set, then it must come before it', () => {
    const undated: UnifiedExtractionResult = { ...prev(), reportDate: null, values: [core({ recordedAt: COLUMN })] };
    const picked = choose(NO_CHOICES, { columnDay: COLUMN, day: '2026-10-05' }, NOW, undated)!;
    expect(uploadReview(open(undated, picked), EMPTY, NOW).labFiles[0]).toMatchObject({ needsDay: false, needsColumnDay: false });
    expect(days(open(undated, picked))).toEqual(['2026-10-05']);
    const dated = choose(picked, { testDay: '2026-10-03' }, NOW, undated)!;
    expect(uploadReview(open(undated, dated), EMPTY, NOW).labFiles[0]).toMatchObject({ needsDay: true, needsColumnDay: true });
  });

  it('a waiting pick on a column whose values are all cleared holds up nothing', () => {
    const picked = choose({ ...NO_CHOICES, ticks: { v0: false } }, { columnDay: COLUMN, day: '2999-01-01' }, NOW, prev());
    expect(uploadReview(open(prev(), picked!), EMPTY, NOW).labFiles[0]).toMatchObject({ needsDay: false, needsColumnDay: false });
  });

  it('a moved column clears the Replace on its values (US-13 AC7); the same day keeps it', () => {
    const c = choose(NO_CHOICES, { replace: 'v0', correctsId: 'held' }, NOW, prev())!;
    expect(choose(c, { columnDay: COLUMN, day: '2026-05-03' }, NOW, prev())?.replace).toEqual({});
    expect(choose(c, { columnDay: COLUMN, day: COLUMN }, NOW, prev())?.replace).toEqual({ v0: 'held' });
  });

  it('a Replace on the picked day corrects the row held there', () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: '2026-05-02' }]);
    const held = record.labValues[0].id;
    let c = choose(NO_CHOICES, { columnDay: COLUMN, day: '2026-05-02' }, NOW, prev())!;
    c = choose(c, { replace: 'v0', correctsId: held }, NOW, prev())!;
    const review = uploadReview(open(prev(), c), record, NOW);
    expect(review.classification.rows.filter((r) => r.correctsId === held)).toHaveLength(1);
  });

  it('refused: the undated column, a day no value printed, and a printed day still to come (owner ruling 2026-11-20)', () => {
    const future = prev('2027-01-01');
    for (const [change, x] of [
      [{ columnDay: UNDATED_PREVIOUS, day: '2026-05-02' }, { ...prev(), values: [core({ recordedAt: UNDATED_PREVIOUS })] }],
      [{ columnDay: '2026-04-01', day: '2026-05-02' }, prev()],
      [{ columnDay: '2027-01-01', day: '2026-05-02' }, future],
    ] as Array<[ChoiceChange, UnifiedExtractionResult]>) {
      expect(choose(NO_CHOICES, change, NOW, x), JSON.stringify(change)).toBeNull();
      const s = open(x);
      expect(transition(s, { type: 'chose', id: 'lab', change, now: NOW }).state).toBe(s);
    }
    // A state that holds such a pick anyway still never saves a value printed on a day to come.
    const s = open(future, { ...NO_CHOICES, columnDays: { '2027-01-01': '2026-05-02' } });
    expect(uploadReview(s, EMPTY, NOW).classification.values.find((v) => v.ref === 'v0')).toMatchObject({ writes: false, group: 'notSaved', reason: 'futureCoreDay' });
  });
});

describe('US-13 AC24: review fixes (PR 1926 adversary and Codex)', () => {
  const two: UnifiedExtractionResult = { ...prev(), values: [core({ recordedAt: '2026-05-01' }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', recordedAt: '2026-06-01' })] };

  it('A: a column is judged by the day its values printed, so a value moved onto a waiting column\'s day is not held up by it', () => {
    const c: FileChoices = { ...NO_CHOICES, ticks: { v1: false }, columnDays: { '2026-05-01': '2026-06-01', '2026-06-01': 'partial:2026::' } };
    const review = uploadReview(open(two, c), EMPTY, NOW);
    expect(review.labFiles[0]).toMatchObject({ needsDay: false, needsColumnDay: false });
    expect(review.classification.rows.map((r) => r.recordedAt.slice(0, 10))).toEqual(['2026-06-01']);
    // The waiting column's own value, ticked, still waits.
    expect(uploadReview(open(two, { ...c, ticks: {} }), EMPTY, NOW).labFiles[0]).toMatchObject({ needsColumnDay: true });
  });

  // A guard: the raw pick never reached a row before (the write cleans its day too); it is now cleaned where it is read.
  it('A: a pick with a time is used as the undated column\'s rule cleans it, as the same day without one', () => {
    const at = (pick: string) => { const s = open(prev(), { ...NO_CHOICES, columnDays: { [COLUMN]: pick } }); const review = uploadReview(s, EMPTY, NOW); return { rows: review.classification.rows, view: uploadView(s, EMPTY, NOW, review, false).sure?.rows.map((r) => [r.ref, r.day]) }; };
    expect(at('2026-05-02T09:30:00.000Z')).toEqual(at('2026-05-02'));
  });

  it('C: after a column pick, each saving row\'s day in the view is the day Save writes; a waiting column\'s value has none', () => {
    const s = open(prev(), choose(NO_CHOICES, { columnDay: COLUMN, day: '2026-05-02' }, NOW, prev())!);
    const review = uploadReview(s, EMPTY, NOW);
    const view = uploadView(s, EMPTY, NOW, review, false);
    const rows = [...(view.sure?.rows ?? []), ...view.sections.flatMap((x) => (x.kind === 'unsure' ? x.rows : []))];
    const plan = uploadSavePlan(s, EMPTY, NOW, review, false).labRows.flatMap((f) => f.rows);
    expect(rows.map((r) => r.day).sort()).toEqual(plan.map((r) => r.recordedAt.slice(0, 10)).sort());
    expect(rows.find((r) => r.ref === 'v0')?.day).toBe('2026-05-02');
    const waits = open(prev(), choose(NO_CHOICES, { columnDay: COLUMN, day: 'partial:2026::' }, NOW, prev())!);
    const wr = uploadReview(waits, EMPTY, NOW);
    // Web list PR 1b: a waiting column's value has no day, so it is judged on none (never previewed on the day it printed):
    // it waits, out of the phone's view, and is a row of the web's list under its column, saving nothing.
    expect(wr.classification.values.find((v) => v.ref === 'v0')).toMatchObject({ group: 'waiting', sent: false });
    expect(uploadList(waits, EMPTY, NOW, wr, () => 'si').rows.find((r) => r.ref === 'v0')).toMatchObject({ section: `lab|printed:${COLUMN}`, status: { kind: 'waits' }, saves: false });
  });

  it('D: while a column waits, a Replace chosen on its value is kept, not lost, and nothing is written', () => {
    const undated: UnifiedExtractionResult = { ...prev(), reportDate: null, values: [core({ recordedAt: COLUMN })] };
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: '2026-10-05' }]);
    const held = record.labValues[0].id;
    let c = choose(NO_CHOICES, { columnDay: COLUMN, day: '2026-10-05' }, NOW, undated)!;
    c = choose(c, { replace: 'v0', correctsId: held }, NOW, undated)!;
    expect(uploadReview(open(undated, c), record, NOW).labFiles[0].replacing).toEqual(['v0']);
    c = choose(c, { testDay: '2026-10-03' }, NOW, undated)!; // the column's pick is no longer before the report's day: it waits
    const s = open(undated, c);
    const review = uploadReview(s, record, NOW);
    expect(review.labFiles[0]).toMatchObject({ needsColumnDay: true, replacing: ['v0'] });
    expect(lostReplaces(review, s)).toEqual([]);
    expect(review.classification.rows).toEqual([]);
  });
});

describe('US-13 AC24: the machine and the schema', () => {
  // [from choices, change, expected columnDays after, or 'same' when refused]
  const table: Array<[string, FileChoices, ChoiceChange, Record<string, string> | 'same']> = [
    ['pick a past day', NO_CHOICES, { columnDay: COLUMN, day: '2026-05-02' }, { [COLUMN]: '2026-05-02' }],
    ['pick a partial day', NO_CHOICES, { columnDay: COLUMN, day: 'partial:2026::' }, { [COLUMN]: 'partial:2026::' }],
    ['clear the pick', { ...NO_CHOICES, columnDays: { [COLUMN]: 'partial:2026::' } }, { columnDay: COLUMN, day: null }, {}],
    ['a day no value printed', NO_CHOICES, { columnDay: '2026-04-01', day: '2026-05-02' }, 'same'],
  ];
  it.each(table)('transition: %s', (_, from, change, after) => {
    const s = open(prev(), from);
    const next = transition(s, { type: 'chose', id: 'lab', change, now: NOW }).state;
    if (after === 'same') expect(next).toBe(s);
    else expect(next.phase === 'open' && next.files[0].status.s === 'read' && next.files[0].status.choices.columnDays).toEqual(after);
  });

  it('the state and the event take the choice; a malformed one is refused', () => {
    expect(UPLOAD_STATE.safeParse(open(prev(), { ...NO_CHOICES, columnDays: { [COLUMN]: '2026-05-02' } })).success).toBe(true);
    expect(UPLOAD_STATE.safeParse(open(prev(), NO_CHOICES)).success).toBe(true);
    expect(UPLOAD_STATE.safeParse(open(prev(), { ...NO_CHOICES, columnDays: { [COLUMN]: 5 } } as never)).success).toBe(false);
    const chose = (change: unknown) => UPLOAD_EVENT.safeParse({ type: 'chose', id: 'lab', now: NOW, change }).success;
    expect(chose({ columnDay: COLUMN, day: '2026-05-02' })).toBe(true);
    expect(chose({ columnDay: COLUMN, day: null })).toBe(true);
    for (const bad of [{ columnDay: 5, day: null }, { columnDay: COLUMN, day: 3 }, { columnDay: COLUMN }, { columnDay: COLUMN, day: null, tick: 'v0' }]) {
      expect(chose(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

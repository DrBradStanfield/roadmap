/**
 * PR 1944 review round one (2026-11-21): each finding as a failing test first. F1 an unfamiliar core metric never crashes
 * the review on either client; F2 a person's input (held text, edits) is erased only by that person's own event on that
 * ref, never by a lost Replace; F3 no schema-valid typed change throws; F4 typed text on a letter's values is refused;
 * F5 the phone's blocker list, pinned. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from './import-review.test-helpers';
import { IMPORT_REVIEW_TEXT } from './import-review';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { dropLostReplaces, uploadReview } from './upload-review';
import { UPLOAD_EVENT } from './upload-schema';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { uploadView } from './upload-view';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files'], platform: 'web' | 'phone' = 'web'): Open => ({ phase: 'open', platform, run: 1, files, started: NOW, firstRead: NOW });
const see = (s: UploadState, record: RoadmapFile) => {
  const review = uploadReview(s, record, NOW);
  return { review, list: uploadList(s, record, NOW, review, () => 'si'), view: uploadView(s, record, NOW, review, false, s.platform === 'web' ? () => 'si' : undefined) };
};
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const choicesOf = (s: UploadState, id = 'f0') => {
  const f = (s as Open).files.find((x) => x.id === id)!;
  return f.status.s === 'read' ? f.status.choices : null;
};
const HBA1C = core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' });

describe('F1: a core metric the app does not know (Codex, round one)', () => {
  const unknown = core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' });
  for (const platform of ['phone', 'web'] as const) {
    it(`${platform}: the view and the list render; the row carries main's refusal; cleared, the other value saves`, () => {
      const s = open([labRead('f0', { values: [unknown, HBA1C] })], platform);
      const { review, view, list } = see(s, EMPTY);
      expect(review.classification.values.find((v) => v.ref === 'v0')).toMatchObject({ group: 'unsure', reasons: ['outOfRange'] });
      // US-13 AC27: the write refuses that row alone; Save writes the other.
      expect(view.save).toMatchObject({ enabled: true, blockers: [], label: IMPORT_REVIEW_TEXT.save(1) });
      expect(list.rows[0]).toMatchObject({ key: 'f0:v0', error: 'Unknown core metric', status: { kind: 'refused' }, shown: { number: '12', unit: 'zz/L', current: 12 } });
      expect(review.classification.rows).toHaveLength(1);
      const cleared = chose(s, 'f0', { tick: 'v0', on: false });
      expect(see(cleared, EMPTY).view.save).toMatchObject({ enabled: true, label: IMPORT_REVIEW_TEXT.save(1) });
      // Ticking back, typing and editing never throw; typing and editing an unknown metric change nothing.
      expect(() => see(chose(cleared, 'f0', { tick: 'v0', on: true }), EMPTY)).not.toThrow();
      expect(chose(s, 'f0', { typed: 'v0', text: '3', unit: 'si' })).toBe(s);
      expect(chose(s, 'f0', { edit: 'v0', value: 3 })).toBe(s);
    });
  }
});

describe('F2: a lost Replace never erases the person\'s input (adversary R1, round one)', () => {
  const record = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' }], NOW).file;
  const heldId = record.labValues[0].id;
  // Another device corrects the held row: the Replace's target leaves its slot.
  const corrected = bulkAppendValues(record, [{ kind: 'measurement', metricType: 'ldl', value: 3.2, recordedAt: DAY, source: 'manual', correctsId: heldId } as BulkRow], NOW).file;
  const replaced = () => chose(open([labRead('f0', { values: [core({ valueSI: 3.5, displayValue: 3.5 })] })]), 'f0', { replace: 'v0', correctsId: heldId });

  it('held text survives: the Replace and the tick go (US-13 AC21), the text stays, the row needs attention, Save is blocked at it', () => {
    const typed = chose(replaced(), 'f0', { typed: 'v0', text: '3,5x', unit: 'si' });
    expect(see(typed, record).view.save.blockers).toEqual([{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }]);
    const { state } = dropLostReplaces(typed, corrected, NOW);
    expect(choicesOf(state)).toMatchObject({ replace: {}, ticks: { v0: false }, typed: { v0: { text: '3,5x', unit: 'si' } } });
    const { view, list } = see(state, corrected);
    expect(list.rows[0]).toMatchObject({ ticked: false, typed: { text: '3,5x' }, attention: true, status: { kind: 'error' } });
    expect(view.save).toMatchObject({ enabled: false, blockers: [{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }] });
  });

  it('an edit survives too, as on main (upload-choices.ts `untick` never touched `edits`)', () => {
    const edited = chose(replaced(), 'f0', { edit: 'v0', value: 3.6 });
    const { state } = dropLostReplaces(edited, corrected, NOW);
    expect(choicesOf(state)).toMatchObject({ replace: {}, ticks: { v0: false }, edits: { v0: 3.6 } });
  });

  it('the person\'s own clear still drops the text', () => {
    const typed = chose(replaced(), 'f0', { typed: 'v0', text: '3,5x', unit: 'si' });
    expect(choicesOf(chose(typed, 'f0', { tick: 'v0', on: false }))).not.toHaveProperty('typed');
  });
});

describe('F3: no schema-valid typed change throws (adversary R2, round one)', () => {
  const lpa = core({ metric: 'lpa', valueSI: 50, displayValue: 50, displayUnit: 'nmol/L' });
  const s = () => open([labRead('f0', { values: [core({}), lpa], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }] })]);
  const units = ['si', 'conventional', 'nmol/L', 'mg/dL', 'mg/L', null] as const;
  it('every unit the schema takes, on a core value, Lp(a) and a lab: refused unless it fits, never a throw', () => {
    for (const ref of ['v0', 'v1', 'a0']) {
      for (const unit of units) {
        const change = { typed: ref, text: '3', unit };
        expect(UPLOAD_EVENT.safeParse({ type: 'chose', id: 'f0', change, now: NOW }).success).toBe(true);
        expect(() => chose(s(), 'f0', change)).not.toThrow();
      }
    }
    expect(choicesOf(chose(s(), 'f0', { typed: 'v0', text: '3', unit: 'nmol/L' }))).toEqual(NO_CHOICES); // LDL in an Lp(a) unit: no change
    expect(choicesOf(chose(s(), 'f0', { typed: 'v1', text: '60', unit: 'nmol/L' }))?.edits).toEqual({ v1: 60 });
    expect(choicesOf(chose(s(), 'f0', { typed: 'v0', text: '3', unit: 'mg/L' }))).toEqual(NO_CHOICES);
  });
});

describe('F4: typed text on a letter\'s values (adversary R3, round one)', () => {
  it('is refused: a letter files no values, so its text could block nothing', () => {
    const letter = labRead('f0', { classification: 'clinic_letter', values: [core({})], document: { classification: 'clinic_letter', title: 'L', documentDate: null, contentMarkdown: '', metadata: {} } });
    const s = open([letter]);
    expect(chose(s, 'f0', { typed: 'v0', text: 'abc', unit: 'si' })).toBe(s);
  });
});

describe('F5: the phone\'s blocker list (adversary R4, round one)', () => {
  it('an undated report with LDL 500: the day alone; the row blocks nothing (US-13 AC27)', () => {
    const { view } = see(open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })], 'phone'), EMPTY);
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.chooseDay, blockers: [{ why: UPLOAD_TEXT.chooseDay, at: 'f0|test' }] });
  });
});

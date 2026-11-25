/**
 * Web list PR 1c (US-13 AC26, 2026-11-21): three review points closed before any screen is built. A row says whether its
 * input takes typing (`input`); a tick on never erases held text, after a lost Replace too; text that is no number keeps
 * the edit beneath it. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { dropLostReplaces, uploadReview } from './upload-review';
import { FIX_ERRORS_TEXT } from './upload-text';
import { uploadView } from './upload-view';

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const see = (s: UploadState, record: RoadmapFile) => {
  const review = uploadReview(s, record, NOW);
  return { list: uploadList(s, record, NOW, review, () => 'si'), view: uploadView(s, record, NOW, review, false, () => 'si') };
};
const chose = (s: UploadState, id: string, change: ChoiceChange) => transition(s, { type: 'chose', id, change, now: NOW }).state;
const choicesOf = (s: UploadState) => {
  const f = (s as Open).files[0];
  return f.status.s === 'read' ? f.status.choices : null;
};

describe('a row says whether its input takes typing (US-13 AC26)', () => {
  const unknown = core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' });
  const s = open([labRead('f0', { values: [core({}), unknown], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }] })]);

  it('a known core value and a plain lab take a number; a core metric the units table lacks takes none', () => {
    expect(see(s, EMPTY).list.rows.map((r) => [r.ref, r.input])).toEqual([['v0', 'number'], ['v1', 'none'], ['a0', 'number']]);
  });

  it('every typed and edit change on that row is refused, an emptied input included: only its tick clears it', () => {
    const changes: ChoiceChange[] = [
      { typed: 'v1', text: '3', unit: 'si' }, { typed: 'v1', text: 'abc', unit: 'si' }, { typed: 'v1', text: '', unit: 'si' },
      { typed: 'v1', text: '', unit: null }, { edit: 'v1', value: 3 }, { edit: 'v1', value: null },
    ];
    for (const change of changes) expect(chose(s, 'f0', change)).toBe(s);
    expect(choicesOf(chose(s, 'f0', { tick: 'v1', on: false }))).toMatchObject({ ticks: { v1: false } });
  });
});

describe('the person\'s input under each of their own changes (L7 review, 2026-11-21)', () => {
  const record = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' }], NOW).file;
  const heldId = record.labValues[0].id;
  const corrected = bulkAppendValues(record, [{ kind: 'measurement', metricType: 'ldl', value: 3.2, recordedAt: DAY, source: 'manual', correctsId: heldId } as BulkRow], NOW).file;

  it('after a lost Replace leaves a row unticked with held text, ticking it on keeps the text and Save stays blocked', () => {
    const replaced = chose(open([labRead('f0', { values: [core({ valueSI: 3.5, displayValue: 3.5 })] })]), 'f0', { replace: 'v0', correctsId: heldId });
    const { state } = dropLostReplaces(chose(replaced, 'f0', { typed: 'v0', text: '3,5x', unit: 'si' }), corrected, NOW);
    expect(choicesOf(state)).toMatchObject({ ticks: { v0: false }, typed: { v0: { text: '3,5x', unit: 'si' } } });
    const on = chose(state, 'f0', { tick: 'v0', on: true });
    expect(choicesOf(on)).toMatchObject({ ticks: { v0: true }, typed: { v0: { text: '3,5x', unit: 'si' } } });
    const { list, view } = see(on, corrected);
    expect(list.rows[0]).toMatchObject({ ticked: true, typed: { text: '3,5x' }, status: { kind: 'error' } });
    expect(view.save).toMatchObject({ enabled: false, blockers: [{ why: FIX_ERRORS_TEXT, at: 'f0:v0' }] });
  });

  it('text that is no number, typed over an edit, is held and keeps the edit; emptied, the text goes and the edit stays', () => {
    const edited = chose(open([labRead('f0', { values: [core({})] })]), 'f0', { edit: 'v0', value: 3.6 });
    const held = chose(edited, 'f0', { typed: 'v0', text: 'abc', unit: 'si' });
    expect(choicesOf(held)).toMatchObject({ edits: { v0: 3.6 }, typed: { v0: { text: 'abc', unit: 'si' } } });
    expect(see(held, EMPTY).list.rows[0]).toMatchObject({ typed: { text: 'abc' }, shown: { current: 3.6 } });
    const emptied = choicesOf(chose(held, 'f0', { typed: 'v0', text: '', unit: 'si' }));
    expect(emptied).toMatchObject({ ticks: { v0: false }, edits: { v0: 3.6 } });
    expect(emptied).not.toHaveProperty('typed');
  });
});

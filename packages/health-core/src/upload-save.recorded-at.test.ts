/**
 * PR 1906 owner ruling 2026-11-20 (recordedAtDayOnly; US-52 AC8c, US-12 AC6a, US-13 AC7): an upload's
 * value rows carry `recordedAt` as the day alone (`YYYY-MM-DD`), as the iPhone's save always has; main's
 * web wrote `YYYY-MM-DDT00:00:00.000Z`. A record holds both forms, so every slot rule must read them as
 * one day: no second active row, a repeat is already saved, Replace corrects the old form, merge keeps
 * one. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { mergeFiles } from './merge';
import { bulkAppendValues } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import type { UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { uploadSave } from './upload-save';

const ISO = `${DAY}T00:00:00.000Z`;
const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values: [core({ valueSI: 3.1, displayValue: 3.1 })], additionalValues: [], unrecognized: [], document: null };
const saving = (choices: FileChoices = NO_CHOICES): UploadState => ({ phase: 'saving', platform: 'web', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices } }] });
const off = { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };
async function save(s: UploadState, record: RoadmapFile) {
  const out = await uploadSave(s, record, NOW, false, off);
  if (!out.ok) throw new Error(out.reason);
  return out.commit(record);
}
// LDL is a core blood test: its rows live in `labValues` (US-66), read here from either list.
const ldl = (f: RoadmapFile) => [...f.measurements, ...f.labValues].filter((m) => ('metricType' in m ? m.metricType : m.metricName) === 'ldl');
const active = (f: RoadmapFile) => ldl(f).filter((m) => m.status === 'active');

describe('recordedAt as the day alone beside the old ISO-midnight form (owner ruling 2026-11-20)', () => {
  it('(a) a value saved in the old ISO form, uploaded again, is already saved: no second row, nothing added', async () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: ISO }]);
    expect(uploadReview(saving(), record, NOW).classification.values.map((v) => v.group)).toEqual(['saved']);
    const { file, outcome } = await save(saving(), record);
    expect(active(file)).toHaveLength(1);
    expect(outcome.values).toBe(0);
  });

  it('(b) a value an upload saved day-only is a taken slot for a writer that still sends the ISO form', async () => {
    const { file: uploaded } = await save(saving(), EMPTY);
    expect(ldl(uploaded).map((m) => m.recordedAt)).toEqual([DAY]);
    const again = bulkAppendValues(uploaded, [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: ISO, source: 'manual' }], NOW);
    expect(again.outcomes).toEqual(['skipped']);
    expect(active(again.file)).toHaveLength(1);
    // And the upload, read again on that record, is already saved.
    expect(uploadReview(saving(), uploaded, NOW).classification.values.map((v) => v.group)).toEqual(['saved']);
  });

  it('(c) Replace of an old-form row appends a correction naming it, and flips it', async () => {
    const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 4.2, recordedAt: ISO }]);
    const held = ldl(record)[0];
    expect(uploadReview(saving(), record, NOW).held.get('0:v0')).toBe(held.id);
    const { file, outcome } = await save(saving({ ...NO_CHOICES, replace: { v0: held.id } }), record);
    expect(outcome.values).toBe(1);
    const rows = ldl(file);
    expect(rows.find((m) => m.id === held.id)).toMatchObject({ status: 'entered-in-error', value: 4.2, recordedAt: ISO });
    // The correction takes the day of the row it corrects as that row holds it (bulkAppendValues), so it keeps the old form.
    expect(active(file)).toEqual([expect.objectContaining({ value: 3.1, correctsId: held.id, recordedAt: ISO })]);
  });

  it('(d) merging a device holding the ISO form with one holding the day-only form for that day keeps one active row', () => {
    const iso = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 4.2, recordedAt: ISO, source: 'manual' }], NOW).file;
    const later = '2026-11-03T00:00:00.000Z';
    const dayOnly = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'lab_import' }], later).file;
    const opts = { deviceId: 'dev_merge', now: later };
    for (const merged of [mergeFiles(iso, dayOnly, opts), mergeFiles(dayOnly, iso, opts)]) {
      expect(ldl(merged)).toHaveLength(2);
      expect(active(merged)).toEqual([expect.objectContaining({ value: 3.1, recordedAt: DAY })]);
    }
  });
});

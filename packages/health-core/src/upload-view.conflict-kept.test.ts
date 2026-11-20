/**
 * PR 1906 Codex pass (US-13 AC5, AC7): only a value Save would write can block Save. An out-of-range value
 * that conflicts with a saved one, its Replace off (the person keeps the saved value), is never written,
 * so it does not block; with Replace on it would replace the saved value, and blocks with the existing
 * reason. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, NOW, recordWith } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { DAY } from './import-review.test-helpers';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { FIX_ERRORS_TEXT } from './upload-text';
import { uploadView } from './upload-view';

const record = recordWith([{ kind: 'measurement', metricType: 'ldl', value: 2.5 }]);
const held = record.labValues.find((l) => l.metricName === 'ldl')!;
const report: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, additionalValues: [], unrecognized: [], document: null,
  values: [core({ metric: 'ldl', valueSI: 999, displayValue: 999 }), core({ metric: 'hdl', valueSI: 1.4, displayValue: 1.4 })] };
const open = (choices: FileChoices): Extract<UploadState, { phase: 'open' }> => ({ phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: report, choices } }] });
const viewOf = (s: UploadState) => uploadView(s, record, NOW, uploadReview(s, record, NOW), false);

describe('an out-of-range value in conflict with a saved one', () => {
  it('Replace off: Save is enabled and writes the HDL alone', async () => {
    const s = open(NO_CHOICES);
    expect(viewOf(s).save).toMatchObject({ enabled: true, why: null });
    const out = await uploadSave(transition(s, { type: 'saveStarted' }).state, record, NOW, false, { holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW });
    if (!out.ok) throw new Error(out.reason);
    const { file } = out.commit(record);
    expect(file.labValues.filter((l) => l.status === 'active').map((l) => [l.metricName, l.value]).sort()).toEqual([['hdl', 1.4], ['ldl', 2.5]]);
  });

  it('Replace on: Save waits with the existing reason', () => {
    expect(viewOf(open({ ...NO_CHOICES, replace: { v0: held.id } })).save).toMatchObject({ enabled: false, why: FIX_ERRORS_TEXT });
  });
});

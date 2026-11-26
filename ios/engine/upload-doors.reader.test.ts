// US-12 AC9: which reader a file goes to (`reader`, health-core upload-flow.ts) is the web's alone: the iPhone's files
// always go to its server, and its words for a failed read are its own. Every door that reads a state refuses one naming
// a reader ('invalid-state'), whatever platform it claims, as it refuses the web's other fields
// (upload-doors.screening.test.ts). Synthetic values only.
import { describe, expect, it } from 'vitest';
import { uploadSavePlanJson, uploadStepJson, uploadViewJson } from './entry';
import { uploadSaveRun } from './upload-save-door';

const NOW = '2026-11-02T00:00:00.000Z';
const extraction = { classification: 'lab_report', reportDate: '2026-10-20', unrecognized: [], values: [], additionalValues: [], document: null };
const choices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const open = (platform: string, reader?: string) => ({
  phase: 'open', platform, ...(reader ? { reader } : {}), run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } }],
});
const reason = (json: string) => JSON.parse(json).reason;

describe('US-12 AC9: the phone\'s doors never hold a reader', () => {
  it('a state naming a reader is refused by the step, view, plan and save doors, on either platform', async () => {
    for (const platform of ['phone', 'web']) {
      for (const reader of ['server', 'ownKey']) {
        const s = JSON.stringify(open(platform, reader));
        expect(reason(uploadStepJson(s, JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
        expect(reason(uploadStepJson(JSON.stringify({ phase: 'choosing', platform, reader, run: 0 }), JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
        expect(reason(uploadViewJson(s, '', NOW, false, 'phone'))).toBe('invalid-state');
        expect(reason(uploadSavePlanJson(s, '', NOW, false, 'phone'))).toBe('invalid-state');
        const out = await uploadSaveRun(JSON.stringify({ ...open(platform, reader), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
        expect(reason(out)).toBe('invalid-state');
      }
    }
  });

  it('the same state with no reader is read', () => {
    const view = JSON.parse(uploadViewJson(JSON.stringify(open('phone')), '', NOW, false, 'phone'));
    expect(view.reason).toBeUndefined();
    expect(view.files.rows).toEqual([{ fileId: 'f', name: 'a.pdf', status: expect.any(String), notFullyRead: expect.any(Boolean) }]);
  });
});

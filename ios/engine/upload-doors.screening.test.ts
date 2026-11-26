// US-13 AC6 (owner ruling on the upload list mount note, 2026-11-22): a letter's screening box is the web's alone. The
// step door takes only the phone's changes (health-core PHONE_CHANGE), so a screening tick answers 'invalid-event'; and
// every door that reads a state refuses one holding a screening tick ('invalid-state'), whatever platform it claims, as
// it refuses held text (upload-doors.typed.test.ts). Synthetic values only.
import { describe, expect, it } from 'vitest';
import { uploadSavePlanJson, uploadStepJson, uploadViewJson } from './entry';
import { uploadSaveRun } from './upload-save-door';

const NOW = '2026-11-02T00:00:00.000Z';
const extraction = {
  classification: 'scan_result', reportDate: null, unrecognized: [], values: [], additionalValues: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: '2026-10-20', contentMarkdown: 'Synthetic', metadata: { screeningType: 'colorectal' } },
};
const choices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const state = (platform: string, ticked = false) => JSON.stringify({
  phase: 'open', platform, run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false },
    status: { s: 'read', extraction, choices: ticked ? { ...choices, document: { screening: true } } : choices } }],
});
const reason = (json: string) => JSON.parse(json).reason;

describe('US-13 AC6: the phone never holds a screening tick', () => {
  it('a screening change answers invalid-event at the step door', () => {
    const answer = uploadStepJson(state('phone'), JSON.stringify({ type: 'chose', id: 'f', now: NOW, change: { document: { screening: true } } }), '', 'phone');
    expect(reason(answer)).toBe('invalid-event');
  });

  it('a state holding a screening tick is refused by the step, view, plan and save doors, on either platform', async () => {
    for (const platform of ['phone', 'web']) {
      expect(reason(uploadStepJson(state(platform, true), JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
      expect(reason(uploadViewJson(state(platform, true), '', NOW, false, 'phone'))).toBe('invalid-state');
      expect(reason(uploadSavePlanJson(state(platform, true), '', NOW, false, 'phone'))).toBe('invalid-state');
      const out = await uploadSaveRun(JSON.stringify({ ...JSON.parse(state(platform, true)), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
      expect(reason(out)).toBe('invalid-state');
    }
  });

  it('a phone letter with a screening type saves with no screening date', async () => {
    const out = JSON.parse(await uploadSaveRun(JSON.stringify({ ...JSON.parse(state('phone')), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null));
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.record).screenings.colorectalLastDate).toBeUndefined();
    expect(out.outcome.screenings).toBeUndefined();
  });
});

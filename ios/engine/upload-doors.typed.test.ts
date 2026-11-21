// US-13 AC12 (web list PR 1b): text typed into a row is the web's alone. The step door takes only the phone's changes
// (health-core PHONE_CHANGE), so a typed change answers 'invalid-event'; and every door that reads a state refuses one
// holding held text ('invalid-state'), whatever platform it claims. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { uploadSavePlanJson, uploadStepJson, uploadViewJson } from './entry';
import { uploadSaveRun } from './upload-save-door';

const NOW = '2026-11-02T00:00:00.000Z';
const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null, additionalValues: [],
  values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
};
const choices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const state = (platform: string, held = false) => JSON.stringify({
  phase: 'open', platform, run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false },
    status: { s: 'read', extraction, choices: held ? { ...choices, typed: { v0: { text: 'abc', unit: 'si' } } } : choices } }],
});
const reason = (json: string) => JSON.parse(json).reason;

describe('US-13 AC12: the phone never holds typed text', () => {
  it('a typed change answers invalid-event at the step door', () => {
    const answer = uploadStepJson(state('phone'), JSON.stringify({ type: 'chose', id: 'f', now: NOW, change: { typed: 'v0', text: 'abc', unit: 'si' } }), '', 'phone');
    expect(reason(answer)).toBe('invalid-event');
  });

  it('a state holding typed text is refused by the step, view, plan and save doors, on either platform', async () => {
    for (const platform of ['phone', 'web']) {
      expect(reason(uploadStepJson(state(platform, true), JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
      expect(reason(uploadViewJson(state(platform, true), '', NOW, false, 'phone'))).toBe('invalid-state');
      expect(reason(uploadSavePlanJson(state(platform, true), '', NOW, false, 'phone'))).toBe('invalid-state');
      const out = await uploadSaveRun(JSON.stringify({ ...JSON.parse(state(platform, true)), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
      expect(reason(out)).toBe('invalid-state');
    }
  });

  it('a phone state without held text still runs', () => {
    expect(JSON.parse(uploadViewJson(state('phone'), '', NOW, false, 'phone')).save).toBeDefined();
  });
});

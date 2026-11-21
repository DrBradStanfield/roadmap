// US-13 AC12 (web list PR 1): text typed into a row (`typed`, held while it is no number) is the web's alone. The phone's
// step door refuses the change ('invalid-event'), and every door that reads a state refuses a phone state holding one
// ('invalid-state'), as for the web's column day (upload-doors.column-day.test.ts). The phone's `{edit}` runs as before.
import { describe, expect, it } from 'vitest';
import { uploadSavePlanJson, uploadStepJson, uploadViewJson } from './entry';
import { uploadSaveRun } from './upload-save-door';

const NOW = '2026-11-02T00:00:00.000Z';
const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null, additionalValues: [],
  values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
};
const choices = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const state = (more: object = {}) => ({
  phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: { ...choices, ...more } } }],
});
const chose = (change: unknown) => JSON.parse(uploadStepJson(JSON.stringify(state()), JSON.stringify({ type: 'chose', id: 'f', now: NOW, change }), '', 'phone'));
const refusal = (json: string) => JSON.parse(json).reason;

describe('US-13 AC12: the phone door refuses typed text', () => {
  it('a typed change answers invalid-event, whatever its text', () => {
    for (const text of ['abc', '3.4', '']) expect(chose({ typed: 'v0', text, unit: 'si' }), text).toMatchObject({ ok: false, reason: 'invalid-event' });
  });

  it('the phone\'s edit still runs as before', () => {
    expect(chose({ edit: 'v0', value: 3.4 }).state.files[0].status.choices).toEqual({ ...choices, edits: { v0: 3.4 } });
  });

  it('a state holding typed text is refused at the step, view, save plan and save doors', async () => {
    const holding = JSON.stringify(state({ typed: { v0: 'abc' } }));
    expect(refusal(uploadStepJson(holding, JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
    expect(refusal(uploadViewJson(holding, '', NOW, false, 'phone'))).toBe('invalid-state');
    expect(refusal(uploadSavePlanJson(holding, '', NOW, false, 'phone'))).toBe('invalid-state');
    const out = await uploadSaveRun(JSON.stringify({ ...JSON.parse(holding), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
    expect(JSON.parse(out).reason).toBe('invalid-state');
  });
});

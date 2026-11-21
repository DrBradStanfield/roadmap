// US-13 AC24: the web's dated previous column's day (`columnDay`) never runs on the iPhone. The step
// door takes only the changes the phone's page makes (health-core PHONE_CHANGE), so a column day
// answers 'invalid-event'; and every door that reads a state refuses a phone state that holds one
// ('invalid-state'), so none can run. The phone's own changes still run.
import { describe, expect, it } from 'vitest';
import { uploadSavePlanJson, uploadStepJson, uploadViewJson } from './entry';
import { uploadSaveRun } from './upload-save-door';

const NOW = '2026-11-02T00:00:00.000Z';
const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null, additionalValues: [],
  values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', recordedAt: '2026-05-01' }],
};
const state = {
  phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false },
    status: { s: 'read', extraction, choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } } }],
};
const chose = (change: unknown) => JSON.parse(uploadStepJson(JSON.stringify(state), JSON.stringify({ type: 'chose', id: 'f', now: NOW, change }), '', 'phone'));

describe('US-13 AC24: the phone door refuses a column day', () => {
  it('a column day, set or cleared, answers invalid-event', () => {
    for (const change of [{ columnDay: '2026-05-01', day: '2026-05-02' }, { columnDay: '2026-05-01', day: null }, { columnDay: '2026-05-01', day: 'partial:2026::' }]) {
      expect(chose(change), JSON.stringify(change)).toMatchObject({ ok: false, reason: 'invalid-event' });
    }
  });

  it('the phone\'s own changes still run', () => {
    const answer = chose({ tick: 'v0', on: false });
    expect(answer.state.files[0].status.choices).toEqual({ ticks: { v0: false }, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} });
  });
});

describe('US-13 AC24: no phone state holding a column day runs (PR 1926 R1)', () => {
  const holding = (platform: string) => JSON.stringify({ ...state, platform, files: [{ ...state.files[0], status: { ...state.files[0].status, choices: { ...state.files[0].status.choices, columnDays: { '2026-05-01': '2026-05-02' } } } }] });
  const refusal = (json: string) => JSON.parse(json).reason;

  it('the step, view and save plan doors answer invalid-state', () => {
    expect(refusal(uploadStepJson(holding('phone'), JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
    expect(refusal(uploadViewJson(holding('phone'), '', NOW, false, 'phone'))).toBe('invalid-state');
    expect(refusal(uploadSavePlanJson(holding('phone'), '', NOW, false, 'phone'))).toBe('invalid-state');
  });

  it('the save door refuses it too', async () => {
    const saving = JSON.parse(holding('phone'));
    const out = await uploadSaveRun(JSON.stringify({ ...saving, phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
    expect(JSON.parse(out).reason).toBe('invalid-state');
  });

  it('a state claiming the web\'s platform is refused at the phone\'s doors too (PR 1926 R3)', async () => {
    expect(refusal(uploadStepJson(holding('web'), JSON.stringify({ type: 'stop' }), '', 'phone'))).toBe('invalid-state');
    expect(refusal(uploadViewJson(holding('web'), '', NOW, false, 'phone'))).toBe('invalid-state');
    expect(refusal(uploadSavePlanJson(holding('web'), '', NOW, false, 'phone'))).toBe('invalid-state');
    const out = await uploadSaveRun(JSON.stringify({ ...JSON.parse(holding('web')), phase: 'saving', attempt: 1 }), '', '', NOW, 'phone', '{}', () => null);
    expect(JSON.parse(out).reason).toBe('invalid-state');
  });

  it('a phone state without one still runs', () => {
    expect(JSON.parse(uploadViewJson(JSON.stringify(state), '', NOW, false, 'phone')).save).toBeDefined();
  });
});

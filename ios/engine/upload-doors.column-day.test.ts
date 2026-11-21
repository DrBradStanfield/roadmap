// US-13 AC24: the web's dated previous column's day (`columnDay`) never runs on the iPhone. The step
// door takes only the changes the phone's page makes (health-core PHONE_CHANGE), so a column day
// answers 'invalid-event' and no phone state can hold one; the phone's own changes still run.
import { describe, expect, it } from 'vitest';
import { uploadStepJson } from './entry';

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

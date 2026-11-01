// US-65 (Brad 2026-11-01): the iPhone opens a record holding entries this
// engine cannot read. Before, one unknown metric or a height that was a word
// threw the whole screen call, and the person saw none of their record.
// Synthetic values only.
import { describe, expect, it } from 'vitest';
import { applyEditJson, chatContextJson, healthWritesJson, historyJson, labSaveSummaryJson, newRecordJson, planJson, remindersJson, screenJson } from './entry';
import { unitsOf } from './unit-choices';

const NOW = '2026-11-01T00:00:00.000Z';
const DAY = '2026-10-01T00:00:00Z';
const base = JSON.parse(newRecordJson(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'));
const weight = { id: 'm1', metricType: 'weight', value: 80, recordedAt: DAY, createdAt: DAY, source: 'manual', status: 'active', correctsId: null, externalId: null };
const future = { ...weight, id: 'm2', metricType: 'synthetic_future_metric' };
const profile = { ...base.profile, sex: 'male', birthYear: 1980, heightCm: 180 };

describe('US-65: the engine opens a record with unreadable entries', () => {
  for (const [name, record, count] of [
    ['an unknown metric row', { ...base, profile, measurements: [weight, future] }, 1],
    ['a value that is a word', { ...base, profile, measurements: [weight, { ...weight, id: 'm3', value: 'synthetic' }] }, 1],
    ['a height that is a word', { ...base, profile: { ...profile, heightCm: 'synthetic' }, measurements: [weight] }, 1],
  ] as const) {
    it(`${name}: My data shows the readable rows and one line with the count`, () => {
      const screen = JSON.parse(screenJson(JSON.stringify(record), NOW, 'phone'));
      const weightRow = screen.myData.vitals.find((row: { metric: string }) => row.metric === 'weight');
      expect(weightRow.latest.value).toBe('80.0');
      expect(screen.myData.unreadableNote).toBe(`${count} entry in your record could not be read, so it is kept unchanged and not shown.`);
    });
  }

  it('an edit returns a record that still holds the unreadable row verbatim', () => {
    const record = { ...base, profile, measurements: [weight, future] };
    const out = JSON.parse(applyEditJson(JSON.stringify(record), JSON.stringify({ kind: 'add', metric: 'weight', value: 81, day: '2026-10-31' }), NOW, 'phone'));
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.record).measurements).toContainEqual(future);
  });

  it('plan, history and chat context skip them', () => {
    const record = JSON.stringify({ ...base, profile: { ...profile, lpaUnit: 'synthetic' }, measurements: [weight, future, { ...weight, id: 'm3', value: 'synthetic' }] });
    for (const read of [
      () => planJson(record, NOW, 'phone'), () => historyJson(record, 'weight', NOW, 'phone'), () => chatContextJson(record, NOW, 'phone'),
    ]) expect(read()).not.toContain('synthetic');
  });

  it('reminders are due as if a hidden LDL were not there', () => {
    const hidden = JSON.stringify({ ...base, profile, measurements: [weight, { ...weight, id: 'l1', metricType: 'ldl', value: 'synthetic' }] });
    const clean = JSON.stringify({ ...base, profile, measurements: [weight] });
    expect(remindersJson(hidden, NOW, 'phone')).toBe(remindersJson(clean, NOW, 'phone'));
  });

  it('Health writes follow a correction back through a hidden Apple Health row, so nothing is written', () => {
    // h1 came from Apple Health and is hidden (its externalId is a number); w2 corrects it by hand.
    const h1 = { ...weight, id: 'h1', source: 'apple_health', status: 'entered-in-error', externalId: 5 };
    const w2 = { ...weight, id: 'w2', value: 81, source: 'manual_correction', correctsId: 'h1', createdAt: '2026-10-02T00:00:00Z' };
    expect(JSON.parse(healthWritesJson(JSON.stringify({ ...base, profile, measurements: [h1, w2] }), NOW, 'phone'))).toEqual([]);
  });

  it('the lab receipt counts what the save writes: a hidden active row holds its day', () => {
    const extraction = { classification: 'lab_report', reportDate: '2026-10-01', values: [
      { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
    ], additionalValues: [] };
    const record = JSON.stringify({ ...base, profile, measurements: [weight, { ...weight, id: 'l1', metricType: 'ldl', value: 'synthetic' }] });
    const receipt = JSON.parse(labSaveSummaryJson(record, JSON.stringify(extraction), JSON.stringify(['v0']), '2026-10-01', NOW, 'phone'));
    const saved = JSON.parse(applyEditJson(record, JSON.stringify({ kind: 'labImport', extractionJson: JSON.stringify(extraction), refs: ['v0'], reportDay: '2026-10-01' }), NOW, 'phone'));
    const ldlRows = saved.ok ? JSON.parse(saved.record).measurements.filter((m: { metricType: string }) => m.metricType === 'ldl').length : 1;
    expect(receipt.summary.saved).toBe(ldlRows - 1);
  });

  it('an unreadable unit system reads as metric for screens and for writes alike', () => {
    const record = JSON.stringify({ ...base, profile: { ...profile, unitSystem: 'synthetic' }, measurements: [weight] });
    expect(JSON.parse(screenJson(record, NOW, 'phone')).myData.unitSystem).toBe('si');
    const out = JSON.parse(applyEditJson(record, JSON.stringify({ kind: 'add', metric: 'weight', value: 81, day: '2026-10-31' }), NOW, 'phone'));
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.record).measurements.find((m: { value: number }) => m.value === 81)).toBeTruthy();
    expect(unitsOf(JSON.parse(out.record))).toBe('si'); // the cloud path's units check (cloud.ts) reads this
  });

  it('a lab name that is a number, a cleared height and a hidden document still open My data', () => {
    const lab = { id: 'x1', metricName: 5, value: 1, unit: 'g/L', referenceLow: null, referenceHigh: null, recordedAt: DAY, createdAt: DAY, source: 'manual', status: 'active', correctsId: null };
    const doc = { id: 'd1', title: 'Synthetic', type: 7, date: null, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: DAY };
    const record = JSON.stringify({ ...base, profile: { ...profile, heightCm: null }, measurements: [weight], labValues: [lab], documents: [doc] });
    const screen = JSON.parse(screenJson(record, NOW, 'phone'));
    expect(screen.myData.profile.height).toBeNull();
    expect(screen.myData.unreadableNote).toBe('2 entries in your record could not be read, so they are kept unchanged and not shown.');
  });

  it('a readable record carries no line', () => {
    const screen = JSON.parse(screenJson(JSON.stringify({ ...base, profile, measurements: [weight] }), NOW, 'phone'));
    expect(screen.myData.unreadableNote).toBeNull();
  });
});

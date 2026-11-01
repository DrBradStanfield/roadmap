// US-65 (Brad 2026-11-01): the iPhone opens a record holding entries this
// engine cannot read. Before, one unknown metric or a height that was a word
// threw the whole screen call, and the person saw none of their record.
// Synthetic values only.
import { describe, expect, it } from 'vitest';
import { applyEditJson, chatContextJson, healthWritesJson, historyJson, newRecordJson, planJson, remindersJson, screenJson } from './entry';

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

  it('every other reader skips them too: plan, history, chat context, Health writes, reminders', () => {
    const record = JSON.stringify({ ...base, profile: { ...profile, lpaUnit: 'synthetic' }, measurements: [weight, future, { ...weight, id: 'm3', value: 'synthetic' }] });
    for (const read of [
      () => planJson(record, NOW, 'phone'), () => historyJson(record, 'weight', NOW, 'phone'), () => chatContextJson(record, NOW, 'phone'),
      () => healthWritesJson(record, NOW, 'phone'), () => remindersJson(record, NOW, 'phone'),
    ]) expect(read()).not.toContain('synthetic');
  });

  it('a readable record carries no line', () => {
    const screen = JSON.parse(screenJson(JSON.stringify({ ...base, profile, measurements: [weight] }), NOW, 'phone'));
    expect(screen.myData.unreadableNote).toBeNull();
  });
});

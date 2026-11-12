// US-06 AC21 item 6 (Brad 2026-11-13, option a): one boolean on the newest PSA point,
// `raisedBefore`, "an earlier PSA was 4.0 or above", worked out once from the full record.
// Every chat surface's rule takes it from the point; none works it out from its own trimmed
// series, and no earlier PSA value or date leaves the device. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { buildMeasurementHistory, HISTORY_CAP_PER_METRIC, planPsa } from './measurement-history';
import type { Comparator } from './lab-limits';

const NOW = new Date('2026-11-12T12:00:00Z');
type Row = { id: string; metricType: string; value: number; recordedAt: string; createdAt: string; comparator?: Comparator };
const psa = (i: number, value: number, day: string, comparator?: Comparator): Row =>
  ({ id: `p${String(i).padStart(3, '0')}`, metricType: 'psa', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, ...(comparator && { comparator }) });
/** `n` vague "< 5" results, one a week from 2025-01-01. */
const vague = (n: number) => Array.from({ length: n }, (_, i) =>
  psa(i + 1, 5, new Date(Date.UTC(2025, 0, 1 + 7 * i)).toISOString().slice(0, 10), '<'));
const RAISED = psa(0, 4.5, '2024-06-01');
const newestPoint = (rows: Row[]) => buildMeasurementHistory(rows, HISTORY_CAP_PER_METRIC, NOW).psa?.at(-1);

describe('the fact, by history shape (US-06 AC21 item 6)', () => {
  it.each<[string, Row[], boolean | undefined]>([
    ['raised, then 1 vague', [RAISED, ...vague(1)], true],
    ['raised, then 24 vague', [RAISED, ...vague(24)], true],
    ['raised, then 25 vague (the raised one is past the cap)', [RAISED, ...vague(25)], true],
    ['raised, then a deciding low', [RAISED, psa(1, 3.0, '2025-02-01')], false],
    ['raised, then "<= 4.0" (allows exactly 4.0): holds', [RAISED, psa(1, 4.0, '2025-02-01', '<=')], true],
    ['raised, then "< 4.0": ends', [RAISED, psa(1, 4.0, '2025-02-01', '<')], false],
    ['a newest raised PSA (the rule holds by its value; no flag)', [psa(1, 3.0, '2024-01-01', '<'), RAISED], false],
    ['no PSA', [], undefined],
  ])('%s', (_shape, rows, flag) => {
    const point = newestPoint(rows);
    expect(point === undefined ? undefined : point.raisedBefore === true).toBe(flag);
    // The one rule: the plan's own PSA says the same.
    expect(planPsa(rows, NOW)?.raisedBefore === true).toBe(flag === true);
  });
});

describe('the chat takes the flag, never works it out (US-06 AC21 item 6)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const man = (answer: string) => ({
    inputs: { sex: 'male' as const, heightCm: 178, weightKg: 80, birthYear: 1962, birthMonth: 1 },
    screenings: [{ id: 's', screeningKey: 'prostate_discussion', value: answer, updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  const prostateIds = (payload: unknown) =>
    (JSON.parse(buildChatContextJson(payload)!).currentSuggestions as Array<{ id: string }>).map(s => s.id).filter(id => id.startsWith('screening-prostate'));

  it('the widget and iPhone chatContextOf, raised then 25 vague: the payload carries the flag and the server gives "Repeat PSA test"', () => {
    const { inputs, screenings } = man('elected_not_to');
    const payload = chatContextOf(inputs, 'si', [], screenings as never, [RAISED, ...vague(25)]);
    expect(payload.measurementHistory!.psa.at(-1)!.raisedBefore).toBe(true);
    expect(prostateIds(payload)).toEqual(['screening-prostate-repeat']);
  });

  it('carries no earlier PSA value or date: the anchor reading is not added, only the one key', () => {
    const { inputs, screenings } = man('elected_not_to');
    const rows = [RAISED, ...vague(25)];
    const payload = chatContextOf(inputs, 'si', [], screenings as never, rows);
    const series = payload.measurementHistory!.psa;
    // The same 24 newest points as before, by date and value.
    expect(series.map(p => [p.date, p.value, p.comparator])).toEqual(
      rows.slice(-HISTORY_CAP_PER_METRIC).map(r => [r.recordedAt.slice(0, 10), r.value, r.comparator]));
    expect(JSON.stringify(payload)).not.toContain('2024-06-01');
    expect(series.some(p => p.value === 4.5)).toBe(false);
    expect(series.slice(0, -1).every(p => !('raisedBefore' in p))).toBe(true);
    expect(Object.keys(series.at(-1)!).sort()).toEqual(['comparator', 'date', 'raisedBefore', 'value']);
  });

  it('a payload whose series holds the raised PSA but no flag: no rule (the series is not read for it)', () => {
    const { inputs, screenings } = man('elected_not_to');
    const payload = chatContextOf(inputs, 'si', [], screenings as never, [RAISED, ...vague(1)]);
    delete payload.measurementHistory!.psa.at(-1)!.raisedBefore;
    expect(prostateIds(payload)).toEqual([]);
  });

  it.each([['the text "true"', 'true'], ['1', 1], ['false', false]])('a flag sent as %s is no flag', (_what, flag) => {
    const { inputs, screenings } = man('elected_not_to');
    const payload = chatContextOf(inputs, 'si', [], screenings as never, [psa(1, 5, '2026-06-01', '<')]);
    (payload.measurementHistory!.psa[0] as unknown as Record<string, unknown>).raisedBefore = flag;
    expect(prostateIds(payload)).toEqual([]);
    expect(JSON.parse(buildChatContextJson(payload)!).measurementHistory.psa[0]).not.toHaveProperty('raisedBefore');
  });

  it('a flag on a PSA that decides below 4.0 ("< 2") does not hold the rule', () => {
    const { inputs, screenings } = man('elected_not_to');
    const payload = chatContextOf(inputs, 'si', [], screenings as never, [psa(1, 2, '2026-06-01', '<')]);
    payload.measurementHistory!.psa[0].raisedBefore = true;
    expect(prostateIds(payload)).toEqual([]);
  });
});

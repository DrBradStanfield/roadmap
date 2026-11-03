/**
 * US-06 AC17 and AC18 (Brad 2026-11-03): a raised PSA.
 *
 * AC17: with "Elevated PSA" on the plan, the prostate card no longer also says
 * "PSA test up to date. Next PSA test due …": the two read as contradictory.
 * An overdue card still shows.
 *
 * AC18: a PSA graded above 4.0 never prints as 4.0. PSA prints to one decimal,
 * so 4.04 ng/mL read "Your PSA of 4.0 ng/mL is above the typical reference
 * range (≤4.0)". It now prints two decimals there, as HbA1c's 6.45 % does
 * (US-07 AC15). A limit still prints as printed (US-12 AC20).
 */
import { describe, expect, it } from 'vitest';
import { computePlan, planPayload } from './plan';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import { formatGradedReading } from './units';
import type { Comparator } from './lab-limits';

const NOW = new Date('2026-11-03T12:00:00.000Z');

function fileWith(psa: { value: number; day: string; comparator?: Comparator }, discussion = 'will_screen'): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_raised', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, prostateDiscussion: discussion } as RoadmapFile['screenings'],
    measurements: [createMeasurement({
      id: 'p0', metricType: 'psa', value: psa.value, recordedAt: `${psa.day}T00:00:00.000Z`, createdAt: `${psa.day}T00:00:00.000Z`,
      ...(psa.comparator ? { comparator: psa.comparator } : {}),
    })],
  };
}

const prostate = (file: RoadmapFile) =>
  computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith('screening-prostate'));
const ids = (file: RoadmapFile) => prostate(file).map((s) => s.id);
const elevatedText = (file: RoadmapFile) => prostate(file).find((s) => s.id === 'screening-prostate-elevated')?.description;

describe('US-06 AC17: no "PSA test up to date" beside "Elevated PSA" (Brad 2026-11-03)', () => {
  it('a raised PSA this month shows Elevated PSA alone', () => {
    expect(ids(fileWith({ value: 4.04, day: '2026-10-01' }))).toEqual(['screening-prostate-elevated']);
    expect(ids(fileWith({ value: 9.5, day: '2026-10-01' }))).toEqual(['screening-prostate-elevated']);
  });

  it('a limit graded raised ("> 100") hides it too', () => {
    expect(ids(fileWith({ value: 100, day: '2026-10-01', comparator: '>' }))).toEqual(['screening-prostate-elevated']);
  });

  it('an overdue PSA test still shows beside Elevated PSA', () => {
    expect(ids(fileWith({ value: 6, day: '2025-06-01' })).sort()).toEqual(['screening-prostate-elevated', 'screening-prostate-overdue']);
  });

  it('controls: a PSA at or under 4.0, or a limit that does not decide, keeps "up to date"', () => {
    const upToDate = prostate(fileWith({ value: 4.0, day: '2026-10-01' }));
    expect(upToDate.map((s) => s.id)).toEqual(['screening-prostate-upcoming']);
    expect(upToDate[0]).toMatchObject({ title: 'PSA test up to date', description: 'Next PSA test due Oct 2027.' });
    expect(ids(fileWith({ value: 1.2, day: '2026-10-01' }))).toEqual(['screening-prostate-upcoming']);
    expect(ids(fileWith({ value: 5, day: '2026-10-01', comparator: '<' }))).toEqual(['screening-prostate-upcoming']);
  });
});

describe('US-06 AC18: a raised PSA prints on its side of 4.0 (Brad 2026-11-03)', () => {
  it('the Elevated PSA card says 4.04, not 4.0', () => {
    expect(elevatedText(fileWith({ value: 4.04, day: '2026-10-01' }))).toBe(
      'Your PSA of 4.04 ng/mL is above the typical reference range (≤4.0). Discuss with your doctor — elevated PSA can have multiple causes.');
  });

  it('two decimals only where one would read 4.0; rounded up, so never at or under the line', () => {
    expect(formatGradedReading('psa', 4.04, 'si')).toBe('4.04');
    expect(formatGradedReading('psa', 4.01, 'si')).toBe('4.01');
    expect(formatGradedReading('psa', 4.001, 'si')).toBe('4.01');
    expect(formatGradedReading('psa', 4.049, 'si')).toBe('4.05');
    // 4.05 is 4.0499… in binary, so one decimal read 4.0.
    expect(formatGradedReading('psa', 4.05, 'si')).toBe('4.05');
    // Away from the line, and at or under it, one decimal as before.
    expect(formatGradedReading('psa', 4.06, 'si')).toBe('4.1');
    expect(formatGradedReading('psa', 6.53, 'si')).toBe('6.5');
    expect(formatGradedReading('psa', 4.0, 'si')).toBe('4.0');
    expect(formatGradedReading('psa', 3.96, 'si')).toBe('4.0');
    expect(formatGradedReading('psa', 1.23, 'si')).toBe('1.2');
  });

  it('other cards keep their one decimal', () => {
    expect(elevatedText(fileWith({ value: 6.53, day: '2026-10-01' }))).toContain('Your PSA of 6.5 ng/mL');
  });

  it('a limit prints as printed (US-12 AC20)', () => {
    expect(elevatedText(fileWith({ value: 100, day: '2026-10-01', comparator: '>' }))).toContain('Your PSA of > 100.0 ng/mL');
  });

  it("get_plan's currentValues prints the same number as the card", () => {
    const value = planPayload(computePlan(fileWith({ value: 4.04, day: '2026-10-01' }), NOW)).currentValues.find((v) => v.metric === 'psa')?.value;
    expect(value).toBe('4.04');
  });
});

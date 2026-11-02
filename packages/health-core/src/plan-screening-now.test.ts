/**
 * US-31 AC11: a plan measures against the day it is given. `computePlan(file, now)`
 * took `now` for the age and the due list, but the screening cards read the wall
 * clock, so the same file at the same `now` could say "up to date" in one run and
 * "overdue" in a later one. The wall clock is pinned far from `now` here, so a
 * card that reads it shows up whatever day the suite runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computePlan } from './plan';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const NOW = new Date('2020-06-15T12:00:00Z');
const WALL_CLOCK = new Date('2030-06-15T12:00:00Z');

function fileWith(screenings: Record<string, unknown>): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'plan_screening_now', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, birthYear: 1960, birthMonth: 1 },
    screenings: { ...f.screenings, ...screenings } as RoadmapFile['screenings'],
  };
}

function screeningIds(file: RoadmapFile): string[] {
  return computePlan(file, NOW).results.suggestions.filter((s) => s.category === 'screening').map((s) => s.id);
}

describe('screening cards measure against the plan’s now (US-31 AC11)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(WALL_CLOCK);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a FIT done in January 2020 is not yet due in June 2020', () => {
    const ids = screeningIds(fileWith({ colorectalMethod: 'fit_annual', colorectalLastDate: '2020-01' }));
    expect(ids).toContain('screening-colorectal-upcoming');
    expect(ids).not.toContain('screening-colorectal-overdue');
  });

  it('a FIT done in January 2019 is overdue in June 2020', () => {
    vi.setSystemTime(new Date('2019-02-01T12:00:00Z'));
    const ids = screeningIds(fileWith({ colorectalMethod: 'fit_annual', colorectalLastDate: '2019-01' }));
    expect(ids).toContain('screening-colorectal-overdue');
  });

  it('the repeat after a completed follow-up is dated from now too', () => {
    const file = fileWith({
      colorectalMethod: 'fit_annual',
      colorectalLastDate: '2019-06',
      colorectalResult: 'abnormal',
      colorectalFollowupStatus: 'completed',
      colorectalFollowupDate: '2020-03',
    });
    const card = computePlan(file, NOW).results.suggestions.find((s) => s.id === 'screening-colorectal-followup');
    expect(card?.title).toBe('Colorectal screening up to date');
  });
});

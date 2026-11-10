// A2-1 golden pin: today's screening behaviour across its five copies (suggestions.ts, input-form.ts,
// reminder-schedule.ts, types.ts, and the web JSX the form mirrors), taken before the rules move into
// one table. Every later move must leave screening-rules.golden.json untouched.
//
// The golden is taken in Pacific/Auckland, like the blood table's: due dates are local months.
// Pinned here so CI, which runs in UTC, reads the same days (a forks child picks the zone up; see
// vitest.config.ts). The clock is faked too: the mapping reads Date.now() to drop a future "last done" date.
//
// Regenerate (only when a behaviour change is intended and approved):
//   cd packages/health-core && UPDATE_SCREENING_GOLDEN=1 npx vitest run src/screening-rules.golden.test.ts
process.env.TZ = 'Pacific/Auckland';

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GOLDEN_NOW, screeningGolden } from './screening-rules.fixtures';

const PATH = `${__dirname}/screening-rules.golden.json`;

describe('US-06, US-07, US-17: A2-1 golden pin of the screening rules', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: GOLDEN_NOW });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  // Built once inside the faked clock, compared section by section.
  let actual: ReturnType<typeof screeningGolden>;
  let golden: ReturnType<typeof screeningGolden>;
  beforeAll(() => {
    actual = JSON.parse(JSON.stringify(screeningGolden((d) => vi.setSystemTime(d))));
    if (process.env.UPDATE_SCREENING_GOLDEN) writeFileSync(PATH, `${JSON.stringify(actual, null, 1)}\n`);
    golden = JSON.parse(readFileSync(PATH, 'utf8'));
  });

  it('A2-1 golden pin: the clock, zone and case count are the golden\'s', () => {
    expect(actual.meta).toEqual(golden.meta);
  });

  it('A2-1 golden pin, US-06: SCREENING_MIN_AGE, the intervals, the options and GROUP_COOLDOWNS are unchanged', () => {
    expect(actual.constants).toEqual(golden.constants);
  });

  it('A2-1 golden pin, US-06: isScreeningEligible (the upload gate) says yes at the same ages', () => {
    expect(actual.eligibility).toEqual(golden.eligibility);
  });

  it('A2-1 golden pin, US-06: screeningWrites clears the same answers for every change', () => {
    expect(Object.keys(actual.writes)).toEqual(Object.keys(golden.writes));
    for (const [name, row] of Object.entries(golden.writes)) expect(actual.writes[name], name).toEqual(row);
  });

  it('A2-1 golden pin, US-07: the plan words every screening card the same', () => {
    expect(actual.cards).toEqual(golden.cards);
  });

  it('A2-1 golden pin, US-06: screeningForm shows the same sections, groups, fields, notes and options', () => {
    expect(Object.keys(actual.groups)).toEqual(Object.keys(golden.groups));
    for (const [id, lines] of Object.entries(golden.groups)) expect(actual.groups[id], id).toEqual(lines);
    expect(Object.keys(actual.forms)).toEqual(Object.keys(golden.forms));
    for (const [id, lines] of Object.entries(golden.forms)) expect(actual.forms[id], id).toEqual(lines);
  });

  it('A2-1 golden pin, US-07 and US-17: every case gives the same cards, reminder items, follow-ups and form', () => {
    expect(Object.keys(actual.cases)).toEqual(Object.keys(golden.cases));
    for (const [name, out] of Object.entries(golden.cases)) expect(actual.cases[name], name).toEqual(out);
  });
});

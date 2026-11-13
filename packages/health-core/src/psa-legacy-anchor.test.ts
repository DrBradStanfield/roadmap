// US-06 AC14 + AC21 item 6: the old answers (`prostatePsaValue` with `prostateLastDate`) are a PSA
// the plan reads, so the 3-month rule's chronology reads them too. A raised old answer followed by
// a newer vague limit ("< 5") keeps the rule; a newer deciding result ends or takes it over, as a
// row would. Plan, reminders and chat read the one answer (`planPsa`, `buildMeasurementHistory`).
// Synthetic records only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computePlan } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { currentValueRows } from './blood-tests';
import { fileScreeningRows } from './file-inputs';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { Comparator } from './lab-limits';

const NOW = new Date('2026-11-12T12:00:00Z');
const CARRIED = 'An earlier PSA was 4.0 or higher';

type Row = { value: number; day: string; comparator?: Comparator };
type Answers = { prostatePsaValue?: string; prostateLastDate?: string; prostateDiscussion?: 'not_yet' | 'elected_not_to' | 'will_screen' };
const VAGUE: Row = { value: 5, day: '2026-06-01', comparator: '<' };

/** A man born 1966 who declined routine screening, with PSA rows and the old answers. */
function fileWith(rows: Row[], answers: Answers): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_legacy', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, prostateDiscussion: 'elected_not_to', ...answers } as RoadmapFile['screenings'],
    measurements: rows.map((r, i) => createMeasurement({
      id: `p${i}`, metricType: 'psa', value: r.value, recordedAt: `${r.day}T00:00:00.000Z`, createdAt: `${r.day}T00:00:00.000Z`,
      ...(r.comparator ? { comparator: r.comparator } : {}),
    })),
  };
}
const cards = (file: RoadmapFile) =>
  computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith('screening-prostate'));
const reminders = (file: RoadmapFile) =>
  computeReminderSchedule(file, NOW).filter((i) => i.category === 'screening_prostate').map((i) => i.dueAt);

const LEGACY_RAISED: Answers = { prostatePsaValue: '6.5', prostateLastDate: '2026-03' };

describe('the finding: a raised old answer, then a newer vague result (US-06 AC21 item 6)', () => {
  const file = fileWith([VAGUE], LEGACY_RAISED);

  it('plan: "Repeat PSA test" with the carried sentence', () => {
    expect(cards(file)).toEqual([
      expect.objectContaining({ id: 'screening-prostate-repeat', description: expect.stringContaining(CARRIED) }),
    ]);
  });

  it('reminders: 3 months after the newer test', () => {
    expect(reminders(file)).toEqual(['2026-09-01']);
  });

  describe('chat', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    it('the iPhone and widget payload carries the flag, and the chat plan gives "Repeat PSA test"', () => {
      const p = file.profile;
      const payload = chatContextOf(
        { sex: 'male', heightCm: p.heightCm!, weightKg: 75, birthYear: 1966, birthMonth: 1 }, 'si', [],
        fileScreeningRows(file.screenings), currentValueRows(file),
      );
      expect(payload.measurementHistory!.psa.at(-1)!.raisedBefore).toBe(true);
      const ids = (JSON.parse(buildChatContextJson(payload)!).currentSuggestions as Array<{ id: string }>)
        .map((s) => s.id).filter((id) => id.startsWith('screening-prostate'));
      expect(ids).toEqual(['screening-prostate-repeat']);
    });
  });
});

describe('an old answer outside the PSA range decides nothing, as an unusable row (US-06 AC14; Codex R2)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  const flagSent = (file: RoadmapFile) => chatContextOf(
    { sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 }, 'si', [],
    fileScreeningRows(file.screenings), currentValueRows(file),
  ).measurementHistory!.psa.at(-1)!.raisedBefore === true;

  it.each([['-1 (below 0)', '-1'], ['10001 (above 10000)', '10001']])('raised row, answer %s, then vague: the raised row still anchors', (_what, value) => {
    const file = fileWith([{ value: 4.5, day: '2026-01-10' }, VAGUE], { prostatePsaValue: value, prostateLastDate: '2026-03' });
    expect(cards(file).map((c) => c.id)).toContain('screening-prostate-repeat');
    expect(reminders(file)).toEqual(['2026-09-01']);
    expect(flagSent(file)).toBe(true);
  });

  it('low row, answer 10001 (above 10000), then vague: the answer does not start the rule', () => {
    const file = fileWith([{ value: 3.0, day: '2026-01-10' }, VAGUE], { prostatePsaValue: '10001', prostateLastDate: '2026-03' });
    expect(cards(file)).toEqual([]);
    expect(reminders(file)).toEqual([]);
    expect(flagSent(file)).toBe(false);
  });

  it('an answer of 0 is in range and below 4.0: it ends the rule', () => {
    const file = fileWith([{ value: 4.5, day: '2026-01-10' }, VAGUE], { prostatePsaValue: '0', prostateLastDate: '2026-03' });
    expect(cards(file)).toEqual([]);
    expect(reminders(file)).toEqual([]);
    expect(flagSent(file)).toBe(false);
  });
});

describe('an out-of-range old answer keeps its date and loses its value: a date-only answer (US-06 AC14, Brad 2026-11-13)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });
  const RAISED_THEN_VAGUE: Row[] = [{ value: 4.5, day: '2026-01-10' }, VAGUE];
  const chatPlan = (file: RoadmapFile) => {
    const payload = chatContextOf(
      { sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 }, 'si', [],
      fileScreeningRows(file.screenings), currentValueRows(file),
    );
    return (JSON.parse(buildChatContextJson(payload)!).currentSuggestions as Array<{ id: string; description: string }>)
      .filter((s) => s.id.startsWith('screening-prostate'));
  };
  /** Plan, reminders and chat read `answers` exactly as they read the same answer with its date and no value. */
  const readsAsDateOnly = (rows: Row[], answers: Answers) => {
    const file = fileWith(rows, answers);
    const dateOnly = fileWith(rows, { ...answers, prostatePsaValue: undefined });
    expect(cards(file)).toEqual(cards(dateOnly));
    expect(reminders(file)).toEqual(reminders(dateOnly));
    expect(chatPlan(file)).toEqual(chatPlan(dateOnly));
  };

  it.each([['-1 (below 0)', '-1'], ['10001 (above 10000)', '10001']])('answer %s dated 2026-09, newer than the rows: read as the date alone', (_what, value) => {
    readsAsDateOnly(RAISED_THEN_VAGUE, { prostatePsaValue: value, prostateLastDate: '2026-09' });
    expect(JSON.stringify(chatPlan(fileWith(RAISED_THEN_VAGUE, { prostatePsaValue: value, prostateLastDate: '2026-09' })))).not.toContain(value);
  });

  it('no rows, a man who will screen, answer 10001 dated 2026-09: the date stands, so the next PSA is 12 months on', () => {
    const file = fileWith([], { prostateDiscussion: 'will_screen', prostatePsaValue: '10001', prostateLastDate: '2026-09' });
    expect(cards(file).map((c) => c.id)).toEqual(['screening-prostate-upcoming']);
    expect(reminders(file)).toEqual(['2027-09-01']);
    expect(chatPlan(file).map((s) => s.id)).toEqual(['screening-prostate-upcoming']);
    expect(JSON.stringify(cards(file))).not.toContain('10001');
  });

  it.each([['"10001" and 28 spaces', `10001${' '.repeat(28)}`], ['"10001" with 29 leading zeros', `${'0'.repeat(29)}10001`]])(
    'an answer longer than 32 characters, %s: plan, reminders and chat read the date alone', (_what, value) => {
      readsAsDateOnly(RAISED_THEN_VAGUE, { prostatePsaValue: value, prostateLastDate: '2026-09' });
    });

  it('the 10000 boundary: 10000 is in range and is the PSA read; 10000.1 is read as the date alone', () => {
    const atMax = fileWith(RAISED_THEN_VAGUE, { prostatePsaValue: '10000', prostateLastDate: '2026-09' });
    expect(cards(atMax).map((c) => c.id)).toContain('screening-prostate-elevated');
    expect(reminders(atMax)).toEqual(['2026-12-01']);
    expect(chatPlan(atMax).map((s) => s.id)).toContain('screening-prostate-elevated');
    readsAsDateOnly(RAISED_THEN_VAGUE, { prostatePsaValue: '10000.1', prostateLastDate: '2026-09' });
  });

  it('an answer of 0 dated 2026-09 is in range: it is the PSA read and ends the rule', () => {
    const file = fileWith(RAISED_THEN_VAGUE, { prostatePsaValue: '0', prostateLastDate: '2026-09' });
    expect(cards(file)).toEqual([]);
    expect(reminders(file)).toEqual([]);
    expect(chatPlan(file)).toEqual([]);
  });

  it('a valid answer newer than every row still wins: "Elevated PSA" reads 6.5, 3 months from it', () => {
    const file = fileWith(RAISED_THEN_VAGUE, { prostatePsaValue: '6.5', prostateLastDate: '2026-09' });
    expect(cards(file)).toContainEqual(expect.objectContaining({ id: 'screening-prostate-elevated', description: expect.stringContaining('6.5') }));
    expect(reminders(file)).toEqual(['2026-12-01']);
    expect(chatPlan(file).map((s) => s.id)).toContain('screening-prostate-elevated');
  });

  // US-06 AC21 (Brad 2026-11-13): a dated answer with no usable value does not show the PSA is below 4.0,
  // so it never ends the 3-month rule. Only a real value, in range and below 4.0, ends it.
  describe('a dated answer with no usable value, newer than a raised PSA, keeps the 3-month rule (US-06 AC21)', () => {
    const RAISED_ROW: Row[] = [{ value: 4.5, day: '2026-04-10' }];

    it.each([['no value', {}], ['10001 (out of range)', { prostatePsaValue: '10001' }]])(
      'declined, raised then vague, an answer with %s dated 2026-07: "Repeat PSA test", 3 months from the answer', (_what, extra) => {
        const file = fileWith(RAISED_THEN_VAGUE, { ...extra, prostateLastDate: '2026-07' });
        expect(cards(file)).toEqual([
          expect.objectContaining({ id: 'screening-prostate-repeat', description: expect.stringContaining(CARRIED) }),
        ]);
        expect(reminders(file)).toEqual(['2026-10-01']);
        expect(chatPlan(file).map((s) => s.id)).toEqual(['screening-prostate-repeat']);
      });

    it('declined, a raised row alone, then an answer with no value dated 2026-07: the rule holds, no "Elevated PSA"', () => {
      const file = fileWith(RAISED_ROW, { prostateLastDate: '2026-07' });
      expect(cards(file)).toEqual([
        expect.objectContaining({ id: 'screening-prostate-repeat', description: expect.stringContaining(CARRIED) }),
      ]);
      expect(reminders(file)).toEqual(['2026-10-01']);
      expect(chatPlan(file).map((s) => s.id)).toEqual(['screening-prostate-repeat']);
    });

    it('before the 3 months from the answer are up: no card yet, the reminder 3 months on', () => {
      const file = fileWith(RAISED_THEN_VAGUE, { prostateLastDate: '2026-09' });
      expect(cards(file)).toEqual([]);
      expect(reminders(file)).toEqual(['2026-12-01']);
      expect(chatPlan(file)).toEqual([]);
    });

    it('a man who will screen: 3 months from the answer, never "PSA test up to date"', () => {
      const upcoming = fileWith(RAISED_ROW, { prostateDiscussion: 'will_screen', prostateLastDate: '2026-09' });
      expect(cards(upcoming)).toEqual([]);
      expect(reminders(upcoming)).toEqual(['2026-12-01']);
      const overdue = fileWith(RAISED_ROW, { prostateDiscussion: 'will_screen', prostateLastDate: '2026-07' });
      expect(cards(overdue).map((c) => c.id)).toEqual(['screening-prostate-overdue']);
      expect(reminders(overdue)).toEqual(['2026-10-01']);
    });

    it('"not yet": the discussion card, then "Repeat PSA test" with no first sentence', () => {
      const file = fileWith(RAISED_ROW, { prostateDiscussion: 'not_yet', prostateLastDate: '2026-07' });
      expect(cards(file).map((c) => c.id)).toEqual(['screening-prostate', 'screening-prostate-repeat']);
      expect(cards(file)[1].description.startsWith(CARRIED)).toBe(true);
    });

    it('a PSA below 4.0 before the answer: no rule to keep', () => {
      const file = fileWith([{ value: 3.0, day: '2026-04-10' }], { prostateLastDate: '2026-07' });
      expect(cards(file)).toEqual([]);
      expect(reminders(file)).toEqual([]);
      expect(chatPlan(file)).toEqual([]);
    });

    it('a real answer of 3.0 dated 2026-07, in range and below 4.0: it ends the rule', () => {
      const file = fileWith(RAISED_THEN_VAGUE, { prostatePsaValue: '3.0', prostateLastDate: '2026-07' });
      expect(cards(file)).toEqual([]);
      expect(reminders(file)).toEqual([]);
      expect(chatPlan(file)).toEqual([]);
    });
  });
});

describe('the old answer takes its place in the chronology (US-06 AC14, AC21 item 6)', () => {
  const holds = (file: RoadmapFile, dueAt: string) => {
    expect(reminders(file)).toEqual([dueAt]);
    expect(cards(file).map((c) => c.id)).toContain('screening-prostate-repeat');
  };
  const ends = (file: RoadmapFile) => {
    expect(reminders(file)).toEqual([]);
    expect(cards(file)).toEqual([]);
  };

  it('raised answer, then a real 3.0, then vague: a value below 4.0 ends the rule', () => {
    ends(fileWith([{ value: 3.0, day: '2026-04-10' }, VAGUE], LEGACY_RAISED));
  });

  it('raised answer, then a real 3.0 (newest): ends', () => {
    ends(fileWith([{ value: 3.0, day: '2026-06-01' }], LEGACY_RAISED));
  });

  it('raised answer, then a real 4.2, then vague: the newer raised row anchors; holds', () => {
    holds(fileWith([{ value: 4.2, day: '2026-04-10' }, VAGUE], LEGACY_RAISED), '2026-09-01');
  });

  it('raised answer, then a real 4.2 (newest): "Elevated PSA" reads the row', () => {
    const file = fileWith([{ value: 4.2, day: '2026-06-01' }], LEGACY_RAISED);
    expect(cards(file)).toContainEqual(expect.objectContaining({ id: 'screening-prostate-elevated', description: expect.stringContaining('4.2') }));
    expect(reminders(file)).toEqual(['2026-09-01']);
  });

  it('an answer below 4.0, then vague: no rule', () => {
    ends(fileWith([VAGUE], { prostatePsaValue: '3.0', prostateLastDate: '2026-03' }));
  });

  it('a raised row, then an answer below 4.0, then vague: the answer is the newer deciding result; ends', () => {
    ends(fileWith([{ value: 4.5, day: '2026-01-10' }, VAGUE], { prostatePsaValue: '3.0', prostateLastDate: '2026-03' }));
  });

  it('a raised answer in the vague row\'s own month: the row counts as newer (AC14), so the answer anchors; holds', () => {
    holds(fileWith([VAGUE], { prostatePsaValue: '6.5', prostateLastDate: '2026-06' }), '2026-09-01');
  });

  it('a raised answer newer than the vague row: the answer is the PSA read (AC14); "Elevated PSA" and 3 months from it', () => {
    const file = fileWith([VAGUE], { prostatePsaValue: '6.5', prostateLastDate: '2026-07' });
    expect(cards(file).map((c) => c.id)).toEqual(['screening-prostate-repeat', 'screening-prostate-elevated']);
    expect(reminders(file)).toEqual(['2026-10-01']);
  });

  it('an answer given as a full day on the same day as a deciding row: the row wins (AC14)', () => {
    ends(fileWith([{ value: 3.0, day: '2026-04-10' }, VAGUE], { prostatePsaValue: '6.5', prostateLastDate: '2026-04-10' }));
    holds(fileWith([{ value: 4.5, day: '2026-04-10' }, VAGUE], { prostatePsaValue: '3.0', prostateLastDate: '2026-04-10' }), '2026-09-01');
  });

  it('a raised answer with no date gives way to any dated row (AC14) and anchors nothing: no rule, as before', () => {
    ends(fileWith([VAGUE], { prostatePsaValue: '6.5' }));
  });
});

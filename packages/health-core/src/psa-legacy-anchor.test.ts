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
type Answers = { prostatePsaValue?: string; prostateLastDate?: string };
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

  it('a raised answer with no date gives way to any dated row (AC14) and anchors nothing: no rule, as before', () => {
    ends(fileWith([VAGUE], { prostatePsaValue: '6.5' }));
  });
});

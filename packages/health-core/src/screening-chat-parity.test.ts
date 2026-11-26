// US-06 AC14 (Codex re-check on PR 1604): the chat reads a numeric screening answer's own text,
// as the plan does, once it has checked the number. Rewriting it ("05.0" -> "5", 1e-7) would let
// the chat's plan read what the plan refuses, or refuse what it reads. Synthetic records only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computePlan } from './plan';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { currentValueRows } from './blood-tests';
import { fileScreeningRows } from './file-inputs';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = new Date('2026-11-12T12:00:00Z');

function fileWith(screenings: Record<string, string>, psaRows: Array<{ value: number; day: string; comparator?: '<' }> = []): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'parity', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, ...screenings } as RoadmapFile['screenings'],
    measurements: psaRows.map((r, i) => createMeasurement({
      id: `p${i}`, metricType: 'psa', value: r.value, recordedAt: `${r.day}T00:00:00.000Z`, createdAt: `${r.day}T00:00:00.000Z`,
      ...(r.comparator ? { comparator: r.comparator } : {}),
    })),
  };
}
const planIds = (file: RoadmapFile, prefix: string) =>
  computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith(prefix)).map((s) => `${s.id}: ${s.description}`);
const chatIds = (file: RoadmapFile, prefix: string) => {
  const payload = chatContextOf(
    { sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 }, 'si', [],
    fileScreeningRows(file.screenings), currentValueRows(file),
  );
  return (JSON.parse(buildChatContextJson(payload)!).currentSuggestions as Array<{ id: string; description: string }>)
    .filter((s) => s.id.startsWith(prefix)).map((s) => `${s.id}: ${s.description}`);
};

describe('plan and chat read a numeric screening answer alike (US-06 AC14)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('a colonoscopy follow-up interval typed "05.0": the plan refuses it, and so does the chat', () => {
    const file = fileWith({
      colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2023-01', colorectalResult: 'abnormal',
      colorectalFollowupStatus: 'completed', colorectalFollowupDate: '2023-06', colorectalFollowupIntervalYears: '05.0',
    });
    const typedFive = fileWith({ ...file.screenings as unknown as Record<string, string>, colorectalFollowupIntervalYears: '5' });
    expect(planIds(file, 'screening-colorectal')).not.toEqual(planIds(typedFive, 'screening-colorectal'));
    expect(chatIds(file, 'screening-colorectal')).toEqual(planIds(file, 'screening-colorectal'));
  });

  it('a PSA answer of 0.0000001 dated 2026-07, after a raised then vague PSA: both read it, and it ends the rule', () => {
    const file = fileWith(
      { prostateDiscussion: 'elected_not_to', prostatePsaValue: '0.0000001', prostateLastDate: '2026-07' },
      [{ value: 4.5, day: '2026-01-10' }, { value: 5, day: '2026-06-01', comparator: '<' }],
    );
    expect(planIds(file, 'screening-prostate')).toEqual([]);
    expect(chatIds(file, 'screening-prostate')).toEqual([]);
    // Control: the same record with the date alone keeps the rule, so both show "Repeat PSA test".
    const dateOnly = fileWith(
      { prostateDiscussion: 'elected_not_to', prostateLastDate: '2026-07' },
      [{ value: 4.5, day: '2026-01-10' }, { value: 5, day: '2026-06-01', comparator: '<' }],
    );
    expect(planIds(dateOnly, 'screening-prostate')).toEqual([expect.stringMatching(/^screening-prostate-repeat: /)]);
    expect(chatIds(dateOnly, 'screening-prostate')).toEqual(planIds(dateOnly, 'screening-prostate'));
  });
});

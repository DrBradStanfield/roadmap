/**
 * US-06 AC14 (re-check, adversary R1): the servers run in UTC. The Shopify
 * chat (chat.server.ts → buildChatContextJson) and the hosted MCP's get_plan
 * (computePlan) read "today" from that clock, so a PSA dated an Auckland
 * user's today (UTC+13) is a day ahead of the server's. A saved PSA counts up
 * to the latest day anywhere on Earth (UTC+14), as the old screening answers
 * did; a day beyond that is refused. Synthetic records only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { computePlan } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { ApiScreening } from './mappings';

// 12:00 UTC on 3 Nov 2026 is 01:00 on 4 Nov in Auckland (NZDT, UTC+13).
const NOW = new Date('2026-11-03T12:00:00Z');
const tz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'UTC'; });
afterAll(() => { process.env.TZ = tz; vi.useRealTimers(); });

function record(day: string): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_utc', now: '2024-01-01T00:00:00Z' });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1 },
    screenings: { ...f.screenings, prostateDiscussion: 'will_screen' } as RoadmapFile['screenings'],
    measurements: [createMeasurement({ id: 'psa_0', metricType: 'psa', value: 6.5, recordedAt: `${day}T00:00:00.000Z`, createdAt: NOW.toISOString() })],
  };
}
const prostate = (file: RoadmapFile) => computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith('screening-prostate')).map((s) => s.id);
const chatIds = (day: string) => {
  vi.useFakeTimers({ now: NOW });
  const screenings: ApiScreening[] = [{ id: 'd', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: NOW.toISOString() }];
  const json = buildChatContextJson(chatContextOf({ sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1 }, 'si', [], screenings,
    [{ metricType: 'psa', value: 6.5, recordedAt: `${day}T00:00:00.000Z` }]));
  vi.useRealTimers();
  return (JSON.parse(json!).currentSuggestions as Array<{ id: string }>).map((s) => s.id);
};

describe('a PSA dated the user\'s today, read on a UTC server (US-06 AC14)', () => {
  it('the process clock is UTC here, as on the server', () => {
    expect(NOW.getTimezoneOffset()).toBe(0);
  });

  it('get_plan (computePlan): an Auckland PSA dated 4 Nov shows "Elevated PSA" and dates the reminder', () => {
    // No "up to date" beside "Elevated PSA" (US-06 AC17); the reminder below carries the day.
    expect(prostate(record('2026-11-04'))).toEqual(['screening-prostate-elevated']);
    expect(computeReminderSchedule(record('2026-11-04'), NOW).filter((i) => i.category === 'screening_prostate').map((i) => i.dueAt)).toEqual(['2027-11-01']);
  });

  it('the Shopify chat (buildChatContextJson): the same PSA puts "Elevated PSA" in the chat plan', () => {
    expect(chatIds('2026-11-04')).toContain('screening-prostate-elevated');
  });

  it('control: a day past the latest day on Earth (5 Nov) is still refused, by the plan and the chat', () => {
    expect(prostate(record('2026-11-05'))).toEqual([]);
    expect(chatIds('2026-11-05')).not.toContain('screening-prostate-elevated');
  });
});

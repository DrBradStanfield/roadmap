// @vitest-environment jsdom
/**
 * US-06 AC21 item 6 (Brad 2026-11-13): the blog bubble and the chatbot embed read the
 * mirror, which holds only the newest usable PSA. Its `raisedBefore` is worked out once at
 * mirror-write time from the full record (mirrorRecord), so the 3-month rule reaches the
 * chat through mirrorRecord -> loadGuestInputs -> buildChatContextJson. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChatContextJson } from '@roadmap/health-core/chat-context';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';

const record = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('./roadmap-data', () => ({
  loadLabValues: async () => [],
  loadAllHistory: async () => record.rows,
  loadAllHistorySync: () => record.rows,
  loadLatestMeasurements: async () => null,
}));

import { mirrorRecord } from '../hooks/useRecordReads';
import { loadGuestInputs, MIRROR_KEY } from './storage';

const NOW = new Date('2026-11-12T12:00:00Z');
const row = (id: string, value: number, day: string, comparator?: '<'): ApiMeasurement =>
  ({ id, metricType: 'psa', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z`, status: 'active', ...(comparator && { comparator }) }) as ApiMeasurement;
const RAISED = row('raised', 4.5, '2026-04-10');
const VAGUE = row('vague', 5, '2026-06-01', '<');

/** A man born 1962 with `answer`, his record `rows`, mirrored as the page mirrors it; the chat's prostate cards. */
async function chat(answer: string, rows: ApiMeasurement[], oldAnswers: Record<string, string> = {}) {
  record.rows = rows;
  await mirrorRecord({
    inputs: { sex: 'male', heightCm: 178, birthYear: 1962, birthMonth: 1, unitSystem: 'si' },
    previousMeasurements: [rows.at(-1)!], medications: [], supplements: [],
    screenings: [{ id: 's', screeningKey: 'prostate_discussion', value: answer, updatedAt: '2026-01-01T00:00:00.000Z' },
      ...Object.entries(oldAnswers).map(([screeningKey, value]) => ({ id: screeningKey, screeningKey, value, updatedAt: '2026-01-01T00:00:00.000Z' }))],
  } as never);
  const payload = loadGuestInputs();
  const context = JSON.parse(buildChatContextJson(payload)!);
  return {
    sent: payload!.measurementHistory!.psa,
    cards: (context.currentSuggestions as Array<{ id: string; description: string }>).filter(s => s.id.startsWith('screening-prostate')),
    psa: context.measurementHistory.psa,
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('the mirror carries the flag (US-06 AC21 item 6)', () => {
  it('declined, 4.5 then "< 5": "Repeat PSA test" with the earlier-result sentence; only the newest PSA leaves', async () => {
    const got = await chat('elected_not_to', [RAISED, VAGUE]);
    expect(got.cards.map(c => c.id)).toEqual(['screening-prostate-repeat']);
    expect(got.cards[0].description).not.toContain('Your last PSA');
    expect(got.sent).toEqual([{ date: '2026-06-01', value: 5, comparator: '<', raisedBefore: true }]);
    // The plan reads the flag; the model-facing JSON drops it (re-check, adversary R1).
    expect(got.psa).toEqual([{ date: '2026-06-01', value: 5, comparator: '<' }]);
    expect(localStorage.getItem(MIRROR_KEY)).not.toContain('2026-04-10');
  });

  it('will screen, 4.5 then "< 5": the 3-month date has passed, so overdue (not 12 months)', async () => {
    expect((await chat('will_screen', [RAISED, VAGUE])).cards.map(c => c.id)).toEqual(['screening-prostate-overdue']);
  });

  it('no raised PSA before the "< 5": no flag, as before', async () => {
    const got = await chat('elected_not_to', [row('low', 3.0, '2026-04-10'), VAGUE]);
    expect(got.cards).toEqual([]);
    expect(got.psa[0]).not.toHaveProperty('raisedBefore');
  });

  it('the old answers take their place in the flag (US-06 AC14): raised answer then "< 5" holds; a newer answer below 4.0 ends it', async () => {
    const holds = await chat('elected_not_to', [VAGUE], { prostate_psa_value: '6.5', prostate_last_date: '2026-03' });
    expect(holds.cards.map(c => c.id)).toEqual(['screening-prostate-repeat']);
    const ends = await chat('elected_not_to', [row('raised', 4.5, '2026-01-10'), VAGUE], { prostate_psa_value: '3.0', prostate_last_date: '2026-03' });
    expect(ends.cards).toEqual([]);
    expect(ends.sent[0]).not.toHaveProperty('raisedBefore');
  });

  it('a mirror flag that is not `true` is no flag', async () => {
    await chat('elected_not_to', [RAISED, VAGUE]);
    const stored = JSON.parse(localStorage.getItem(MIRROR_KEY)!);
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...stored, psa: { ...stored.psa, raisedBefore: 'yes' } }));
    const context = JSON.parse(buildChatContextJson(loadGuestInputs())!);
    expect((context.currentSuggestions as Array<{ id: string }>).filter(s => s.id.startsWith('screening-prostate'))).toEqual([]);
  });
});

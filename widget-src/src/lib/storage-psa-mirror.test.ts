// @vitest-environment jsdom
/**
 * US-06 AC14: the blog and embed chats read the mirror's newest usable PSA.
 * localStorage is an untrusted copy: a cached PSA whose value is not a
 * number (null, "", "abc") is no PSA, never a 0 that outranks the real
 * reading (Codex re-check R2), and the snapshot names the PSA the cards read
 * (R1). Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildChatContextJson, type ApiMeasurement } from '@roadmap/health-core';
import { loadGuestInputs, saveToLocalStorage, MIRROR_KEY } from './storage';

const row = (id: string, value: number, day: string): ApiMeasurement =>
  ({ id, metricType: 'psa', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T09:00:00.000Z` }) as ApiMeasurement;

/** A man born 1960 who will screen, his newest PSA row `latest`, the mirror's usable PSA `usable`. */
function mirror(latest: ApiMeasurement, usable: unknown) {
  saveToLocalStorage({ sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1, unitSystem: 'si' }, [latest], [],
    [{ id: 's', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: '2026-01-01T00:00:00.000Z' }]);
  const stored = JSON.parse(localStorage.getItem(MIRROR_KEY)!);
  localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...stored, psa: usable }));
  const context = JSON.parse(buildChatContextJson(loadGuestInputs())!);
  return { ids: (context.currentSuggestions as Array<{ id: string }>).map(s => s.id), psa: context.latestValues.psa };
}

afterEach(() => localStorage.clear());

describe('the mirror\'s usable PSA (US-06 AC14)', () => {
  it('a newer row dated after today: the snapshot and the card both read the usable 6.5', () => {
    const got = mirror(row('future', 3.0, '2099-01-01'), row('real', 6.5, '2025-09-03'));
    expect(got.ids).toContain('screening-prostate-elevated');
    expect(got.psa).toBe('6.5');
  });

  it.each([['null', null], ['blank', ''], ['text', 'abc'], ['a number as text', '6.5']])(
    'a cached PSA whose value is %s is no PSA: the real 6.5 still shows', (_what, value) => {
      const got = mirror(row('real', 6.5, '2025-09-03'), { ...row('bad', 0, '2025-10-01'), value });
      expect(got.ids).toContain('screening-prostate-elevated');
      expect(got.psa).toBe('6.5');
    });
});

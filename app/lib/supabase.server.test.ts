import { describe, it, expect } from 'vitest';
import {
  aggregateABCounts,
  aggregateReminderOptins,
  chatTurnStats,
  type ABCountRow,
  type ReminderOptinRow,
} from './supabase.server';
import type { ABVariant } from './supabase.server';

describe('aggregateABCounts', () => {
  const variants: ABVariant[] = [
    { id: 'a', value: 'foo', weight: 50 },
    { id: 'b', value: 'bar', weight: 50 },
  ];

  it('aggregates RPC rows into per-variant impression and conversion counts', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 1307 },
      { variant_id: 'a', event_type: 'conversion', count: 35 },
      { variant_id: 'b', event_type: 'impression', count: 1615 },
      { variant_id: 'b', event_type: 'conversion', count: 26 },
    ];
    expect(aggregateABCounts(variants, rows)).toEqual([
      { variantId: 'a', impressions: 1307, conversions: 35 },
      { variantId: 'b', impressions: 1615, conversions: 26 },
    ]);
  });

  it('handles BIGINT counts returned as strings from Postgres', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: '1307' },
      { variant_id: 'a', event_type: 'conversion', count: '35' },
    ];
    const result = aggregateABCounts(variants, rows);
    expect(result[0]).toEqual({ variantId: 'a', impressions: 1307, conversions: 35 });
  });

  it('returns zero counts for variants with no events (e.g. newly added)', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 500 },
    ];
    expect(aggregateABCounts(variants, rows)).toEqual([
      { variantId: 'a', impressions: 500, conversions: 0 },
      { variantId: 'b', impressions: 0, conversions: 0 },
    ]);
  });

  it('ignores rows for variant IDs not in the test (stale data safety)', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 100 },
      { variant_id: 'c', event_type: 'impression', count: 999 },
    ];
    const result = aggregateABCounts(variants, rows);
    expect(result.find(r => r.variantId === 'a')!.impressions).toBe(100);
    expect(result).toHaveLength(2);
    expect(result.find(r => r.variantId === 'c')).toBeUndefined();
  });

  it('handles null rows from RPC (empty result set)', () => {
    expect(aggregateABCounts(variants, null)).toEqual([
      { variantId: 'a', impressions: 0, conversions: 0 },
      { variantId: 'b', impressions: 0, conversions: 0 },
    ]);
  });
});

describe('chatTurnStats', () => {
  it('counts turns, distinct chatters and the fallback rate', () => {
    expect(chatTurnStats(4, [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }], 1)).toEqual({
      turns: 4, activeChatters: 2, fallbacks: 1, fallbackRate: 0.25,
    });
  });

  it('handles null counts and rows', () => {
    expect(chatTurnStats(null, null, null)).toEqual({ turns: 0, activeChatters: 0, fallbacks: 0, fallbackRate: 0 });
  });
});

describe('aggregateReminderOptins', () => {
  const today = '2026-06-14';

  it('groups opt-ins by provider, sorted by count desc', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'google-drive', last_sent: {}, schedule: [] },
      { provider: 'dropbox', last_sent: {}, schedule: [] },
      { provider: 'google-drive', last_sent: {}, schedule: [] },
    ];
    const result = aggregateReminderOptins(rows, today);
    expect(result.byProvider).toEqual([
      { provider: 'google-drive', count: 2 },
      { provider: 'dropbox', count: 1 },
    ]);
  });

  it('counts opt-ins that have received at least one email', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'github', last_sent: { blood_test_lipids: '2026-06-01' }, schedule: [] },
      { provider: 'github', last_sent: {}, schedule: [] },
      { provider: 'github', last_sent: null, schedule: [] },
    ];
    expect(aggregateReminderOptins(rows, today).withSends).toBe(1);
  });

  it('counts opt-ins due within 7 days (inclusive of overdue)', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-06-10' }] }, // overdue
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-06-20' }] }, // within 7d
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-07-01' }] }, // far future
      { provider: 'github', last_sent: {}, schedule: [] },                         // none
    ];
    expect(aggregateReminderOptins(rows, today).dueSoon).toBe(2);
  });

  it('labels missing provider as "unknown"', () => {
    const result = aggregateReminderOptins(
      [{ provider: null, last_sent: {}, schedule: [] }],
      today,
    );
    expect(result.byProvider).toEqual([{ provider: 'unknown', count: 1 }]);
  });

  it('handles null rows', () => {
    expect(aggregateReminderOptins(null, today)).toEqual({
      byProvider: [],
      withSends: 0,
      dueSoon: 0,
    });
  });
});

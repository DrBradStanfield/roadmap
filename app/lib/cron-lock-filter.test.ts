import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// US-28 AC9: the acquire's `.or()` filter is valid PostgREST logic-tree syntax.
// Inside or()/and(), PostgREST ends a value only at `,` or `)` (QueryParams.hs
// pLogicSingleVal: `many (noneOf ",)")`), so the cutoff's `:` and `.` need no
// quoting. These pins hold the exact string, written by hand, not rebuilt from
// the code's own builder.

const db = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof import('./cron-lock-fake.test-helpers').makeFakeLockDb> }));
vi.mock('./supabase-client.server', async () => {
  const helpers = await import('./cron-lock-fake.test-helpers');
  db.fake = helpers.makeFakeLockDb();
  return { supabaseAdmin: helpers.fakeAdmin(db.fake) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { tryAcquireCronLock } = await import('./supabase-cron-lock.server');
const fake = () => db.fake!;

const clock = { now: new Date('2026-11-11T01:00:00.000Z'), stuckCutoff: new Date('2026-11-11T00:00:00.000Z') };

const WITH_OWNER =
  'lock_date.is.null,' +
  'and(lock_date.lt.2026-11-11,or(run_state.is.null,run_state.neq.running,locked_at.lt.2026-11-11T00:00:00.000Z)),' +
  'and(lock_date.eq.2026-11-11,locked_by.eq.m-a,run_state.in.(failed,running)),' +
  'and(lock_date.eq.2026-11-11,run_state.eq.running,locked_at.lt.2026-11-11T00:00:00.000Z)';

const NULL_OWNER =
  'lock_date.is.null,' +
  'and(lock_date.lt.2026-11-11,or(run_state.is.null,run_state.neq.running,locked_at.lt.2026-11-11T00:00:00.000Z)),' +
  'and(lock_date.eq.2026-11-11,run_state.eq.running,locked_at.lt.2026-11-11T00:00:00.000Z)';

const NULL_OWNER_ENCODED =
  '%28lock_date.is.null%2C' +
  'and%28lock_date.lt.2026-11-11%2Cor%28run_state.is.null%2Crun_state.neq.running%2Clocked_at.lt.2026-11-11T00%3A00%3A00.000Z%29%29%2C' +
  'and%28lock_date.eq.2026-11-11%2Crun_state.eq.running%2Clocked_at.lt.2026-11-11T00%3A00%3A00.000Z%29%29';

beforeEach(() => {
  const f = fake();
  f.rows = [];
  f.calls = [];
  f.filters = [];
  f.afterUpdate = null;
});

async function sentFilter(machineId: string | null): Promise<string> {
  await tryAcquireCronLock(machineId, '2026-11-11', 'trending_cron', clock).catch(() => undefined);
  expect(fake().filters).toHaveLength(1);
  return fake().filters[0];
}

describe('US-28 AC9: the exact .or() filter the acquire sends', () => {
  it('with a machine id', async () => {
    expect(await sentFilter('m-a')).toBe(WITH_OWNER);
  });

  it('with no machine id: the own-row branch is left out', async () => {
    expect(await sentFilter(null)).toBe(NULL_OWNER);
  });

  it('round-trips through the URL supabase-js builds (no network call)', async () => {
    const sent = await sentFilter(null);
    const builder = createClient('http://cron-lock.test', 'test-key-plain')
      .from('cron_lock')
      .update({ run_state: 'running' })
      .eq('lock_name', 'trending_cron')
      .or(sent);
    const url = (builder as unknown as { url: URL }).url;
    expect(url.searchParams.getAll('or')).toEqual([`(${NULL_OWNER})`]);
    expect(url.search).toContain(`&or=${NULL_OWNER_ENCODED}`);
    expect(url.search.endsWith(NULL_OWNER_ENCODED)).toBe(true);
  });
});

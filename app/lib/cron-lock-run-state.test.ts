import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LockRow } from './cron-lock-fake.test-helpers';

// US-28 AC9 (cron lock follow-up, 2026-11-11): the lock records a run's end.
// A finished day is refused to every machine, the one that ran it included; an
// unfinished day is retaken by its own machine at once and by any machine past
// the stuck limit; a live run on one day blocks the next day until it ends or
// goes stuck. Seen live 2026-11-11: trending ran twice after a deploy, because
// the restarted machine's verify read its own finished row as a win.

const db = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof import('./cron-lock-fake.test-helpers').makeFakeLockDb> }));
vi.mock('./supabase-client.server', async () => {
  const helpers = await import('./cron-lock-fake.test-helpers');
  db.fake = helpers.makeFakeLockDb();
  return { supabaseAdmin: helpers.fakeAdmin(db.fake) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { tryAcquireCronLock, endCronLock, notWonAnswer } = await import('./supabase-cron-lock.server');
const Sentry = await import('@sentry/react-router');
const fake = () => db.fake!;

const HOUR = 60 * 60 * 1000;
const TODAY = '2026-11-11';
const EARLIER = '2026-11-10';
const NOW = new Date('2026-11-11T05:54:00.123Z');
const CUTOFF = new Date(NOW.getTime() - HOUR);
const FRESH = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
const STUCK = new Date(NOW.getTime() - 2 * HOUR).toISOString();
const clock = { now: NOW, stuckCutoff: CUTOFF };

type Day = 'seed' | 'earlier' | 'today';
type State = null | 'running' | 'finished' | 'failed';
const DAYS: Day[] = ['seed', 'earlier', 'today'];
const STATES: State[] = [null, 'running', 'finished', 'failed'];
const lockDate = { seed: null, earlier: EARLIER, today: TODAY };

// The row's owner, seen from a caller that is machine m-a: m-a (me), m-b
// (another machine), or null (a process with no FLY_MACHINE_ID). Each cell is
// six answers, owner by owner, fresh then stuck: W won (taken), C closed (the
// day ends here), B busy (refused for now: the next tick tries again).
const OWNERS = ['m-a', 'm-b', null] as const;
const AS_MACHINE: Record<Day, Record<string, string>> = {
  seed: { null: 'WWWWWW', running: 'WWWWWW', finished: 'WWWWWW', failed: 'WWWWWW' },
  earlier: { null: 'WWWWWW', running: 'BWBWBW', finished: 'WWWWWW', failed: 'WWWWWW' },
  // today: NULL (a legacy row) and finished are closed to all; running is
  // mine at once, anyone's once stuck, busy to others while fresh; failed is
  // mine only (no ping-pong), closed to others so they stop trying.
  today: { null: 'CCCCCC', running: 'WWBWBW', finished: 'CCCCCC', failed: 'WWCCCC' },
};
// The same rows seen from a caller with no machine id: nothing is ever its own.
const ANSWER = { W: 'won', C: 'closed', B: 'busy' } as const;
const AS_NULL_OWNER: Record<Day, Record<string, string>> = {
  seed: { null: 'WWWWWW', running: 'WWWWWW', finished: 'WWWWWW', failed: 'WWWWWW' },
  earlier: { null: 'WWWWWW', running: 'BWBWBW', finished: 'WWWWWW', failed: 'WWWWWW' },
  today: { null: 'CCCCCC', running: 'BWBWBW', finished: 'CCCCCC', failed: 'CCCCCC' },
};

const row = (over: Partial<LockRow>): LockRow => ({
  lock_name: 'trending_cron', locked_by: 'm-b', locked_at: FRESH, lock_date: TODAY, run_state: 'running', finished_at: null, ...over,
});

beforeEach(() => {
  const f = fake();
  f.rows = [];
  f.calls = [];
  f.filters = [];
  f.afterUpdate = null;
});

describe('US-28 AC9: the acquire table, every day x run_state x owner x age', () => {
  const cases = (caller: string | null, table: Record<Day, Record<string, string>>) =>
    DAYS.flatMap((day) => STATES.flatMap((state) => OWNERS.flatMap((owner, o) => (['fresh', 'stuck'] as const).map((age, a) => ({
      caller, day, state, owner, age, answer: ANSWER[table[day][String(state)][o * 2 + a] as keyof typeof ANSWER],
    })))));

  it.each([...cases('m-a', AS_MACHINE), ...cases(null, AS_NULL_OWNER)])(
    'caller $caller, $day row, run_state $state, owner $owner, $age: $answer',
    async ({ caller, day, state, owner, age, answer }) => {
      const before = row({ lock_date: lockDate[day], run_state: state, locked_by: owner, locked_at: age === 'fresh' ? FRESH : STUCK });
      fake().rows = [{ ...before }];
      await expect(tryAcquireCronLock(caller, TODAY, 'trending_cron', clock)).resolves.toBe(answer);
      expect(fake().rows[0]).toEqual(answer === 'won'
        ? { ...before, locked_by: caller, lock_date: TODAY, run_state: 'running', locked_at: NOW.toISOString() }
        : before);
    },
  );
});

describe('US-28 AC9: the verify', () => {
  it('compares locked_at as an instant: Postgres answers in microseconds with +00:00', async () => {
    fake().rows = [row({ lock_date: EARLIER, run_state: 'finished', locked_by: 'm-b' })];
    // The fake stores what the update wrote and reads it back as e.g. 2026-11-11T05:54:00.123000+00:00.
    await expect(tryAcquireCronLock('m-a', TODAY, 'trending_cron', clock)).resolves.toBe('won');
  });

  it('a row showing this machine, today and running, with a locked_at this call did not write, is not a win: busy', async () => {
    fake().rows = [row({ lock_date: EARLIER, run_state: 'finished', locked_by: 'm-b' })];
    fake().afterUpdate = () => { fake().rows[0].locked_at = '2026-11-11T05:54:00.124Z'; };
    await expect(tryAcquireCronLock('m-a', TODAY, 'trending_cron', clock)).resolves.toBe('busy');
  });

  it.each<[string, Partial<LockRow>, 'closed' | 'busy']>([
    ['running fresh on another machine', { locked_by: 'm-b', run_state: 'running', locked_at: FRESH }, 'busy'],
    ['already finished by another machine', { locked_by: 'm-b', run_state: 'finished' }, 'closed'],
    ['failed on another machine', { locked_by: 'm-b', run_state: 'failed' }, 'closed'],
  ])('a seed row lost in a race to a row %s answers from the row read back: %s', async (_, won, answer) => {
    fake().rows = [row({ lock_date: null, run_state: null, locked_by: null, locked_at: null })];
    fake().afterUpdate = () => { Object.assign(fake().rows[0], { lock_date: TODAY, ...won }); };
    await expect(tryAcquireCronLock('m-a', TODAY, 'trending_cron', clock)).resolves.toBe(answer);
  });

  it('the acquire is one update with no .select(), then a separate verify select', async () => {
    fake().rows = [row({ lock_date: EARLIER, run_state: 'finished' })];
    await tryAcquireCronLock('m-a', TODAY, 'trending_cron', clock);
    const [write, verify] = fake().calls;
    expect(fake().calls).toHaveLength(2);
    expect(write).toContain('update');
    expect(write).not.toContain('select');
    expect(verify).toContain('select');
    expect(verify).not.toContain('update');
  });

  it('a missing machine id writes NULL as the owner', async () => {
    fake().rows = [row({ lock_date: null, run_state: null, locked_by: null, locked_at: null })];
    await expect(tryAcquireCronLock(null, TODAY, 'trending_cron', clock)).resolves.toBe('won');
    expect(fake().rows[0].locked_by).toBeNull();
  });
});

// The not-won table as coded (notWonAnswer), row by row, as the verify read
// returns it, for a caller m-a and a caller with no machine id.
describe('US-28 AC9: every not-won answer, by the verify row', () => {
  const v = (lock_date: string | null, run_state: string | null, locked_by: string | null) => ({ lock_date, run_state, locked_by });
  it.each<[string, ReturnType<typeof v>, string | null, 'closed' | 'busy']>([
    ['today finished', v(TODAY, 'finished', 'm-b'), 'm-a', 'closed'],
    ['today finished, my own', v(TODAY, 'finished', 'm-a'), 'm-a', 'closed'],
    ['today NULL (legacy)', v(TODAY, null, 'm-b'), 'm-a', 'closed'],
    ['today failed, another machine', v(TODAY, 'failed', 'm-b'), 'm-a', 'closed'],
    ['today failed, no owner', v(TODAY, 'failed', null), 'm-a', 'closed'],
    ['today failed, caller has no id', v(TODAY, 'failed', null), null, 'closed'],
    ['a later day', v('2026-11-12', 'running', 'm-b'), 'm-a', 'closed'],
    ['a later day, finished', v('2026-11-12', 'finished', 'm-b'), 'm-a', 'closed'],
    ['today running, another machine', v(TODAY, 'running', 'm-b'), 'm-a', 'busy'],
    ['today running, my own (a write I did not make)', v(TODAY, 'running', 'm-a'), 'm-a', 'busy'],
    ['today failed, my own (a lost race)', v(TODAY, 'failed', 'm-a'), 'm-a', 'busy'],
    ['an earlier day running', v(EARLIER, 'running', 'm-b'), 'm-a', 'busy'],
    ['an earlier day finished (a lost race)', v(EARLIER, 'finished', 'm-b'), 'm-a', 'busy'],
    ['the seed', v(null, null, null), 'm-a', 'busy'],
    ['an unknown run_state today', v(TODAY, 'paused', 'm-b'), 'm-a', 'busy'],
  ])('%s: %s', (_, verify, me, answer) => {
    expect(notWonAnswer(verify, me, TODAY)).toBe(answer);
  });
});

// R7: an id the filter cannot carry stops every cron on this machine, so it
// must be loud, once per process, with a fixed message and never the value.
describe('US-28 AC9: an unsafe FLY_MACHINE_ID', () => {
  it('answers closed with no query, and logs and reports once per process, never the value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockClear();
    fake().rows = [row({ lock_date: EARLIER, run_state: 'finished' })];
    await expect(tryAcquireCronLock('bad,id)', TODAY, 'trending_cron', clock)).resolves.toBe('closed');
    await expect(tryAcquireCronLock('bad,id)', TODAY, 'chat_text_purge', clock)).resolves.toBe('closed');
    expect(fake().calls).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Cron lock: unsafe FLY_MACHINE_ID, daily crons off', { level: 'error', tags: { feature: 'cron_lock' } });
    expect(JSON.stringify([error.mock.calls, vi.mocked(Sentry.captureMessage).mock.calls])).not.toContain('bad');
    error.mockRestore();
  });
});

describe('US-28 AC9: the end writes', () => {
  const END = new Date('2026-11-11T05:56:00.000Z');

  it('a finished run marks its own row finished with its end time, with no .select()', async () => {
    fake().rows = [row({ locked_by: 'm-a' })];
    await endCronLock('m-a', TODAY, 'trending_cron', 'finished', END);
    expect(fake().rows[0]).toMatchObject({ run_state: 'finished', finished_at: END.toISOString() });
    expect(fake().calls.flat()).not.toContain('select');
  });

  it('a failed run marks its own row failed and leaves finished_at alone', async () => {
    fake().rows = [row({ locked_by: 'm-a' })];
    await endCronLock('m-a', TODAY, 'trending_cron', 'failed', END);
    expect(fake().rows[0]).toMatchObject({ run_state: 'failed', finished_at: null });
  });

  it('a stale run cannot mark a newer day, or another machine\'s row', async () => {
    const newer = row({ locked_by: 'm-b', lock_date: '2026-11-12' });
    fake().rows = [{ ...newer }];
    await endCronLock('m-a', TODAY, 'trending_cron', 'finished', END);
    await endCronLock('m-b', TODAY, 'trending_cron', 'finished', END);
    expect(fake().rows[0]).toEqual(newer);

    const theirs = row({ locked_by: 'm-b' });
    fake().rows = [{ ...theirs }];
    await endCronLock('m-a', TODAY, 'trending_cron', 'failed', END);
    expect(fake().rows[0]).toEqual(theirs);
  });

  it('a process with no machine id ends only a row with no owner', async () => {
    fake().rows = [row({ locked_by: 'm-a' }), row({ lock_name: 'chat_text_purge', locked_by: null })];
    await endCronLock(null, TODAY, 'trending_cron', 'finished', END);
    await endCronLock(null, TODAY, 'chat_text_purge', 'finished', END);
    expect(fake().rows[0].run_state).toBe('running');
    expect(fake().rows[1].run_state).toBe('finished');
  });
});

describe('US-28 AC9: a live run on one day blocks the next day', () => {
  // reminder_v2_cron's 6 h limit: machine A's catch-up run starts late on D.
  const SIX = 6 * HOUR;
  const at = (iso: string) => ({ now: new Date(iso), stuckCutoff: new Date(Date.parse(iso) - SIX) });

  it('another machine cannot start D+1 while the D run is fresh, and can once it is stuck', async () => {
    fake().rows = [row({ lock_name: 'reminder_v2_cron', lock_date: '1970-01-01', run_state: null, locked_by: null, locked_at: null })];
    await expect(tryAcquireCronLock('m-a', '2026-11-10', 'reminder_v2_cron', at('2026-11-10T23:00:00Z'))).resolves.toBe('won');
    await expect(tryAcquireCronLock('m-b', '2026-11-11', 'reminder_v2_cron', at('2026-11-11T00:30:00Z'))).resolves.toBe('busy');
    await expect(tryAcquireCronLock('m-b', '2026-11-11', 'reminder_v2_cron', at('2026-11-11T04:30:00Z'))).resolves.toBe('busy');
    await expect(tryAcquireCronLock('m-b', '2026-11-11', 'reminder_v2_cron', at('2026-11-11T05:30:00Z'))).resolves.toBe('won');
  });

  it('once the D run has finished, the next day is free at once', async () => {
    fake().rows = [row({ lock_name: 'reminder_v2_cron', lock_date: '1970-01-01', run_state: null, locked_by: null, locked_at: null })];
    await tryAcquireCronLock('m-a', '2026-11-10', 'reminder_v2_cron', at('2026-11-10T23:00:00Z'));
    await endCronLock('m-a', '2026-11-10', 'reminder_v2_cron', 'finished', new Date('2026-11-10T23:10:00Z'));
    await expect(tryAcquireCronLock('m-b', '2026-11-11', 'reminder_v2_cron', at('2026-11-11T00:30:00Z'))).resolves.toBe('won');
  });
});

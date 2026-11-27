/**
 * US-17 AC19 (untangle R9): one Turn off cancels every token the record
 * holds. The `TurnOff` transition as a table, the per-row "unchanged since
 * the read" check, and the driver over a held record written through the real
 * `setReminderRow`, with the reminders server stubbed. Fake, low-entropy
 * tokens and addresses only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { rowsOf, shownOptIn } from '@roadmap/health-core/reminder-rows';
import { setReminderRow } from '@roadmap/health-core/state-edits';
import type { TurnOff, TurnOffEvent } from './reminders-turn-off';

let file: RoadmapFile;
let edits = 0;
const refuseWrite = { next: false };
const shown = { now: true }; // the record is still at the erase the Turn off was asked under
const trackProductEvent = vi.fn();
vi.mock('../src/lib/roadmap-data', () => ({
  getReminderOptIn: () => file.reminderOptIn,
  setReminderRows: (rows: Omit<ReminderTokenRow, 'updatedAt' | 'lamport'>[]) => {
    if (refuseWrite.next) return false;
    edits += 1;
    file = rows.reduce((next, row) => setReminderRow(next, row, '2026-11-27T12:00:00.000Z'), file);
    return true;
  },
  getShownErase: () => '[0,null]',
  getEraseIdentity: () => '[1,null]',
  stillShown: () => shown.now,
  flushRoadmapStore: async () => {},
}));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/storage', () => ({ GoogleDriveAdapter: class { async getReminderIdToken() { return 'test-proof'; } } }));

const { cancelReminders, turnOffTransition, unchangedSince } = await import('./reminders-turn-off');

const row = (token: string, status: 'active' | 'cancelled', lamport: number, extra: Partial<ReminderTokenRow> = {}): ReminderTokenRow => ({
  status, token, email: `${token}@example.test`, provider: 'dropbox', updatedAt: `2026-11-0${lamport}T00:00:00.000Z`, lamport, ...extra,
});
const optIn = (top: ReminderTokenRow, ...tokens: ReminderTokenRow[]): FileReminderOptIn => (tokens.length ? { ...top, tokens } : top);

/** The server: each cancel answered by `answer(token)`, its body recorded. */
const posts: { token: string; idToken?: string }[] = [];
function server(answer: (token: string) => number | Promise<number> | 'unsent' = () => 200): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { token: string; idToken?: string };
    posts.push(body);
    const status = await answer(body.token);
    if (status === 'unsent') throw new Error('Failed to fetch');
    return new Response('{}', { status });
  }));
}
const statusOf = () => Object.fromEntries(rowsOf(file.reminderOptIn).map((r) => [r.token, r.status]));

beforeEach(() => {
  file = createEmptyFile({ deviceId: 'dev_turn_off', now: '2026-11-01T00:00:00.000Z' });
  edits = 0;
  refuseWrite.next = false;
  shown.now = true;
  posts.length = 0;
  trackProductEvent.mockReset();
});

describe('US-17 AC19: the TurnOff transition', () => {
  const A = row('token-a', 'active', 2);
  const B = row('token-b', 'active', 1);
  const C = row('token-c', 'cancelled', 3);
  const posting = (owed: string[], landed: string[], failure: string | null = null): TurnOff =>
    ({ kind: 'posting', read: [A, B, C], owed, landed, failure });
  const writing = (landed: string[], failure: string | null = null): TurnOff => ({ kind: 'writing', read: [A, B, C], landed, failure });
  const ok = (token: string): TurnOffEvent => ({ type: 'answered', token, failure: null });
  const bad = (token: string): TurnOffEvent => ({ type: 'answered', token, failure: `words for ${token}` });
  const table: [string, TurnOff, TurnOffEvent, TurnOff][] = [
    ['posted owes every token read, active rows first', { kind: 'idle' }, { type: 'posted', read: [C, A, B] }, posting(['token-a', 'token-b', 'token-c'], [])],
    ['posted with no rows ends with nothing to say', { kind: 'idle' }, { type: 'posted', read: [] }, { kind: 'ended', error: null, counts: null }],
    ['posted while posting changes nothing', posting(['token-a'], []), { type: 'posted', read: [] }, posting(['token-a'], [])],
    ['an answer that landed moves its token to landed', posting(['token-a', 'token-b'], []), ok('token-a'), posting(['token-b'], ['token-a'])],
    ['a failed cancel of a row active at the read keeps its words', posting(['token-a', 'token-b'], []), bad('token-a'), posting(['token-b'], [], 'words for token-a')],
    ['a failed cancel of a row cancelled at the read never fails the Turn off', posting(['token-c', 'token-a'], []), bad('token-c'), posting(['token-a'], [])],
    ['the first failure\'s words stay', posting(['token-b'], ['token-c'], 'words for token-a'), bad('token-b'), writing(['token-c'], 'words for token-a')],
    ['the last answer in, with something landed: writing', posting(['token-b'], ['token-a']), ok('token-b'), writing(['token-a', 'token-b'])],
    ['the last answer in, nothing landed: ended with the failure', posting(['token-a'], []), bad('token-a'), { kind: 'ended', error: 'words for token-a', counts: null }],
    ['an answer for a token not owed changes nothing', posting(['token-a'], ['token-b']), ok('token-b'), posting(['token-a'], ['token-b'])],
    ['an answer while writing changes nothing', writing(['token-a']), ok('token-a'), writing(['token-a'])],
    ['written with an active-at-read row counts its provider', writing(['token-a', 'token-c']), { type: 'written', wrote: ['token-c', 'token-a'], refused: null }, { kind: 'ended', error: null, counts: 'dropbox' }],
    ['written with only a cancelled-at-read row counts nothing', writing(['token-c']), { type: 'written', wrote: ['token-c'], refused: null }, { kind: 'ended', error: null, counts: null }],
    ['written with nothing (every row changed since the read) counts nothing', writing(['token-a']), { type: 'written', wrote: [], refused: null }, { kind: 'ended', error: null, counts: null }],
    ['written after a failure still ends with the failure, counted', writing(['token-b'], 'words for token-a'), { type: 'written', wrote: ['token-b'], refused: null }, { kind: 'ended', error: 'words for token-a', counts: 'dropbox' }],
    ['a refused write ends with its words, counted nothing', writing(['token-a']), { type: 'written', wrote: [], refused: 'refused words' }, { kind: 'ended', error: 'refused words', counts: null }],
    ['stopped with something landed: writing, with the refusal\'s words', posting(['token-b'], ['token-a']), { type: 'stopped', refused: 'refused words' }, writing(['token-a'], 'refused words')],
    ['stopped with nothing landed: ended with the refusal\'s words', posting(['token-a', 'token-b'], []), { type: 'stopped', refused: 'refused words' }, { kind: 'ended', error: 'refused words', counts: null }],
    ['stopped outside posting changes nothing', writing(['token-a']), { type: 'stopped', refused: 'refused words' }, writing(['token-a'])],
    ['written outside writing changes nothing', { kind: 'idle' }, { type: 'written', wrote: ['token-a'], refused: null }, { kind: 'idle' }],
  ];
  it.each(table)('%s', (_name, state, event, next) => {
    expect(turnOffTransition(state, event)).toEqual(next);
  });

  const same = row('token-a', 'active', 2);
  const checks: [string, ReminderTokenRow | undefined, boolean][] = [
    ['another token only', { ...same, token: 'token-b' }, false],
    ['the same row', { ...same }, true],
    ['another address only (not a field the check reads)', { ...same, email: 'other@example.test' }, true],
    ['gone', undefined, false],
    ['another status', { ...same, status: 'cancelled' }, false],
    ['another provider', { ...same, provider: 'github' }, false],
    ['a later time', { ...same, updatedAt: '2026-11-09T00:00:00.000Z' }, false],
    ['a later lamport', { ...same, lamport: 3 }, false],
  ];
  it.each(checks)('unchangedSince: %s', (_name, now, out) => {
    expect(unchangedSince(same, now && optIn(row('token-z', 'cancelled', 1), now))).toBe(out);
  });
});

describe('US-17 AC19: Turn off cancels every token, in one edit', () => {
  it('N tokens: a cancel for each, every row cancelled with its address, one edit, counted once', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 3), row('token-b', 'active', 1), row('token-c', 'cancelled', 2));
    server();
    await cancelReminders();
    expect(posts.map((p) => p.token)).toEqual(['token-a', 'token-b', 'token-c']); // active rows first
    expect(statusOf()).toEqual({ 'token-a': 'cancelled', 'token-b': 'cancelled', 'token-c': 'cancelled' });
    expect(rowsOf(file.reminderOptIn).map((r) => r.email)).toEqual(['token-a@example.test', 'token-b@example.test', 'token-c@example.test']);
    expect(shownOptIn(file)?.status).toBe('cancelled');
    expect(edits).toBe(1);
    expect(trackProductEvent.mock.calls).toEqual([['reminder_cancel_many', { provider: 'dropbox', count: 3 }], ['reminder_optout', { provider: 'dropbox' }]]);
  });

  it('partial failure: the landed rows are written, the failed one stays on, the Turn off says why', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    server((token) => (token === 'token-b' ? 500 : 200));
    await expect(cancelReminders()).rejects.toThrow('Could not turn reminders off (500). Please retry.');
    expect(statusOf()).toEqual({ 'token-a': 'cancelled', 'token-b': 'active' });
    expect(shownOptIn(file)?.token).toBe('token-b');
    // A partial failure counts both: the reach of the Turn off, and the opt-out it wrote.
    expect(trackProductEvent.mock.calls).toEqual([['reminder_cancel_many', { provider: 'dropbox', count: 2 }], ['reminder_optout', { provider: 'dropbox' }]]);
  });

  it('a cancel that never leaves fails with its own words; the rest still land', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    server((token) => (token === 'token-a' ? 'unsent' : 200));
    await expect(cancelReminders()).rejects.toThrow('Failed to fetch');
    expect(statusOf()).toEqual({ 'token-a': 'active', 'token-b': 'cancelled' });
  });

  it('a failed cancel for a row already cancelled at the read never fails the Turn off', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-c', 'cancelled', 1));
    server((token) => (token === 'token-c' ? 404 : 200));
    await expect(cancelReminders()).resolves.toBeUndefined();
    expect(statusOf()).toEqual({ 'token-a': 'cancelled', 'token-c': 'cancelled' });
  });

  it('a newer row written for one token while its cancel is out is not overwritten; the others are', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server(async (token) => {
      if (token === 'token-b') await held;
      return 200;
    });
    const turningOff = cancelReminders();
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    // Another device turned token-b on again (a verified re-enrolment), merged in meanwhile.
    file = setReminderRow(file, { status: 'active', token: 'token-b', email: 'token-b@example.test', provider: 'github' }, '2026-11-27T11:00:00.000Z');
    release();
    await turningOff;
    expect(statusOf()).toEqual({ 'token-a': 'cancelled', 'token-b': 'active' });
    expect(rowsOf(file.reminderOptIn).find((r) => r.token === 'token-b')?.provider).toBe('github');
  });

  it('an erase that begins while the first cancel is out stops the second from being posted (review R4)', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server(async (token) => {
      if (token === 'token-a') await held;
      return 200;
    });
    const turningOff = cancelReminders();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    shown.now = false; // the record moved to another erase
    refuseWrite.next = true; // and so refuses the write
    release();
    await expect(turningOff).rejects.toThrow('Not saved: your record changed since you asked.');
    expect(posts.map((p) => p.token)).toEqual(['token-a']);
    expect(statusOf()).toEqual({ 'token-a': 'active', 'token-b': 'active' });
    expect(trackProductEvent).not.toHaveBeenCalled(); // one cancel posted, no row written
  });

  it('a tab leaving (keepalive) sends every cancel at once, before any answer', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    server(async (token) => {
      if (token === 'token-a') await held; // the closing page never hears this one
      return 200;
    });
    const leaving = cancelReminders({ keepalive: true, count: false });
    await vi.waitFor(() => expect(posts.map((p) => p.token)).toEqual(['token-a', 'token-b']));
    release();
    await leaving;
    expect(statusOf()).toEqual({ 'token-a': 'cancelled', 'token-b': 'cancelled' });
  });

  it('a refused write cancels on the server but writes nothing and counts nothing', async () => {
    file.reminderOptIn = row('token-a', 'active', 1);
    refuseWrite.next = true;
    server();
    await expect(cancelReminders()).rejects.toThrow('Not saved: your record changed since you asked.');
    expect(statusOf()).toEqual({ 'token-a': 'active' });
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('a Drive row carries the proof; a Dropbox row goes bare; keepalive sends no proof', async () => {
    file.reminderOptIn = optIn(row('token-a', 'active', 2, { provider: 'google-drive' }), row('token-b', 'active', 1));
    server();
    await cancelReminders();
    expect(posts).toEqual([{ op: 'cancel', token: 'token-a', idToken: 'test-proof' }, { op: 'cancel', token: 'token-b' }]);
    posts.length = 0;
    file = createEmptyFile({ deviceId: 'dev_turn_off', now: '2026-11-01T00:00:00.000Z' });
    file.reminderOptIn = row('token-a', 'active', 2, { provider: 'google-drive' });
    await cancelReminders({ keepalive: true, count: false });
    expect(posts).toEqual([{ op: 'cancel', token: 'token-a' }]);
  });

  it('one token posts no reach event; the age gate counts neither', async () => {
    file.reminderOptIn = row('token-a', 'active', 1);
    server();
    await cancelReminders();
    expect(trackProductEvent.mock.calls.map(([name]) => name)).toEqual(['reminder_optout']);
    trackProductEvent.mockReset();
    file = createEmptyFile({ deviceId: 'dev_turn_off', now: '2026-11-01T00:00:00.000Z' });
    file.reminderOptIn = optIn(row('token-a', 'active', 2), row('token-b', 'active', 1));
    await cancelReminders({ count: false });
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('the event names a provider only from the closed list', async () => {
    file.reminderOptIn = { ...row('token-a', 'active', 1), provider: 'webdav' as ReminderTokenRow['provider'] };
    server();
    await cancelReminders();
    expect(trackProductEvent).toHaveBeenCalledWith('reminder_optout', undefined);
  });

  it('only cancelled rows: nothing posted, nothing written', async () => {
    file.reminderOptIn = optIn(row('token-a', 'cancelled', 2), row('token-b', 'cancelled', 1));
    server();
    await cancelReminders();
    expect(posts).toEqual([]);
    expect(edits).toBe(0);
  });
});

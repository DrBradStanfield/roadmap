// @vitest-environment jsdom
/**
 * US-09 AC49, AC50 (leads A28, A30): what "Use this browser only" does first
 * from the reconnect panel. A page that read its cloud exits at once; one that
 * never read it asks, in words true for what this browser holds. After another
 * tab's log-off this browser will keep nothing, so it asks the no-copy question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const page = vi.hoisted(() => ({ kind: 'local' as 'local' | 'cloud', status: 'saved' }));
vi.mock('../src/lib/roadmap-data', () => ({
  getBackendKind: () => page.kind, currentSaveStatus: () => page.status,
  flushRoadmapStore: vi.fn(), copyRecordToDevice: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false, clearAutoEnrolBlock: vi.fn() }));

describe('US-09 AC49/AC50: exitChoice, the pure decision', () => {
  const TABLE = [
    [true, true, 'exit'], // a sign-in that ended mid-session: the record is current
    [true, false, 'exit'],
    [false, true, 'askStale'], // never read, a copy or an unsaved edit here (AC50)
    [false, false, 'askEmpty'], // never read, nothing here (AC49)
  ] as const;
  it.each(TABLE)('cloud read %s, holds a copy here %s: %s', async (cloudRead, holdsHere, choice) => {
    const { exitChoice } = await import('./connect');
    expect(exitChoice(cloudRead, holdsHere)).toBe(choice);
  });
});

describe('US-09 AC49/AC50: exitChoice reads the page as it is now', () => {
  let connect: typeof import('./connect');
  let storage: typeof import('../src/lib/storage');
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    Object.assign(page, { kind: 'local', status: 'saved' });
    connect = await import('./connect');
    storage = await import('../src/lib/storage');
  });
  afterEach(() => localStorage.clear());

  it('a stored copy here, never read: askStale', () => {
    localStorage.setItem('health_roadmap_file_v2', '{}');
    expect(connect.exitChoice()).toBe('askStale');
  });

  it('an unsaved edit here, never read: askStale', () => {
    page.status = 'pending';
    expect(connect.exitChoice()).toBe('askStale');
  });

  it('nothing here, never read: askEmpty', () => {
    expect(connect.exitChoice()).toBe('askEmpty');
  });

  it('writes not allowed (another tab logged off): a stored file and an unsaved edit count for nothing, askEmpty', () => {
    localStorage.setItem('health_roadmap_file_v2', '{}');
    page.status = 'pending';
    storage.noteCloudPage('google-drive');
    storage.noteLogOffHeard();
    expect(storage.healthWritesAllowed()).toBe(false);
    expect(connect.exitChoice()).toBe('askEmpty');
  });

  it('the page read its cloud: exit, whatever is here', () => {
    page.kind = 'cloud';
    localStorage.setItem('health_roadmap_file_v2', '{}');
    expect(connect.exitChoice()).toBe('exit');
  });
});

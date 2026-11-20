/**
 * @vitest-environment jsdom
 *
 * US-06 AC13a through the web host: a cloud tab going away whose device copy
 * write the browser refuses (storage full) is reported once a session, with
 * the host's fixed message and the `mirror-write` tag, never the record.
 * Before, the departure write's catch was empty. Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WriteResult } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { BACKEND_KEY, webRecordHost } from './web-record-host';
import { Sentry } from '../lib/sentry';
const { scrubEvent: realScrubEvent } = await vi.importActual<typeof import('../lib/sentry')>('../lib/sentry');

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** A cloud whose save never answers: the tab closes before it lands. */
class StalledCloud extends MemoryAdapter {
  async write(): Promise<WriteResult> {
    return new Promise<WriteResult>(() => {});
  }
}

const add = (session: RecordSession, id: string) =>
  session.edit((file) => void file.measurements.push(createMeasurement({
    id, metricType: 'weight', value: 81.5, recordedAt: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z',
  })));

beforeEach(() => localStorage.setItem(BACKEND_KEY, 'memory'));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(Sentry.captureException).mockClear(); localStorage.clear(); });

describe('a cloud tab whose departure write the browser refuses (US-06 AC13a)', () => {
  it('sends one "Cloud sync failed" report tagged mirror-write, holding no record text; a second departure sends none', async () => {
    const tab = await RecordSession.open(webRecordHost(new StalledCloud(new MemoryCloud())));
    add(tab, 'synthetic-dose-row');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'health_roadmap_file_v2') throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tab.flushSync(); // hidden
    add(tab, 'synthetic-second-row');
    tab.flushSync(); // closed
    const calls = vi.mocked(Sentry.captureException).mock.calls;
    expect(calls).toHaveLength(1);
    const [error, hint] = calls[0] as [Error, { tags: Record<string, string> }];
    expect(error.message).toBe('Cloud sync failed');
    expect(hint.tags).toMatchObject({ area: 'cloud-sync', op: 'mirror-write', backend: 'memory', causeClass: 'DOMException' });
    expect(JSON.stringify(calls)).not.toMatch(/synthetic|81\.5/);
    // What leaves the browser: the real beforeSend scrubber keeps the op from its closed list.
    const sent = realScrubEvent({ type: undefined, tags: hint.tags, exception: { values: [{ type: 'Error', value: error.message }] } });
    expect(sent?.tags).toMatchObject({ area: 'cloud-sync', op: 'mirror-write', backend: 'memory' });
    expect(warn.mock.calls.filter(([line]) => line === 'Cloud sync failed')).toHaveLength(2);
  });
});

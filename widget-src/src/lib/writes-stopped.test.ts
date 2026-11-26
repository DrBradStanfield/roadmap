/**
 * US-09 AC59 (lead H410, root fix R6): `writesStopped` reads the typed reason set where the refusal was raised,
 * never the class or the words. A log-off refusal SyncManager rewraps after a write keeps its reason but says the
 * write may have landed, so it is not one, as the class test it replaces did not match it.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import { StorageError, type ReadResult } from '@roadmap/health-core/adapter';
import { SyncManager } from '@roadmap/health-core/sync-manager';
import { WritesStoppedError, writesStopped } from './error-diagnostics';
import { WRITES_STOPPED_CASES } from '../testing/writes-stopped-cases';

/** Writes land; the read after the write (the verify) is refused as after a log-off. */
class StopsAfterWrite extends MemoryAdapter {
  private reads = 0;
  async read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    if (this.reads++ > 0) throw new WritesStoppedError();
    return super.read(fileName, signal);
  }
}

describe('US-09 AC59: writesStopped', () => {
  it.each(WRITES_STOPPED_CASES)('$name: matches when it is not reported ($reports)', ({ error, reports }) => {
    expect(writesStopped(error())).toBe(reports === 0);
  });

  it('a plain Error, a non-Error and nothing are not a log-off refusal', () => {
    expect([new Error('On-device roadmap persistence stopped for logout.'), 'writes-stopped', undefined].map(writesStopped)).toEqual([false, false, false]);
  });

  it('the real SyncManager rewrap keeps the reason and is not matched, as the class test was not', async () => {
    const sync = new SyncManager(new StopsAfterWrite(), 'phone', ROADMAP_DOC, { now: () => '2026-11-26T00:00:00.000Z' });
    const error = await sync.save(ROADMAP_DOC.migrate(null, { deviceId: 'phone', now: '2026-11-26T00:00:00.000Z' })).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).not.toBeInstanceOf(WritesStoppedError);
    expect(error).toMatchObject({ reason: 'writes-stopped', outcome: 'may-have-landed' });
    expect(writesStopped(error)).toBe(false);
  });
});

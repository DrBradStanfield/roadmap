// Test support: what a cloud save does after it fails with `error`, read through RecordSession's public behaviour.
// 'other' when a retry is owed (`retryDue`); 'auth' when only a new sign-in mends it, so none is. Imported by tests only.
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { RecordSession } from '@roadmap/health-core/record-session';
import type { RecordHost } from '@roadmap/health-core/record-host';

/** A cloud whose record writes fail with `error` once armed. */
class FailingCloud extends MemoryAdapter {
  armed = false;
  constructor(private readonly error: unknown) { super(new MemoryCloud()); }
  async write(...args: Parameters<MemoryAdapter['write']>) {
    if (this.armed) throw this.error;
    return super.write(...args);
  }
}

export async function saveCauseOf(error: unknown): Promise<'auth' | 'other'> {
  const store = new FailingCloud(error);
  const host: RecordHost = {
    tier: 'cloud', store,
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'phone', clock: { now: () => Date.now() },
    timers: { set: () => ({}), clear: () => {} }, remoteChanged: () => {},
    failureCause: () => 'synthetic', report: () => {},
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false, wipe: async () => {}, opened: () => {},
    },
  };
  const session = await RecordSession.open(host);
  store.armed = true;
  if (!session.edit(() => {}, session.shownErase)) throw new Error('edit refused');
  await session.flush().then(() => { throw new Error('the save landed'); }, () => {});
  return session.retryDue ? 'other' : 'auth';
}

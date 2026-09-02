/**
 * US-32 · the one thing `dropbox-rest.ts` must not hand upwards: a bare
 * `TypeError` from `fetch`. Every other Dropbox behaviour is proved through
 * the widget adapter and the hosted server; what is proved here is that a dead
 * network arrives as a StorageError, so the hosted server can tell the
 * provider's failure from its own (AC17).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { DropboxAdapter } from './dropbox-rest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a network outage is the adapter’s failure, not an unknown one (US-32 AC17)', () => {
  it('turns `fetch`’s bare TypeError into a StorageError with a hint, on read and on write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const adapter = new DropboxAdapter('token');

    // Thunks, not promises: built eagerly, the second one rejects before the
    // loop reaches it and Node calls that an unhandled rejection.
    for (const attempt of [
      () => adapter.read(ROADMAP_FILE_NAME),
      () => adapter.write(ROADMAP_FILE_NAME, { a: 1 }, 'rev1'),
    ]) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StorageError);
      expect((failure as StorageError).message).toBe('Dropbox did not answer');
      expect((failure as StorageError).hint).toContain('Try once more');
    }
  });
});

/**
 * US-09 AC43: a Google Drive record or named-file save that goes
 * out and gets no answer may have landed, so its failure says so, as Dropbox,
 * GitHub and WebDAV saves already do (AC13d, AC13f). Drive's create (POST)
 * and update (PATCH) carried the unreachable hint, "Try once more", which the
 * hosted connector passes to the assistant about a change that may already be
 * in the file. Found by @robertaustinbell's untangle audit (bug 6).
 * Real DriveAdapter; synthetic HTTP only, no live provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from './adapter';
import { DriveAdapter } from './drive-rest';

const LANDED = 'The change may have landed. Read the record again before trying it a second time.';

/** Lookups answer; the upload (POST or PATCH to the upload host) is lost. */
function drive(opts: { fileExists: boolean; uploadAnswers?: boolean; readsAnswer?: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.includes('/upload/')) {
      if (!opts.uploadAnswers) throw new TypeError('terminated');
      return Response.json({ id: 'f1', version: '4' });
    }
    if (opts.readsAnswer === false) throw new TypeError('fetch failed');
    if (url.includes('fields=version')) return Response.json({ version: '3' });
    if (url.includes('mimeType')) return Response.json({ files: [{ id: 'folder1', name: 'Health Roadmap' }] });
    if (url.includes('alt=media')) return Response.json({ a: 1 });
    if (init.method === undefined && url.includes('/files?q=')) return Response.json({ files: opts.fileExists ? [{ id: 'f1' }] : [] });
    throw new Error(`unexpected request ${url}`);
  }));
}

const failure = (p: Promise<unknown>) => p.then(() => null, (error: unknown) => error as StorageError);

describe('US-09 AC43: a Drive save that gets no answer may have landed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an update (PATCH) with no answer says the change may have landed', async () => {
    drive({ fileExists: true });
    const error = await failure(new DriveAdapter('synthetic-token').write('chat-history.json', { a: 2 }, JSON.stringify(['f1', '3'])));
    expect(error).toBeInstanceOf(StorageError);
    expect(error!.hint).toBe(LANDED);
  });

  it('a first create (POST) with no answer says the same', async () => {
    drive({ fileExists: false });
    const error = await failure(new DriveAdapter('synthetic-token').write('chat-history.json', { a: 2 }, null));
    expect(error!.hint).toBe(LANDED);
  });

  it('a read that gets no answer still says to try once more', async () => {
    drive({ fileExists: true, readsAnswer: false });
    const error = await failure(new DriveAdapter('synthetic-token').read('chat-history.json'));
    expect(error!.hint).toMatch(/^Try once more/);
  });
});

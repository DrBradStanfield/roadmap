/**
 * US-09 AC42: a 409 from Dropbox means "no file here" only when Dropbox says
 * `not_found`. Dropbox answers 409 for every endpoint error, and the read, the
 * listing and the delete each took any 409 as absence: a locked or restricted
 * record read as an empty one, and a refused delete reported success. Found
 * by @robertaustinbell's untangle audit (bug 7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import { DropboxAdapter, dropboxListFolder, dropboxRead } from './dropbox-rest';

afterEach(() => {
  vi.unstubAllGlobals();
});

const reply409 = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 409 })));
const summary = (s: string) => JSON.stringify({ error_summary: s });
const failure = (p: Promise<unknown>) => p.then(() => 'resolved', (error: unknown) => error);

describe('US-09 AC42: only a not_found 409 is absence', () => {
  it('a missing record reads as empty, as before', async () => {
    reply409(summary('path/not_found/..'));
    expect(await dropboxRead('token', ROADMAP_FILE_NAME)).toEqual({ body: null, version: null });
  });

  it.each(['path/restricted_content/..', 'path/locked/..', 'unsupported_file/..', 'not json'])(
    'a read refused with %s is a StorageError, not an empty record', async (body) => {
      reply409(body === 'not json' ? body : summary(body));
      const error = await failure(dropboxRead('token', ROADMAP_FILE_NAME));
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).status).toBe(409);
    },
  );

  it('the failure names only Dropbox\'s summary, never the rest of the body', async () => {
    reply409(JSON.stringify({ error_summary: 'path/locked/..', error: { path: '/Lab results/ldl.pdf' }, user_message: { text: 'secret' } }));
    const error = await failure(dropboxRead('token', ROADMAP_FILE_NAME)) as StorageError;
    expect(error.message).toBe('Dropbox read failed (409): path/locked/..');
    reply409('not json');
    expect((await failure(dropboxRead('token', ROADMAP_FILE_NAME)) as StorageError).message).toBe('Dropbox read failed (409): unreadable reply');
  });

  it('a folder that does not exist lists as empty; a refused listing fails', async () => {
    reply409(summary('path/not_found/'));
    expect(await dropboxListFolder('token', 'imports')).toEqual([]);
    reply409(summary('path/malformed_path/'));
    expect(await failure(dropboxListFolder('token', 'imports'))).toBeInstanceOf(StorageError);
  });

  it('deleting a file already gone succeeds; a refused delete fails', async () => {
    const adapter = new DropboxAdapter('token');
    reply409(summary('path_lookup/not_found/..'));
    await expect(adapter.remove('chat-history.json')).resolves.toBeUndefined();
    reply409(summary('too_many_write_operations/..'));
    expect(await failure(adapter.remove('chat-history.json'))).toBeInstanceOf(StorageError);
  });
});

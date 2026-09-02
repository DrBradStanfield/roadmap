/**
 * US-32 · the one thing `dropbox-rest.ts` must not hand upwards: a bare
 * `TypeError` from `fetch`. Every other Dropbox behaviour is proved through
 * the widget adapter and the hosted server; what is proved here is that a dead
 * network arrives as a StorageError, so the hosted server can tell the
 * provider's failure from its own (AC17).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, fetchOrFail, ROADMAP_FILE_NAME, StorageError } from './adapter';
import { describeStorageFailure } from './sync-manager';
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

describe('a truncated answer is the adapter’s failure too (US-32 AC17)', () => {
  it('turns a body that dies mid-stream into the same StorageError', async () => {
    // undici's `TypeError: terminated`: `fetch` resolved, the socket died while
    // the body was still arriving. The rejection lands on the body read, not on
    // `fetch`, so it only becomes a StorageError if `fetchOrFail` buffers.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }),
      { status: 200 },
    )));
    const failure = await new DropboxAdapter('token').read(ROADMAP_FILE_NAME).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toBe('Dropbox did not answer');
    expect((failure as StorageError).hint).toContain('Try once more');
  });

  it('keeps status, headers and bytes intact when the body arrives whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ weight_kg: 80 }), {
      status: 200,
      headers: { 'Dropbox-API-Result': JSON.stringify({ rev: 'rev9' }) },
    })));
    expect(await new DropboxAdapter('token').read(ROADMAP_FILE_NAME))
      .toEqual({ body: { weight_kg: 80 }, version: 'rev9' });
  });
});

describe('a 2xx with a body that is not JSON is a failed write, not a crash', () => {
  it('reports “returned no rev” when Dropbox answers 200 with garbage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })));
    const failure = await new DropboxAdapter('token')
      .write(ROADMAP_FILE_NAME, { a: 1 }, 'rev1')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toContain('returned no rev');
  });
});

describe('a provider that never answers is bounded, not eternal (US-32 AC17)', () => {
  it('aborts after the timeout and words it as the provider not answering', async () => {
    // Faithful to `fetch`: it hangs until its signal aborts, then rejects.
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const started = Date.now();
    const failure = await fetchOrFail('Dropbox', 'https://example.test/x', { timeoutMs: 20 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toBe('Dropbox did not answer');
    expect((failure as StorageError).hint).toContain('Try once more');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('leaves a fast answer alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const res = await fetchOrFail('Dropbox', 'https://example.test/x', { timeoutMs: 20_000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('a runtime without `AbortSignal.timeout` still saves (US-32 AC17)', () => {
  it('runs the call unbounded rather than throwing a TypeError', async () => {
    // Safari 14/15 has no `AbortSignal.timeout`, and the widget's build target
    // ships untranspiled to it. Called unguarded, every Drive/Dropbox read and
    // save there died on a bare TypeError before `fetch` was ever reached.
    vi.stubGlobal('AbortSignal', {});
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Response('{"ok":true}', { status: 200 });
    }));
    const res = await fetchOrFail('Dropbox', 'https://example.test/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

/**
 * `strict_conflict` is what US-32 AC16 rests on: without it Dropbox ACCEPTS a
 * rev-conditional update whose rev does not match because the file was DELETED,
 * silently re-creating a record the user erased. Drive's half of this is covered
 * in `drive-rest.test.ts`; Dropbox is the live provider and had nothing.
 */
describe('a rev-conditional write refuses to re-create a deleted record (US-32 AC16)', () => {
  /** The `Dropbox-API-Arg` header of the last upload, parsed. */
  function uploadArg(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls.at(-1)![1] as RequestInit;
    return JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg']);
  }

  it('asks for update + strict_conflict when it knows the rev it is replacing', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ rev: 'rev2' }));
    vi.stubGlobal('fetch', fetchSpy);
    await new DropboxAdapter('token').write(ROADMAP_FILE_NAME, { a: 1 }, 'rev1');
    const arg = uploadArg(fetchSpy);
    expect(arg.mode).toEqual({ '.tag': 'update', update: 'rev1' });
    expect(arg.strict_conflict).toBe(true);
    expect(arg.autorename).toBe(false); // a second file is not a save
  });

  it('asks for add — never strict_conflict — on a first-ever create', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ rev: 'rev1' }));
    vi.stubGlobal('fetch', fetchSpy);
    await new DropboxAdapter('token').write(ROADMAP_FILE_NAME, { a: 1 }, null);
    const arg = uploadArg(fetchSpy);
    expect(arg.mode).toEqual({ '.tag': 'add' });
    expect(arg.strict_conflict).toBe(false);
  });

  it('turns Dropbox’s 409 into a ConflictError, so SyncManager re-reads instead of clobbering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error_summary: 'path/conflict/file/..' }),
      { status: 409 },
    )));
    const failure = await new DropboxAdapter('token')
      .write(ROADMAP_FILE_NAME, { a: 1 }, 'stale-rev')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConflictError);
    // A conflict is not a storage outage: the caller must retry the merge, not
    // tell the user their provider is down.
    expect(failure).not.toBeInstanceOf(StorageError);
    expect(describeStorageFailure(failure, 'The record in Dropbox').hint).toContain('Read the record again');
  });
});

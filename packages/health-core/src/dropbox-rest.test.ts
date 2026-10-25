/**
 * US-32 · the one thing `dropbox-rest.ts` must not hand upwards: a bare
 * `TypeError` from `fetch`. Every other Dropbox behaviour is proved through
 * the widget adapter and the hosted server; what is proved here is that a dead
 * network arrives as a StorageError, so the hosted server can tell the
 * provider's failure from its own (AC17).
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ConflictError, fetchOrFail, ROADMAP_FILE_NAME, StorageError } from './adapter';
import { describeStorageFailure } from './sync-manager';
import { dropboxApiArg, dropboxWrite, DropboxAdapter } from './dropbox-rest';

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
  function uploadArg(fetchSpy: Mock<(...args: any[]) => Promise<Response>>): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// US-35 AC2 — the folder listing and the download by id
// ---------------------------------------------------------------------------
import { dropboxDownload, dropboxListFolder } from './dropbox-rest';

describe('US-35 AC2 — dropboxListFolder lists files only, and follows has_more', () => {
  it('drops folders and deleted entries, keeps id/name/size/modified, continues on the cursor', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/list_folder')) {
        return Response.json({
          entries: [
            { '.tag': 'file', id: 'id:one', name: 'labs.pdf', size: 1234, server_modified: '2026-09-01T00:00:00Z' },
            { '.tag': 'folder', id: 'id:dir', name: 'Lab results' },
            { '.tag': 'deleted', name: 'gone.pdf' },
          ],
          cursor: 'c1', has_more: true,
        });
      }
      return Response.json({ entries: [{ '.tag': 'file', id: 'id:two', name: 'health.zip', size: 99 }], cursor: 'c2', has_more: false });
    }));
    const entries = await dropboxListFolder('token', '');
    expect(entries).toEqual([
      { id: 'id:one', name: 'labs.pdf', size: 1234, modified: '2026-09-01T00:00:00Z' },
      { id: 'id:two', name: 'health.zip', size: 99, modified: '' },
    ]);
    expect(calls[0].body).toEqual({ path: '', recursive: false, include_deleted: false });
    expect(calls[1].url).toContain('/list_folder/continue');
    expect(calls[1].body).toEqual({ cursor: 'c1' });
  });

  it('stops following has_more once `limit` entries are in hand (US-37 AC1)', async () => {
    let pages = 0;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      pages++;
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ entries: [{ '.tag': 'file', id: `id:${pages}`, name: `scan-${pages}.png`, size: 1 }], cursor: `c${pages}`, has_more: true });
    }));
    const entries = await dropboxListFolder('token', '', undefined, 2);
    expect(entries.map((e) => e.name)).toEqual(['scan-1.png', 'scan-2.png']);
    expect(pages).toBe(2);
    // The first request asks Dropbox for that many, so the page itself is small.
    expect(bodies[0].limit).toBe(2);
  });

  it('lists a folder that does not exist as empty, and a subfolder by name', async () => {
    const paths: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      paths.push(JSON.parse(String(init.body)).path);
      return new Response('{"error_summary":"path/not_found/"}', { status: 409 });
    }));
    expect(await dropboxListFolder('token', 'imports')).toEqual([]);
    expect(paths).toEqual(['/imports']);
  });

  it('downloads by listing id as is, and by folder-relative name with a leading slash', async () => {
    const args: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      args.push((init.headers as Record<string, string>)['Dropbox-API-Arg']);
      return new Response(new Uint8Array([37, 80, 68, 70]));
    }));
    expect([...(await dropboxDownload('token', 'id:one'))]).toEqual([37, 80, 68, 70]);
    await dropboxDownload('token', 'Lab results/x.pdf');
    expect(args.map((a) => JSON.parse(a).path)).toEqual(['id:one', '/Lab results/x.pdf']);
  });

  it('a download that is refused is a StorageError carrying the status, not a silent empty file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 409 })));
    const failure = await dropboxDownload('token', 'id:missing').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).status).toBe(409);
  });
});

// The hosted connector's listing (US-35 AC2): one level, files only.
describe('US-35 AC2 — dropboxListFolder leaves folders and deleted entries out', () => {
  const page = {
    entries: [
      { '.tag': 'folder', id: 'id:labs', name: 'Labs', path_display: '/Labs', path_lower: '/labs' },
      { '.tag': 'folder', id: 'id:2025', name: '2025', path_display: '/Labs/2025', path_lower: '/labs/2025' },
      { '.tag': 'file', id: 'id:one', name: 'a.pdf', path_display: '/Labs/2025/a.pdf', size: 12, server_modified: '2026-09-01T00:00:00Z' },
      { '.tag': 'file', id: 'id:low', name: 'b.png', path_lower: '/labs/b.png' },
      { '.tag': 'deleted', name: 'gone.pdf', path_display: '/Labs/gone.pdf' },
    ],
    cursor: 'c1', has_more: true,
  };

  it('dropboxListFolder (the hosted connector, US-35 AC2) still asks for one level and answers files only, without paths', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(url.endsWith('/list_folder') ? page : { entries: [], has_more: false });
    }));
    expect(await dropboxListFolder('token', '')).toEqual([
      { id: 'id:one', name: 'a.pdf', size: 12, modified: '2026-09-01T00:00:00Z' },
      { id: 'id:low', name: 'b.png', size: 0, modified: '' },
    ]);
    expect(bodies[0]).toEqual({ path: '', recursive: false, include_deleted: false });
  });
});

describe('a caller’s signal reaches `fetch` on every call the import makes (US-35 AC5)', () => {
  it('aborts the request in flight when the caller aborts, and reports the abort as the adapter’s failure', async () => {
    const fetchSpy = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new DropboxAdapter('token');
    const calls: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (s) => adapter.read(ROADMAP_FILE_NAME, s),
      (s) => adapter.write(ROADMAP_FILE_NAME, { a: 1 }, 'rev1', s),
      (s) => adapter.readDocument('id:abc', s),
      (s) => adapter.list('', s),
      (s) => adapter.remove('imports/pending-x.json', s),
    ];
    for (const call of calls) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort();
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StorageError);
      expect((failure as StorageError).cause).toMatchObject({ name: 'AbortError' });
      expect((fetchSpy.mock.calls.at(-1)![1] as RequestInit).signal!.aborted).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(calls.length);
  });
});

/**
 * HTTP headers carry ISO-8859-1 only; `fetch` throws on anything else before
 * a request leaves the browser (Sentry 7715862604, an em dash in a letter's
 * title). Dropbox's documented rule for `Dropbox-API-Arg` is JSON with every
 * non-ASCII code point escaped as `\uXXXX`, which keeps the pretty file name.
 */
describe('dropboxApiArg — an ASCII header for a non-ASCII path (US-13 AC1, US-35 AC2)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ['em dash', '—', '\\u2014'],
    ['macron', 'ā', '\\u0101'],
    ['emoji', '🩺', '\\ud83e\\ude7a'],
  ])('escapes a %s as \\uXXXX and JSON.parse gives the path back', (_, ch, escaped) => {
    const header = dropboxApiArg({ path: `/a ${ch} b` });
    expect(header).toContain(escaped);
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(header)).toEqual({ path: `/a ${ch} b` });
  });

  it('every content call names its file through it (download by name, upload)', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"rev":"r1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await dropboxDownload('t', 'Lab results/2026-01-01 Hēmi.pdf');
    await dropboxWrite('t', 'imports/pending-—.json', {}, null);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls as unknown as RequestInit[][]) {
      const headers = call[1].headers as Record<string, string>;
      expect(headers['Dropbox-API-Arg']).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

// The hosted MCP server constructs `new DropboxAdapter(token)` and must keep
// refusing document writes word for word; only an explicit opt-in writes.
describe('document writes: refused by default, written only on opt-in', () => {
  it('a bare adapter refuses with the same message and calls nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(new DropboxAdapter('token').writeDocument('Lab results/a.pdf', new Blob(['x'])))
      .rejects.toThrow(new StorageError('The hosted server does not write uploaded documents.'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an opted-in adapter overwrites at the folder-relative path, its non-ASCII name escaped', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ rev: 'r1' }));
    vi.stubGlobal('fetch', fetchSpy);
    const bytes = new Blob(['pdf bytes']);
    await new DropboxAdapter('token', { documents: 'write' }).writeDocument('Clinic letters/2026-01-01 Letter — GP.pdf', bytes);
    const [url, init] = (fetchSpy as Mock).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(headers.Authorization).toBe('Bearer token');
    expect(headers['Dropbox-API-Arg']).toBe(dropboxApiArg({ path: '/Clinic letters/2026-01-01 Letter — GP.pdf', mode: { '.tag': 'overwrite' }, autorename: false, mute: true }));
    expect(init.body).toBe(bytes);
  });

  it('an opted-in write Dropbox refuses is a StorageError with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('too big', { status: 413 })));
    const failure = await new DropboxAdapter('token', { documents: 'write' }).writeDocument('a.pdf', new Blob(['x'])).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toBe('Dropbox document write failed (413).');
    expect((failure as StorageError).status).toBe(413);
  });
});

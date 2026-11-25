// @vitest-environment jsdom
/**
 * US-10 AC16 (root fix R6, PR 3): each adapter names the outcome of its own
 * failure where it raises it, a typed field on StorageError, and its reason
 * where it can tell. Each row calls the real adapter's record write straight
 * (no SyncManager, so no reader fills a field in) against synthetic HTTP.
 * Then: the field travels with the error, through SyncManager's rewrap and a
 * field-by-field copy (no production path copies errors; the iPhone bridge
 * sends strings). Document uploads name their outcome too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { DriveAdapter, driveUploadDocument } from '@roadmap/health-core/drive-rest';
import { DropboxAdapter, dropboxUploadDocument } from '@roadmap/health-core/dropbox-rest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_DOC } from '@roadmap/health-core/roadmap-doc';
import { SyncManager } from '@roadmap/health-core/sync-manager';
import { mayHaveLanded, uncertainWrite } from '@roadmap/health-core/write-refusal';
import { GitHubAdapter } from './github';
import { LocalStorageAdapter } from './local-storage-adapter';
import { WebDavAdapter } from './webdav';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'phone', now: NOW };
type Kind = 'dropbox' | 'github' | 'webdav' | 'drive-check' | 'drive-update';
type Failure = number | 'drop' | 'rate-limit';

function failWith(failure: Failure): Response {
  if (failure === 'drop') throw new TypeError('terminated');
  if (failure === 'rate-limit') return Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 });
  return new Response('{"error":"synthetic"}', { status: failure });
}

/** Every call answers but the one under test: the upload, or for drive-check the version read before it. */
function stub(kind: Kind, failure: Failure): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (kind === 'dropbox' && url.endsWith('/files/upload')) return failWith(failure);
    if (kind === 'github' || kind === 'webdav') return method === 'PUT' ? failWith(failure) : Response.json({ private: true });
    if (url.includes('/upload/')) return kind === 'drive-update' ? failWith(failure) : Response.json({ id: 'r1', version: '4' });
    if (url.includes('/files?q=')) return Response.json({ files: [{ id: 'r1', createdTime: '2026-01-01T00:00:00.000Z' }] });
    if (url.includes('fields=version')) return kind === 'drive-check' ? failWith(failure) : Response.json({ version: '3' });
    throw new Error(`unexpected request ${method} ${url}`);
  }));
}

function adapterOf(kind: Kind): StorageAdapter {
  if (kind === 'dropbox') return new DropboxAdapter('test-token-good');
  if (kind === 'github') return new GitHubAdapter({ token: 'test-token-good', owner: 'synthetic', repo: 'synthetic-private' });
  if (kind === 'webdav') return new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' });
  return new DriveAdapter('test-token-good');
}

async function raised(kind: Kind, failure: Failure): Promise<{ outcome?: string; reason?: string }> {
  stub(kind, failure);
  const version = kind.startsWith('drive') ? JSON.stringify(['r1', '3']) : 'v1';
  const error = await adapterOf(kind).write('chat-history.json', { meta: { lamport: 1 } }, version).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageError);
  const { outcome, reason } = error as StorageError;
  return { outcome, reason };
}

afterEach(() => vi.unstubAllGlobals());

describe('US-10 AC16: each adapter names its failure\'s outcome and reason', () => {
  const rows: Array<[Kind, Failure, string, string | undefined]> = [
    ['dropbox', 400, 'refused', undefined],
    ['dropbox', 401, 'refused', 'auth'],
    ['dropbox', 403, 'refused', 'forbidden'],
    ['dropbox', 500, 'may-have-landed', undefined],
    ['dropbox', 429, 'may-have-landed', undefined],
    ['dropbox', 'drop', 'may-have-landed', undefined],
    ['github', 401, 'refused', 'auth'],
    ['github', 404, 'refused', undefined],
    ['github', 503, 'may-have-landed', undefined],
    ['github', 'drop', 'may-have-landed', undefined],
    ['webdav', 403, 'refused', 'forbidden'],
    ['webdav', 422, 'refused', undefined],
    ['webdav', 408, 'may-have-landed', undefined],
    ['webdav', 'drop', 'may-have-landed', undefined],
    // A named Drive file's version check sends no write: its failure got no answer, or was refused.
    ['drive-check', 500, 'no-answer', undefined],
    ['drive-check', 429, 'no-answer', undefined],
    ['drive-check', 'drop', 'no-answer', undefined],
    ['drive-check', 401, 'refused', 'auth'],
    ['drive-check', 'rate-limit', 'refused', 'rate-limited'],
    ['drive-update', 500, 'may-have-landed', undefined],
    ['drive-update', 'drop', 'may-have-landed', undefined],
    ['drive-update', 'rate-limit', 'refused', 'rate-limited'],
  ];
  it.each(rows)('%s, %s: outcome %s, reason %s', async (kind, failure, outcome, reason) => {
    expect(await raised(kind, failure)).toEqual({ outcome, reason });
  });

  it('localStorage: a full store refuses, raised refused; writes stopped by a log-off, refused too', () => {
    const adapter = new LocalStorageAdapter();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    let error: unknown;
    try { adapter.writeSync('health-roadmap.json', { meta: { lamport: 1 } }, null); } catch (e) { error = e; }
    spy.mockRestore();
    expect((error as StorageError).outcome).toBe('refused');
  });
});

describe('US-10 AC16: a document upload names its outcome: a definite 4xx refused, any other answer may have landed', () => {
  type DocKind = 'dropbox' | 'github' | 'webdav' | 'drive';
  /** The upload answers `status`; every other call (GitHub's private-repo check) answers. */
  async function uploadFailure(kind: DocKind, status: number): Promise<string | undefined> {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init: RequestInit = {}) =>
      (init.method ?? 'GET') === 'GET' ? Response.json({ private: true }) : new Response('{"error":"synthetic"}', { status })));
    const bytes = new Blob(['%PDF synthetic']);
    const upload = kind === 'dropbox' ? dropboxUploadDocument('test-token-good', 'Letters/a.pdf', bytes)
      : kind === 'drive' ? driveUploadDocument('test-token-good', 'a.pdf', bytes, 'folder1')
        : (kind === 'github' ? adapterOf('github') : adapterOf('webdav')).writeDocument!('Letters/a.pdf', bytes);
    const error = await upload.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    return (error as StorageError).outcome;
  }
  const rows: Array<[DocKind, number, string]> = (['dropbox', 'github', 'webdav', 'drive'] as DocKind[]).flatMap((kind): Array<[DocKind, number, string]> => [
    [kind, 500, 'may-have-landed'],
    [kind, 503, 'may-have-landed'],
    [kind, 408, 'may-have-landed'],
    [kind, 403, 'refused'],
  ]);
  it.each(rows)('%s, %s: %s', async (kind, status, outcome) => {
    expect(await uploadFailure(kind, status)).toBe(outcome);
  });
});

/** A store whose writes land, then whose re-read fails with `error`. */
class LandThenFail extends MemoryAdapter {
  wrote = false;
  constructor(private readonly error: Error) { super(new MemoryCloud()); }
  async read(name: string) {
    if (this.wrote) throw this.error;
    return super.read(name);
  }
  async write(...args: Parameters<MemoryAdapter['write']>) {
    const result = await super.write(...args);
    this.wrote = true;
    return result;
  }
}

describe('US-10 AC16: the outcome is a field, so it survives a rewrap and a copy', () => {
  it('a failure after a write keeps may-have-landed through SyncManager\'s rewrap, its reason too', async () => {
    const refusedAfter = new StorageError('Google Drive read failed (401)', undefined, undefined, 401);
    expect(refusedAfter.outcome).toBe('refused');
    const sync = new SyncManager(new LandThenFail(refusedAfter), 'phone', ROADMAP_DOC, { now: () => NOW });
    const error = await sync.save(ROADMAP_DOC.migrate(null, ctx)).then(() => null, (e: unknown) => e);
    expect(error).not.toBe(refusedAfter);
    expect(error).toMatchObject({ outcome: 'may-have-landed', reason: 'auth', cause: refusedAfter });
    expect(mayHaveLanded(error)).toBe(true);
  });

  it('a copy made field by field, as a second bundle would, keeps the outcome; the mark it replaced lived in one module', () => {
    const marked = uncertainWrite(new StorageError('Dropbox write failed (503)', undefined, undefined, 503));
    const copy = Object.assign(new Error(marked.message), marked);
    expect(mayHaveLanded(copy)).toBe(true);
    expect(mayHaveLanded(Object.assign(new Error('a refusal'), new StorageError('refused', undefined, undefined, 400)))).toBe(false);
  });
});

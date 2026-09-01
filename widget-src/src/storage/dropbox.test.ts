/**
 * Dropbox write preconditions — the deleted-file resurrection guard.
 *
 * Dropbox's `update` WriteMode is NOT strict by default: a write whose `rev`
 * doesn't match because the file was DELETED is accepted, and the path is
 * silently re-created. For this app that means a stale device flush can bring
 * back a record the user erased. `strict_conflict: true` turns that case into a
 * 409 conflict, which the adapter already maps to ConflictError and the
 * SyncManager already handles by re-reading and re-merging.
 *
 * Dropbox docs (CommitInfo.strict_conflict): "always return a conflict error
 * when mode = WriteMode.update and the given 'rev' doesn't match the existing
 * file's 'rev', even if the existing file has been deleted."
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '@roadmap/health-core';
import { DropboxAdapter } from './dropbox';
import { SyncManager } from '@roadmap/health-core';
import { ROADMAP_DOC } from './roadmap-store';
import {
  ConflictError,
  ROADMAP_FILE_NAME,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';

const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };

function makeStorage(seed: Record<string, string> = {}): Storage {
  const s = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

/** A connected adapter with a token that is nowhere near expiry (no refresh call). */
function connectedAdapter(): DropboxAdapter {
  vi.stubGlobal('localStorage', makeStorage({
    health_roadmap_dropbox_tokens: JSON.stringify({
      accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000,
    }),
  }));
  return new DropboxAdapter(CONFIG);
}

/** The upload args the adapter sent, parsed out of the Dropbox-API-Arg header. */
function uploadArg(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg']);
}

describe('DropboxAdapter.write — strict_conflict', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends strict_conflict on a rev-conditional (update) write', async () => {
    const adapter = connectedAdapter();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rev: 'rev2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await adapter.write(ROADMAP_FILE_NAME, { a: 1 }, 'rev1');

    const arg = uploadArg(fetchMock);
    expect(arg.mode).toEqual({ '.tag': 'update', update: 'rev1' });
    expect(arg.strict_conflict).toBe(true);
  });

  it('does not set strict_conflict on a first create (add mode already conflicts)', async () => {
    const adapter = connectedAdapter();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rev: 'rev1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await adapter.write(ROADMAP_FILE_NAME, { a: 1 }, null);

    const arg = uploadArg(fetchMock);
    expect(arg.mode).toEqual({ '.tag': 'add' });
    expect(arg.strict_conflict).toBe(false);
  });

  it('maps the deleted-path 409 that strict_conflict produces to ConflictError', async () => {
    const adapter = connectedAdapter();
    // What Dropbox returns for an update whose rev no longer exists.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        error_summary: 'path/conflict/file/...',
        error: { '.tag': 'path', reason: { '.tag': 'conflict' } },
      }),
      { status: 409 },
    )));

    await expect(adapter.write(ROADMAP_FILE_NAME, { a: 1 }, 'stale-rev'))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

/**
 * What the SyncManager does with that ConflictError when the file is GONE.
 * Traced, not assumed: the retry re-reads (404 → {body:null}), merges the local
 * file against a FRESH empty base, and writes in `add` mode. So the outcome is
 * a clean re-create from the merge of this device's own state — never a stale
 * rev-mismatched write landing unnoticed on a path someone else deleted.
 */
class DeletedFileAdapter implements StorageAdapter {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox (deleted-file stub)';
  writes: Array<{ body: object; expectedVersion: string | null }> = [];
  /** Set while the caller still believes the (now deleted) file is at this rev. */
  constructor(private staleVersion: string | null) {}

  async connect(): Promise<void> {}
  isConnected(): boolean { return true; }
  async disconnect(): Promise<void> {}

  async read(): Promise<ReadResult> {
    // First read hands out the stale rev the caller is about to write against;
    // the file itself is already deleted, so there is no body. Afterwards the
    // caller has seen the deletion and reads as a plain not-found.
    const version = this.staleVersion;
    this.staleVersion = null;
    return { body: null, version };
  }

  async write(_f: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    this.writes.push({ body, expectedVersion });
    // strict_conflict semantics: a rev-conditional write to a deleted path fails.
    if (expectedVersion != null) throw new ConflictError('Dropbox write conflict: path/conflict/file');
    return { version: 'rev-new' };
  }

  async readDocument(): Promise<Blob> { throw new Error('not used'); }
  async writeDocument(): Promise<void> {}
}

describe('SyncManager.save against a DELETED Dropbox file', () => {
  it('re-creates from the merge instead of landing a silent stale write', async () => {
    const adapter = new DeletedFileAdapter('stale-rev');
    const sync = new SyncManager(adapter, 'device-a', { ...ROADMAP_DOC, verify: false });

    const local: RoadmapFile = createEmptyFile({ deviceId: 'device-a', now: '2024-01-01T00:00:00.000Z' });
    local.measurements.push(createMeasurement({
      id: 'meas-1', metricType: 'weight', value: 80,
      recordedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
    }));

    const result = await sync.save(local);

    // Attempt 1 was rejected (stale rev on a deleted path); attempt 2 created it.
    expect(result.attempts).toBe(1);
    expect(adapter.writes.map((w) => w.expectedVersion)).toEqual(['stale-rev', null]);
    expect(result.file.measurements.map((m) => m.id)).toEqual(['meas-1']);
  });
});

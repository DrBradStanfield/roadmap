/**
 * US-09 AC6c: a browser adapter that throws after a provider answered puts
 * the HTTP status on its StorageError, so `failureTags` reads a refused token
 * (401), a rate limit (429) and an outage (5xx) apart on a fixed-message
 * capture. Before this, the Dropbox and Drive OAuth exchanges, token
 * refreshes and document calls carried the status only inside the message,
 * which the capture drops, so every one of them read `httpStatus=none`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core';
import { DropboxAdapter } from './dropbox';
import { GoogleDriveAdapter, DRIVE_FILE_SCOPE } from './drive';
import { failureTags } from '../lib/error-diagnostics';

const STATUSES: Array<[number, string]> = [[400, '4xx'], [401, '401'], [429, '429'], [503, '5xx']];

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

/** Every request answers with this status and a provider-shaped body. */
function answerAll(status: number): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"provider prose"}', { status })));
}

/** The page as the provider returns it: our PKCE entry in place, `?code` in the URL. */
function returnedWithCode(pkceKey: string, query: string): void {
  vi.stubGlobal('sessionStorage', makeStorage({ [pkceKey]: JSON.stringify({ verifier: 'v', state: 's' }) }));
  vi.stubGlobal('window', { location: { search: query }, history: { replaceState: vi.fn() } });
}

async function tagsOf(p: Promise<unknown>): Promise<{ errorClass: string; httpStatus: string }> {
  const err = await p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
  return failureTags(err);
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dropbox: the HTTP status reaches failureTags (US-09 AC6c)', () => {
  const CONFIG = { clientId: 'test-app-key', redirectUri: 'https://example.com/' };
  const TOKENS = 'health_roadmap_dropbox_tokens';

  it.each(STATUSES)('OAuth code exchange answering %i reads %s', async (status, tag) => {
    returnedWithCode('health_roadmap_dropbox_pkce', '?code=c&state=s');
    answerAll(status);
    expect(await tagsOf(DropboxAdapter.completeRedirect(CONFIG))).toEqual({ errorClass: 'StorageError', httpStatus: tag });
  });

  it('a refused token refresh reads its status', async () => {
    localStorage.setItem(TOKENS, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 0 }));
    answerAll(400);
    expect((await tagsOf(new DropboxAdapter(CONFIG).writeDocument('a.pdf', new Blob(['x'])))).httpStatus).toBe('4xx');
  });

  it('a document write and an rpc call read their status', async () => {
    localStorage.setItem(TOKENS, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 }));
    answerAll(503);
    expect((await tagsOf(new DropboxAdapter(CONFIG).writeDocument('a.pdf', new Blob(['x'])))).httpStatus).toBe('5xx');
    answerAll(429);
    expect((await tagsOf(new DropboxAdapter(CONFIG).accountEmail())).httpStatus).toBe('429');
  });
});

describe('Google Drive: the HTTP status reaches failureTags (US-09 AC6c)', () => {
  const CONFIG = {
    clientId: 'test-client-id',
    scope: `openid email ${DRIVE_FILE_SCOPE}`,
    redirectUri: 'https://example.com/',
    exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
  };
  const TOKENS = 'health_roadmap_gdrive_tokens';
  const STORED = 'health_roadmap_gdrive';

  /** Connected, folder known and named, so no lookup runs before the call under test. */
  function connected(expiresAt = Date.now() + 3_600_000): GoogleDriveAdapter {
    localStorage.setItem(TOKENS, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt }));
    localStorage.setItem(STORED, JSON.stringify({ folderId: 'F', folderName: 'Health Plan by Dr Brad', fileIds: { [ROADMAP_FILE_NAME]: 'R' } }));
    return new GoogleDriveAdapter(CONFIG);
  }

  it.each(STATUSES)('OAuth code exchange answering %i reads %s', async (status, tag) => {
    returnedWithCode('health_roadmap_gdrive_pkce', `?code=c&state=s&scope=${encodeURIComponent(CONFIG.scope)}`);
    answerAll(status);
    expect(await tagsOf(GoogleDriveAdapter.completeRedirect(CONFIG))).toEqual({ errorClass: 'StorageError', httpStatus: tag });
  });

  // The refresh-path errors read `none` on purpose. Their throw sits after an
  // await in the caller, not beside the response, so the status would have to
  // live on the adapter, and two overlapping refreshes would race: one
  // request's error could carry the other's status. Untracked beats wrong.
  it('a transient refresh for the reminder identity reads none', async () => {
    const adapter = connected(0);
    answerAll(503);
    expect((await tagsOf(adapter.getReminderIdToken())).httpStatus).toBe('none');
  });

  it('"needs to be reconnected" after a refused refresh reads none', async () => {
    const adapter = connected(0);
    answerAll(401);
    expect((await tagsOf(adapter.writeDocument('a.pdf', new Blob(['x'])))).httpStatus).toBe('none');
  });

  it('a first-write create, a document read and a document write read their status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"provider prose"}', { status: 429 })));
    expect((await tagsOf(connected().writeDocument('a.pdf', new Blob(['x'])))).httpStatus).toBe('429');

    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('alt=media') ? new Response('', { status: 403 }) : new Response(JSON.stringify({ files: [{ id: 'D' }] }), { status: 200 })));
    expect((await tagsOf(connected().readDocument('a.pdf'))).httpStatus).toBe('403');

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Response('', { status: 500 }) : new Response(JSON.stringify({ files: [] }), { status: 200 })));
    expect((await tagsOf(connected().write('other.json', {}, null))).httpStatus).toBe('5xx');
  });
});

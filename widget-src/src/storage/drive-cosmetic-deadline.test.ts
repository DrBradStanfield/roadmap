/**
 * US-09 AC53 (A1-6, owner's answer 5): the Drive adapter's cosmetic calls,
 * the folder's self-healing rename (AC40) and the one-time move of a pre-folder
 * file into the app folder, get the 30-second call bound. Before, each was a
 * bare `fetch` with no deadline, so a request Drive never answered stayed open
 * for good. Both stay fire-and-forget: a stall never holds a save. Real
 * adapter; synthetic Drive and a fake clock, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_LEGACY_FOLDER_NAME } from '@roadmap/health-core/drive-rest';
import { DRIVE_FILE_SCOPE, GoogleDriveAdapter } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: `openid email ${DRIVE_FILE_SCOPE}`,
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
const CONFIG_KEY = 'health_roadmap_gdrive';
const FOLDER = 'folder-1';
const CALL_MS = 30_000;

let local: Map<string, string>;
/** The signal of each request `stalls` picked, in order. */
let stalled: AbortSignal[];

/** Drive, where requests `stalls` matches never answer until their signal aborts. */
function drive(stalls: (url: string, init: RequestInit) => boolean) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (stalls(url, init)) {
      stalled.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if (url.includes('fields=parents')) return Promise.resolve(new Response(JSON.stringify({ parents: ['root'] })));
    return Promise.resolve(new Response(JSON.stringify({ id: 'doc-1', version: '1' }), { status: 200 }));
  }));
}

beforeEach(() => {
  local = new Map([
    [TOKENS_KEY, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 })],
    [CONFIG_KEY, JSON.stringify({ folderId: FOLDER, folderName: DRIVE_LEGACY_FOLDER_NAME })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  });
  stalled = [];
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Each stalled request is still open 1 ms before 30 s and aborted at it. */
async function abortedAtCallBound(count: number): Promise<void> {
  expect(stalled).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(CALL_MS - 1);
  expect(stalled.map((s) => s.aborted)).toEqual(Array(count).fill(false));
  await vi.advanceTimersByTimeAsync(1);
  expect(stalled.map((s) => s.aborted)).toEqual(Array(count).fill(true));
}

describe('US-09 AC53: the cosmetic Drive calls have the 30-second call bound', () => {
  it('a folder rename Drive never answers is aborted at 30 s, and the save it rode on is not held', async () => {
    drive((url, init) => init.method === 'PATCH' && url.endsWith(`/files/${FOLDER}`));
    const adapter = new GoogleDriveAdapter(CONFIG);
    await adapter.writeDocument('report.pdf', new Blob(['%PDF'])); // resolves with the rename still open
    await vi.advanceTimersByTimeAsync(0);
    await abortedAtCallBound(1);
    expect((JSON.parse(local.get(CONFIG_KEY)!) as { folderName?: string }).folderName).toBe(DRIVE_LEGACY_FOLDER_NAME); // retried next use
  });

  it('the parents lookup and the move of a pre-folder file are each aborted at 30 s', async () => {
    const adapter = new GoogleDriveAdapter(CONFIG);
    const move = adapter as unknown as { ensureInFolderOnce(id: string): Promise<void>; ensureFolderId(): Promise<string>; stored: { folderId?: string } | null; folderCheckDone: boolean };
    move.ensureFolderId = async () => FOLDER;

    drive((url) => url.includes('fields=parents'));
    move.stored = {};
    const lookup = move.ensureInFolderOnce('file-1');
    await vi.advanceTimersByTimeAsync(0);
    await abortedAtCallBound(1);
    await expect(lookup).resolves.toBeUndefined(); // swallowed: cosmetic

    stalled = [];
    drive((url) => url.includes('addParents='));
    move.stored = {};
    move.folderCheckDone = false;
    const moved = move.ensureInFolderOnce('file-1');
    await vi.advanceTimersByTimeAsync(0);
    await abortedAtCallBound(1);
    await expect(moved).resolves.toBeUndefined();
  });
});

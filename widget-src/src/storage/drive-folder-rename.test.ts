/**
 * US-09 AC40: the Drive folder's self-healing rename (a folder made under the
 * old name, "Health Roadmap by Dr Brad") is marked done only when Drive accepted
 * the rename. Before, a PATCH that Drive refused (401, 403, a 5xx) was marked
 * done anyway, so that device never tried again and the folder kept the old
 * name. Now a refused rename is tried again on the next folder use, as a
 * network failure already was. Real adapter; synthetic Drive, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIVE_FOLDER_NAME, DRIVE_LEGACY_FOLDER_NAME } from '@roadmap/health-core/drive-rest';
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

let local: Map<string, string>;
/** The statuses the folder PATCHes get, in turn (the last one repeats). */
let renameAnswers: number[];
let renames: Array<{ url: string; body: unknown }>;

function drive() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === 'PATCH' && url.endsWith(`/files/${FOLDER}`)) {
      renames.push({ url, body: JSON.parse(String(init.body)) });
      const status = renameAnswers.length > 1 ? renameAnswers.shift()! : renameAnswers[0];
      return new Response(status === 200 ? JSON.stringify({ id: FOLDER }) : 'refused', { status });
    }
    // The document upload that needs the folder.
    return new Response(JSON.stringify({ id: 'doc-1', version: '1' }), { status: 200 });
  }));
}

const storedName = () => (JSON.parse(local.get(CONFIG_KEY) ?? '{}') as { folderName?: string }).folderName;

/** One folder use, with the fire-and-forget rename it starts let finish. */
async function useFolder(adapter: GoogleDriveAdapter): Promise<void> {
  await adapter.writeDocument('report.pdf', new Blob(['%PDF']));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  local = new Map([
    [TOKENS_KEY, JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 })],
    // A device that cached the folder while it still had the old name.
    [CONFIG_KEY, JSON.stringify({ folderId: FOLDER, folderName: DRIVE_LEGACY_FOLDER_NAME })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  });
  renames = [];
  drive();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC40: the Drive folder rename is marked done only when Drive accepted it', () => {
  it.each([401, 403, 500, 503])('a rename Drive answers %i is not marked done, and is tried again on the next folder use', async (status) => {
    renameAnswers = [status, 200];
    const adapter = new GoogleDriveAdapter(CONFIG);

    await useFolder(adapter);
    expect(renames).toHaveLength(1);
    expect(renames[0].body).toEqual({ name: DRIVE_FOLDER_NAME });
    expect(storedName()).toBe(DRIVE_LEGACY_FOLDER_NAME);

    await useFolder(adapter);
    expect(renames).toHaveLength(2);
    expect(storedName()).toBe(DRIVE_FOLDER_NAME);
  });

  // Issue #976: a 404 is a folder that is gone, so no later PATCH can land.
  it('a rename Drive answers 404 is marked done and not sent again (#976)', async () => {
    renameAnswers = [404];
    const adapter = new GoogleDriveAdapter(CONFIG);

    await useFolder(adapter);
    await useFolder(adapter);
    expect(renames).toHaveLength(1);
    expect(storedName()).toBe(DRIVE_FOLDER_NAME);
  });

  // #976 review R3: the 404 can come back after the dead cached folder was
  // forgotten and another folder took its place; that folder's rename is not done.
  it.each([404, 200])('a %i that answers after the folder was replaced does not mark the new folder renamed', async (status) => {
    let answer!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      if (init.method === 'PATCH' && String(input).endsWith(`/files/${FOLDER}`)) {
        renames.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return new Promise<Response>((resolve) => { answer = resolve; });
      }
      return new Response('{}', { status: 200 });
    }));
    const adapter = new GoogleDriveAdapter(CONFIG);
    const internals = adapter as unknown as { stored: Record<string, unknown>; ensureFolderName(id: string): Promise<void> };
    const renaming = internals.ensureFolderName(FOLDER);
    await vi.waitFor(() => expect(renames).toHaveLength(1));
    // liveFolderId found the cached folder dead, forgot it, and found another under the old name.
    internals.stored = { folderId: 'folder-2', folderName: DRIVE_LEGACY_FOLDER_NAME };
    answer(new Response(status === 200 ? JSON.stringify({ id: FOLDER }) : 'gone', { status }));
    await renaming;
    expect(internals.stored.folderName).toBe(DRIVE_LEGACY_FOLDER_NAME);
  });

  it('control: an accepted rename is marked done and not sent again', async () => {
    renameAnswers = [200];
    const adapter = new GoogleDriveAdapter(CONFIG);

    await useFolder(adapter);
    expect(storedName()).toBe(DRIVE_FOLDER_NAME);
    await useFolder(adapter);
    await useFolder(new GoogleDriveAdapter(CONFIG)); // the next page load
    expect(renames).toHaveLength(1);
  });
});

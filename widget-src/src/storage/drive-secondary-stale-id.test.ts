/** @vitest-environment jsdom */
/**
 * US-10 AC4b: the browser Drive adapter falls back to a cached file id for secondary
 * files (chat-history.json) without checking that the file is still live. A
 * trashed file keeps receiving writes; once the trash is emptied, every write
 * PATCHes the dead id and fails with a 404, forever.
 *
 * Provider boundary only (same stub style as drive-first-save.test.ts). Drive
 * serves a trashed file by id (files.get / alt=media / PATCH) but leaves it out
 * of a `trashed=false` search.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { DRIVE_FOLDER_NAME } from '@roadmap/health-core';
import { GoogleDriveAdapter } from './drive';

const CHAT = 'chat-history.json';
const FOLDER = 'folder';
interface File { id: string; name: string; content: string; version: number; trashed: boolean }

class Drive {
  files: File[] = [];
  created: string[] = [];
  /** The app folder; a new file made in a trashed folder is trashed too. */
  folders: Array<{ id: string; trashed: boolean }> = [{ id: FOLDER, trashed: false }];
  /** A status for the next metadata lookup of a file, then normal again. */
  failLookup: number | null = null;
  constructor() {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => this.fetch(new URL(String(input)), init));
  }
  private async fetch(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (q.includes('mimeType=')) {
        return Response.json({ files: this.folders.filter((f) => !f.trashed).map(({ id }) => ({ id, name: DRIVE_FOLDER_NAME })) });
      }
      const name = /name='([^']+)'/.exec(q)?.[1];
      const live = q.includes('trashed=false');
      return Response.json({ files: this.files.filter((f) => f.name === name && !(live && f.trashed)).map(({ id }) => ({ id })) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') { // a folder
      const id = `folder-${this.folders.length + 1}`;
      this.folders.push({ id, trashed: false });
      return Response.json({ id });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const id = `new-${this.files.length + 1}`;
      const parent = (await new Response(init?.body as BodyInit).text()).match(/"parents":\["([^"]+)"\]/)?.[1];
      const inTrash = this.folders.find((f) => f.id === parent)?.trashed ?? false;
      this.files.push({ id, name: CHAT, content: '{}', version: 1, trashed: inTrash });
      this.created.push(id);
      return Response.json({ id, version: '1' });
    }
    const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    const folder = this.folders.find((f) => f.id === id);
    if (folder && method === 'GET') return Response.json({ id, name: DRIVE_FOLDER_NAME, trashed: folder.trashed });
    if (folder && method === 'PATCH') return Response.json({ id });
    if (method === 'GET' && url.searchParams.get('fields')?.includes('trashed') && this.failLookup) {
      const status = this.failLookup;
      this.failLookup = null;
      return new Response('unavailable', { status });
    }
    const file = this.files.find((f) => f.id === id);
    if (!file) return new Response('not found', { status: 404 });
    if (method === 'GET') {
      return url.searchParams.get('alt') === 'media'
        ? new Response(file.content)
        : Response.json({ id: file.id, name: file.name, version: String(file.version), trashed: file.trashed, parents: [FOLDER] });
    }
    if (method === 'PATCH') {
      if (url.pathname.startsWith('/upload/')) { file.content = String(init!.body); ++file.version; }
      return Response.json({ id: file.id, version: String(file.version) });
    }
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  }
}

function browserAdapter(fileIds: Record<string, string>, extra: object = {}): GoogleDriveAdapter {
  localStorage.setItem('health_roadmap_gdrive', JSON.stringify({ folderId: FOLDER, folderName: DRIVE_FOLDER_NAME, fileIds, ...extra }));
  localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
  return new GoogleDriveAdapter({ clientId: 'synthetic', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/exchange' });
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('US-10 AC4b: a cached chat-history id that is no longer live', () => {
  it('a permanently deleted cached file is recreated, not PATCHed forever', async () => {
    const drive = new Drive(); // X was deleted (trash emptied): nothing on Drive
    const a = browserAdapter({ [CHAT]: 'X' });
    const read = await a.read(CHAT);
    expect(read).toEqual({ body: null, version: null });
    // Today: PATCH /upload/drive/v3/files/X -> 404 -> StorageError, every save.
    await expect(a.write(CHAT, { conversations: [] }, read.version)).resolves.toBeDefined();
    expect(drive.created).toHaveLength(1);
  });

  it('a write to a trashed cached file creates a live file instead of writing into the trash', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: JSON.stringify({ conversations: [] }), version: 3, trashed: true });
    const a = browserAdapter({ [CHAT]: 'X' });
    await a.write(CHAT, { conversations: [{ id: 'c1' }] }, null);
    expect(drive.created).toHaveLength(1);
    expect(drive.files.find((f) => f.id === 'X')!.content).toBe(JSON.stringify({ conversations: [] }));
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive')!).fileIds[CHAT]).toBe(drive.created[0]);
  });

  it('control: a read that finds another device\'s live copy writes there, not to the trashed cached file', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 3, trashed: true });
    drive.files.push({ id: 'Y', name: CHAT, content: '{"conversations":[{"id":"other"}]}', version: 2, trashed: false });
    const a = browserAdapter({ [CHAT]: 'X' });
    const read = await a.read(CHAT);
    expect(read.body).toEqual({ conversations: [{ id: 'other' }] });
    await a.write(CHAT, { conversations: [{ id: 'other' }, { id: 'mine' }] }, read.version);
    expect(drive.files.find((f) => f.id === 'Y')!.content).toContain('mine');
    expect(drive.files.find((f) => f.id === 'X')!.content).not.toContain('mine');
    expect(drive.created).toHaveLength(0);
  });

  it('control: a live cached file the search has not caught up with is still used', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 3, trashed: false });
    const lag = drive.files.splice(0); // the search does not see it yet ...
    const a = browserAdapter({ [CHAT]: 'X' });
    const fetchById = (drive as unknown as { files: File[] });
    // ... but a lookup by id does.
    vi.stubGlobal('fetch', ((orig) => (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/drive/v3/files') return orig(input, init);
      fetchById.files = lag;
      const res = orig(input, init);
      fetchById.files = [];
      return res;
    })(globalThis.fetch));
    const read = await a.read(CHAT);
    expect(read.body).toEqual({ conversations: [] });
    await a.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version);
    expect(lag[0].content).toContain('c1');
    expect(drive.created).toHaveLength(0);
  });

  it('a passing lookup error never forgets the cached id or makes a second file', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 3, trashed: false });
    const a = browserAdapter({ [CHAT]: 'X' });
    drive.failLookup = 503;
    await expect(a.write(CHAT, { conversations: [{ id: 'c1' }] }, null)).rejects.toMatchObject({ status: 503 });
    expect(drive.created).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive')!).fileIds[CHAT]).toBe('X');
  });

  it('a cached file renamed away from chat-history.json is not written into', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: 'old chats.json', content: '{"conversations":[]}', version: 3, trashed: false });
    const a = browserAdapter({ [CHAT]: 'X' });
    await a.write(CHAT, { conversations: [{ id: 'c1' }] }, null);
    expect(drive.files.find((f) => f.id === 'X')!.content).not.toContain('c1');
    expect(drive.created).toHaveLength(1);
  });

  it('with the app folder trashed, saves make one live file in a new folder, not one trashed file each', async () => {
    const drive = new Drive();
    drive.folders[0].trashed = true;
    const a = browserAdapter({}, { subfolders: { 'Lab results': 'sub-in-trash' } });
    for (const n of [1, 2, 3]) {
      const read = await a.read(CHAT);
      await a.write(CHAT, { conversations: [{ id: `c${n}` }] }, read.version);
    }
    expect(drive.created).toHaveLength(1);
    expect(drive.files.filter((f) => !f.trashed)).toHaveLength(1);
    expect(drive.files[0].content).toContain('c3');
    // The trashed folder's subfolders go with it, so documents do not upload into the trash.
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive')!).subfolders).toBeUndefined();
  });

  it('a trashed cached file reads as absent, like the record path (drive-rest.ts readDriveRecord)', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: JSON.stringify({ conversations: [] }), version: 3, trashed: true });
    const a = browserAdapter({ [CHAT]: 'X' });
    // Today: returns the trashed file's bytes and version, and the next write lands in the trash.
    expect(await a.read(CHAT)).toEqual({ body: null, version: null });
    // And the dead id is forgotten, so a later page load does not check it again.
    expect(JSON.parse(localStorage.getItem('health_roadmap_gdrive')!).fileIds[CHAT]).toBeUndefined();
  });
});

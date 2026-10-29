/**
 * US-10 AC4b, the browser rule's variant in the shared adapter the iPhone app and the hosted
 * server use: DriveAdapter caches a secondary file's id for the instance's
 * life and reuses it on every read and write without checking it is live.
 * The iPhone app keeps one instance per access token (up to an hour), so a
 * chat-history.json trashed meanwhile keeps receiving writes. Synthetic
 * provider stub (same shape as the widget's), no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveAdapter, DRIVE_FOLDER_NAME } from './drive-rest';

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

afterEach(() => { vi.unstubAllGlobals(); });

describe('US-10 AC4b: the shared DriveAdapter and a cached id that is no longer live', () => {
  it('a file trashed after this instance cached its id is not written into', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 1, trashed: false });
    const adapter = new DriveAdapter('synthetic');
    expect((await adapter.read(CHAT)).body).toEqual({ conversations: [] }); // caches X
    drive.files[0].trashed = true; // the user trashes it on drive.google.com

    const read = await adapter.read(CHAT);
    expect(read).toEqual({ body: null, version: null });
    await adapter.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version);
    expect(drive.files.find((f) => f.id === 'X')!.content).not.toContain('c1');
    expect(drive.created).toHaveLength(1);
  });

  it('a file deleted for good after it was cached is created again on the next save', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 1, trashed: false });
    const adapter = new DriveAdapter('synthetic');
    await adapter.read(CHAT);
    drive.files.splice(0);

    const read = await adapter.read(CHAT);
    await expect(adapter.write(CHAT, { conversations: [] }, read.version)).resolves.toBeDefined();
    expect(drive.created).toHaveLength(1);
  });

  it('a passing lookup error never forgets the cached id or makes a second file', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 1, trashed: false });
    const adapter = new DriveAdapter('synthetic');
    const read = await adapter.read(CHAT);
    drive.failLookup = 500;
    await expect(adapter.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version)).rejects.toMatchObject({ status: 500 });
    await adapter.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version); // healthy again: X, in place
    expect(drive.files[0].content).toContain('c1');
    expect(drive.created).toHaveLength(0);
  });

  it('a cached file renamed away from chat-history.json is not written into', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 1, trashed: false });
    const adapter = new DriveAdapter('synthetic');
    await adapter.read(CHAT);
    drive.files[0].name = 'old chats.json';

    const read = await adapter.read(CHAT);
    expect(read).toEqual({ body: null, version: null });
    await adapter.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version);
    expect(drive.files[0].content).not.toContain('c1');
    expect(drive.created).toHaveLength(1);
  });

  it('control: a live cached file is read and written in place', async () => {
    const drive = new Drive();
    drive.files.push({ id: 'X', name: CHAT, content: '{"conversations":[]}', version: 1, trashed: false });
    const adapter = new DriveAdapter('synthetic');
    const read = await adapter.read(CHAT);
    await adapter.write(CHAT, { conversations: [{ id: 'c1' }] }, read.version);
    expect(drive.files[0].content).toContain('c1');
    expect(drive.created).toHaveLength(0);
  });
});

/**
 * US-32 phase 2 · Google Drive without a conditional write.
 *
 * Drive v3 removed `etag`, so design §7 replaces the precondition with four
 * steps, and each one is tested here on its own before the whole loop is:
 *
 *   1. read with `fields=version`
 *   2. re-fetch the version immediately before the upload; abort if it moved
 *   3. after writing, re-read and assert every row id survived
 *   4. bounded retry
 *
 * The fake Drive below is deliberately hostile: it can be told to write a
 * competing file at the exact instant between step 2's check and the upload,
 * which is the window step 2 CANNOT close and step 3 exists to catch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, LostUpdateError, ROADMAP_FILE_NAME, StorageError } from './adapter';
import { DriveAdapter, DRIVE_FOLDER_NAME, DRIVE_LEGACY_FOLDER_NAME } from './drive-rest';
import { ROADMAP_DOC } from './roadmap-doc';
import { SyncManager } from './sync-manager';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  version: number;
  content: string;
  parents: string[];
}

/**
 * Drive v3, in memory: name search, multipart create, media PATCH, and a
 * `version` that bumps on every content change — the only four behaviours the
 * adapter depends on.
 */
class FakeDrive {
  files = new Map<string, DriveFile>();
  private nextId = 1;
  /** Fires after a `fields=version` read has captured its answer — a writer
   *  landing BEFORE our upload, which step 2 is meant to catch. */
  onVersionRead: (() => void) | null = null;
  /** Fires after our upload has landed — a writer landing AFTER it, which step
   *  2 cannot see at all and only step 3's row-id verify catches. */
  onUpload: (() => void) | null = null;
  /** Fires while the body is being downloaded — the window between the two
   *  calls step 1 makes. */
  onDownload: (() => void) | null = null;
  requests: string[] = [];

  create(name: string, content: string, mimeType = 'application/json', parents: string[] = []): DriveFile {
    const file: DriveFile = { id: `id-${this.nextId++}`, name, mimeType, version: 1, content, parents };
    this.files.set(file.id, file);
    return file;
  }

  /** Someone else's write, landing whenever the test says so. */
  clobber(fileId: string, content: string): void {
    const file = this.files.get(fileId)!;
    file.content = content;
    file.version += 1;
  }

  find(name: string, mimeType?: string, parent?: string): DriveFile | undefined {
    for (const file of this.files.values()) {
      if (file.name !== name) continue;
      if (mimeType && file.mimeType !== mimeType) continue;
      if (parent && !file.parents.includes(parent)) continue;
      return file;
    }
    return undefined;
  }

  install(): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => this.handle(new URL(String(input)), init));
  }

  private async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    const q = decodeURIComponent(url.searchParams.get('q') ?? '');
    const fileMatch = /\/files\/([^/?]+)$/.exec(url.pathname);

    // Search: `name='x' [or name='y'] and mimeType='…' and '<parent>' in parents`
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const names = [...q.matchAll(/name='([^']*)'/g)].map((m) => m[1]);
      const mimeType = /mimeType='([^']*)'/.exec(q)?.[1];
      const parent = /'([^']*)' in parents/.exec(q)?.[1];
      const hit = names.map((name) => this.find(name, mimeType, parent)).find(Boolean);
      return Response.json({ files: hit ? [{ id: hit.id, name: hit.name }] : [] });
    }

    // Create a folder (metadata only).
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { name: string; mimeType: string; parents?: string[] };
      const made = this.create(body.name, '', body.mimeType, body.parents ?? []);
      return Response.json({ id: made.id });
    }

    if (fileMatch && method === 'GET') {
      const file = this.files.get(fileMatch[1]);
      if (!file) return new Response('not found', { status: 404 });
      if (url.searchParams.get('alt') === 'media') {
        const answer = new Response(file.content);
        this.onDownload?.();
        return answer;
      }
      const version = String(file.version);
      this.onVersionRead?.();
      return Response.json({ version });
    }

    // Multipart create: metadata part, then the content part.
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const text = await new Response(init!.body as BodyInit).text();
      const parts = text.split(/--rm_boundary_health_roadmap-*\r?\n?/).filter((p) => p.trim());
      const metadata = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()) as { name: string; parents: string[] };
      const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      const made = this.create(metadata.name, content, 'application/json', metadata.parents);
      return Response.json({ id: made.id, version: String(made.version) });
    }

    if (/\/upload\/drive\/v3\/files\/[^/?]+$/.test(url.pathname) && method === 'PATCH') {
      const file = this.files.get(/files\/([^/?]+)$/.exec(url.pathname)![1])!;
      file.content = String(init!.body);
      file.version += 1;
      const answer = Response.json({ id: file.id, version: String(file.version) });
      this.onUpload?.();
      return answer;
    }

    return new Response('unhandled', { status: 500 });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function record(build: (file: RoadmapFile) => void = () => {}): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'seed', now: '2026-01-01T00:00:00.000Z' });
  build(file);
  return file;
}

function measurement(id: string, day: string) {
  return createMeasurement({
    id,
    metricType: 'weight',
    value: 80,
    recordedAt: `${day}T00:00:00.000Z`,
    createdAt: `${day}T00:00:00.000Z`,
  });
}

function sync(deviceId: string): SyncManager<RoadmapFile> {
  return new SyncManager(new DriveAdapter('access-token'), deviceId, ROADMAP_DOC, () => '2026-02-01T00:00:00.000Z');
}

function seed(drive: FakeDrive): DriveFile {
  const folder = drive.create(DRIVE_FOLDER_NAME, '', FOLDER_MIME);
  return drive.create(ROADMAP_FILE_NAME, JSON.stringify(record()), 'application/json', [folder.id]);
}

// ---------------------------------------------------------------------------
// Step 1 — read carries the version
// ---------------------------------------------------------------------------

describe('step 1: read with fields=version (US-32 phase 2)', () => {
  it('returns the body and the file version', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);

    const read = await new DriveAdapter('access-token').read(ROADMAP_FILE_NAME);
    expect((read.body as RoadmapFile).schemaVersion).toBe(1);
    expect(read.version).toBe(String(file.version));
    expect(drive.requests.some((r) => r.includes('fields=version'))).toBe(true);
  });

  it('reads the version BEFORE the bytes, so a writer mid-download conflicts', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);

    // They save while our download is in flight. If the version were read
    // afterwards we would come away with THEIR version number attached to OUR
    // bytes, the pre-upload check would find nothing moved, and their row would
    // vanish with no error and no retry.
    let struck = false;
    drive.onDownload = () => {
      if (struck) return;
      struck = true;
      const theirs = record((f) => {
        f.measurements.push(measurement('theirs', '2026-01-09'));
        f.meta.lamport = 99;
      });
      drive.clobber(file.id, JSON.stringify(theirs));
    };

    const saved = await sync('mcp').save(record((f) => f.measurements.push(measurement('ours', '2026-01-10'))));
    expect(saved.attempts).toBeGreaterThan(0);
    const ids = (JSON.parse(drive.files.get(file.id)!.content) as RoadmapFile).measurements.map((m) => m.id).sort();
    expect(ids).toEqual(['ours', 'theirs']);
  });

  it('an absent file is an empty read, not a failure', async () => {
    const drive = new FakeDrive();
    drive.install();
    expect(await new DriveAdapter('access-token').read(ROADMAP_FILE_NAME)).toEqual({ body: null, version: null });
  });

  it('finds the file the browser adapter made, under either folder name', async () => {
    const drive = new FakeDrive();
    drive.install();
    const legacy = drive.create(DRIVE_LEGACY_FOLDER_NAME, '', FOLDER_MIME);
    drive.create(ROADMAP_FILE_NAME, JSON.stringify(record()), 'application/json', [legacy.id]);

    const read = await new DriveAdapter('access-token').read(ROADMAP_FILE_NAME);
    expect(read.body).not.toBeNull();
  });

  it('creates the record inside the app folder the browser adapter uses', async () => {
    const drive = new FakeDrive();
    drive.install();
    await sync('mcp').save(record((f) => f.measurements.push(measurement('m1', '2026-01-02'))));

    const folder = drive.find(DRIVE_FOLDER_NAME, FOLDER_MIME)!;
    const written = drive.find(ROADMAP_FILE_NAME)!;
    expect(written.parents).toEqual([folder.id]);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — the version is re-checked immediately before the upload
// ---------------------------------------------------------------------------

describe('step 2: a version that moved raises ConflictError (US-32 phase 2)', () => {
  it('refuses the upload and writes nothing', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);
    const adapter = new DriveAdapter('access-token');
    const { version } = await adapter.read(ROADMAP_FILE_NAME);

    drive.clobber(file.id, JSON.stringify(record()));
    const before = file.content;

    await expect(adapter.write(ROADMAP_FILE_NAME, record(), version)).rejects.toBeInstanceOf(ConflictError);
    expect(file.content).toBe(before);
  });

  it('the SyncManager re-merges on that conflict, and both writers survive', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);

    // Our writer reads, then a second device writes its own row underneath us.
    const ours = record((f) => f.measurements.push(measurement('ours', '2026-01-03')));
    let interfered = false;
    drive.onVersionRead = () => {
      if (interfered) return;
      interfered = true;
      const theirs = record((f) => f.measurements.push(measurement('theirs', '2026-01-04')));
      drive.clobber(file.id, JSON.stringify(theirs));
    };

    const saved = await sync('mcp').save(ours);
    expect(saved.attempts).toBe(1); // one conflict, one retry
    const ids = (JSON.parse(drive.files.get(file.id)!.content) as RoadmapFile).measurements.map((m) => m.id).sort();
    expect(ids).toEqual(['ours', 'theirs']);
  });

  it('a file that vanished after the read conflicts rather than being re-created', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);
    const adapter = new DriveAdapter('access-token');
    const { version } = await adapter.read(ROADMAP_FILE_NAME);
    drive.files.delete(file.id);

    // A stale writer silently re-creating a record the user deleted is exactly
    // the resurrection hazard Dropbox's `strict_conflict` closes (design §7).
    await expect(adapter.write(ROADMAP_FILE_NAME, record(), version)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the post-write row-id verify catches what step 2 cannot
// ---------------------------------------------------------------------------

describe('step 3: a writer that lands AFTER our upload (US-32 phase 2)', () => {
  it('is invisible to the version check, caught by the row-id verify, and retried', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);

    // Their upload lands after ours, so our rows are gone from the file we
    // just wrote. The version check cannot see this — it had already passed —
    // and lamport cannot either, because their write advances it. The row-id
    // verify is the only thing left, and it must REPORT the loss rather than
    // confirm the write. Once only, so the retry proves recovery too.
    let struck = false;
    drive.onUpload = () => {
      if (struck) return;
      struck = true;
      // Their own merged file: a real competing writer's lamport is ahead of
      // ours, so lamport alone cannot see the loss — only the row ids can.
      const theirs = record((f) => {
        f.measurements.push(measurement('theirs', '2026-01-05'));
        f.meta.lamport = 99;
      });
      drive.clobber(file.id, JSON.stringify(theirs));
    };

    const saved = await sync('mcp').save(record((f) => f.measurements.push(measurement('ours', '2026-01-06'))));
    expect(saved.attempts).toBe(1);
    const ids = (JSON.parse(drive.files.get(file.id)!.content) as RoadmapFile).measurements.map((m) => m.id).sort();
    expect(ids).toEqual(['ours', 'theirs']);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — bounded retry, and the error it gives up with
// ---------------------------------------------------------------------------

describe('step 4: bounded retry (US-32 phase 2)', () => {
  it('gives up with the conflict-storm error, and does not claim nothing was written', async () => {
    const drive = new FakeDrive();
    drive.install();
    const file = seed(drive);

    // A writer that never stops: every upload of ours is overwritten.
    let round = 0;
    drive.onUpload = () => {
      const theirs = record((f) => {
        f.measurements.push(measurement(`theirs-${round++}`, '2026-01-07'));
        f.meta.lamport = 99 + round;
      });
      drive.clobber(file.id, JSON.stringify(theirs));
    };

    const failure = await sync('mcp')
      .save(record((f) => f.measurements.push(measurement('ours', '2026-01-08'))))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).message).toContain('conflict storm');
    expect((failure as StorageError).cause).toBeInstanceOf(LostUpdateError);
    expect((failure as StorageError).hint).toContain('may have landed');
    expect(round).toBe(5); // MAX_SAVE_ATTEMPTS, then it stops
  });
});

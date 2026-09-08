/**
 * @vitest-environment jsdom
 *
 * US-10 AC4 — the browser's Google Drive adapter carries a version and refuses
 * a stale write, the way the hosted `DriveAdapter` already does (§7).
 *
 * Drive v3 has no conditional write, so the adapter reads `version` BEFORE the
 * bytes, re-reads it immediately before the upload, and throws `ConflictError`
 * if it moved. `SyncManager` then re-reads, re-merges and retries, and both
 * writers' rows survive. Without this the browser was the one writer that
 * could overwrite another's row and never notice (verified 2026-09-09).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  createEmptyFile,
  createMeasurement,
  ROADMAP_DOC,
  ROADMAP_FILE_NAME,
  SyncManager,
  type RoadmapFile,
} from '@roadmap/health-core';
import { GoogleDriveAdapter } from './drive';

const FILE_ID = 'file-1';
const T0 = '2026-09-01T00:00:00.000Z';

/** One Drive file, in memory: version GET, media GET, media PATCH, name search. */
class FakeDrive {
  content: string | null = null;
  version = 0;
  requests: string[] = [];
  /** Fires after a body download has been answered. */
  onDownload: (() => void) | null = null;
  /** When set, the NEXT `fields=version` read waits on it before answering. */
  parkNextVersionRead: Promise<void> | null = null;

  seed(file: RoadmapFile): void {
    this.content = JSON.stringify(file);
    this.version = 1;
  }

  /** Someone else's write. */
  clobber(file: RoadmapFile): void {
    this.content = JSON.stringify(file);
    this.version += 1;
  }

  rows(): string[] {
    return (JSON.parse(this.content!) as RoadmapFile).measurements.map((m) => m.id).sort();
  }

  install(): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => this.handle(new URL(String(input)), init));
  }

  private async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      return Response.json({ files: this.content == null ? [] : [{ id: FILE_ID, name: ROADMAP_FILE_NAME }] });
    }
    if (url.pathname === `/drive/v3/files/${FILE_ID}` && method === 'GET') {
      if (this.content == null) return new Response('gone', { status: 404 });
      if (url.searchParams.get('alt') === 'media') {
        const answer = new Response(this.content);
        this.onDownload?.();
        return answer;
      }
      if (this.parkNextVersionRead) {
        const gate = this.parkNextVersionRead;
        this.parkNextVersionRead = null;
        await gate;
      }
      return Response.json({ version: String(this.version) });
    }
    if (url.pathname === `/upload/drive/v3/files/${FILE_ID}` && method === 'PATCH') {
      this.content = String(init!.body);
      this.version += 1;
      return Response.json({ id: FILE_ID, version: String(this.version) });
    }
    return new Response(`unhandled ${method} ${url.pathname}`, { status: 500 });
  }
}

function adapter(cachedFileId = true): GoogleDriveAdapter {
  localStorage.setItem(
    'health_roadmap_gdrive',
    JSON.stringify({ fileIds: cachedFileId ? { [ROADMAP_FILE_NAME]: FILE_ID } : {}, folderId: 'folder-1' }),
  );
  localStorage.setItem(
    'health_roadmap_gdrive_tokens',
    JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 3_600_000 }),
  );
  return new GoogleDriveAdapter({
    clientId: 'c',
    scope: 's',
    redirectUri: 'https://example.test/',
    exchangeUrl: 'https://example.test/exchange',
  });
}

const record = () => createEmptyFile({ deviceId: 'seed', now: T0 });
const measurement = (id: string, metricType: string) =>
  createMeasurement({ id, metricType, value: 80, recordedAt: T0, createdAt: T0 });
const sync = (device: string) => new SyncManager<RoadmapFile>(adapter(), device, ROADMAP_DOC, () => T0);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

let drive: FakeDrive;

beforeEach(() => {
  drive = new FakeDrive();
  drive.install();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('US-10 AC4 — browser GoogleDriveAdapter carries a version', () => {
  it('read() returns the Drive version, fetched BEFORE the download', async () => {
    drive.seed(record());
    const read = await adapter().read(ROADMAP_FILE_NAME);
    expect(read.version).toBe('1');
    expect((read.body as RoadmapFile).schemaVersion).toBe(1);
    const versionAt = drive.requests.findIndex((r) => r.includes('fields=version'));
    const mediaAt = drive.requests.findIndex((r) => r.includes('alt=media'));
    expect(versionAt).toBeGreaterThanOrEqual(0);
    expect(versionAt).toBeLessThan(mediaAt);
  });

  it('write() with a version that moved throws ConflictError and does not PATCH', async () => {
    drive.seed(record());
    const a = adapter();
    const { version } = await a.read(ROADMAP_FILE_NAME);
    drive.clobber(record());
    const before = drive.content;

    await expect(a.write(ROADMAP_FILE_NAME, record(), version)).rejects.toBeInstanceOf(ConflictError);
    expect(drive.content).toBe(before);
    expect(drive.requests.some((r) => r.startsWith('PATCH'))).toBe(false);
  });

  it('write() with the current version PATCHes and returns the new version', async () => {
    drive.seed(record());
    const a = adapter();
    const { version } = await a.read(ROADMAP_FILE_NAME);
    const written = await a.write(ROADMAP_FILE_NAME, record(), version);
    expect(written.version).toBe('2');
    expect(drive.requests.filter((r) => r.startsWith('PATCH'))).toHaveLength(1);
  });

  it('write() for a file that vanished after the read conflicts rather than re-creating it', async () => {
    drive.seed(record());
    const a = adapter(false);
    const { version } = await a.read(ROADMAP_FILE_NAME);
    drive.content = null;

    await expect(adapter(false).write(ROADMAP_FILE_NAME, record(), version)).rejects.toBeInstanceOf(ConflictError);
    expect(drive.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('two overlapping saves: the stale one is refused, retried, and both rows survive', async () => {
    drive.seed(record());
    const A = sync('A');
    const B = sync('B');
    const fileA = await A.load();
    const fileB = await B.load();
    fileA.measurements.push(measurement('row-A', 'weight'));
    fileB.measurements.push(measurement('row-B', 'waist'));

    // B reads version 1, then parks on its pre-upload version check. A saves
    // in full meanwhile. When B resumes, the check sees version 2 and refuses.
    const gate = deferred();
    drive.onDownload = () => {
      drive.onDownload = null;
      drive.parkNextVersionRead = gate.promise;
    };
    const saveB = B.save(fileB);
    await new Promise((r) => setTimeout(r, 0));
    const savedA = await A.save(fileA);
    expect(savedA.attempts).toBe(0);
    expect(drive.rows()).toEqual(['row-A']);

    gate.resolve();
    const savedB = await saveB;
    expect(savedB.attempts).toBe(1);
    expect(drive.rows()).toEqual(['row-A', 'row-B']);
  });
});

/**
 * US-10 AC6a and US-11 AC7: a save is acknowledged only when the re-read file
 * holds what it wrote, including writes that add no row (an erase, a profile
 * or screening edit). Drive has no conditional write, so a second writer can
 * land between our version check and our verify (US-10 AC4a, US-32 AC19). The row
 * check catches that only when we added rows.
 *
 * The real Drive adapter, SyncManager and RecordSession run; only Google's
 * HTTP boundary is scripted. No clock or record byte is invented after a merge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';
import type { RoadmapFile } from './roadmap-file';
import { DriveAdapter } from './drive-rest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { ROADMAP_DOC } from './roadmap-doc';
import { SyncManager, verifyPersistedFile } from './sync-manager';
import { setScreening, stampProfile } from './state-edits';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { buildErasedFile } from './erase';

const NOW = '2026-10-21T12:00:00.000Z';
const CTX = { deviceId: 'synthetic-seed', now: NOW };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function seeded(): RoadmapFile {
  const f = stampProfile(createEmptyFile(CTX), { heightCm: 170, birthYear: 1980 }, NOW);
  f.measurements.push(createMeasurement({ id: 'listed-weight', metricType: 'weight', value: 80, recordedAt: '2026-10-01', createdAt: NOW }));
  return f;
}

/**
 * B reaches its real PATCH after its version checks, then waits. A's whole
 * write lands, then B's already-prepared PATCH lands, and only then do both
 * writes return to their verify step. Any request the script does not expect
 * fails the test.
 */
class ControlledDrive {
  body: RoadmapFile;
  version = 1;
  trace: string[] = [];
  unexpected: string[] = [];
  uploads: Record<string, RoadmapFile> = {};
  /** A writer that lands its stale copy after every one of A's PATCHes. */
  clobberWith: RoadmapFile | null = null;
  /** The copy lands one lamport past A's upload, so only the field check sees it. */
  clobberAhead = false;
  aPatches = 0;
  readonly bReady = deferred();
  private releaseB = deferred();
  private bCommitted = deferred();
  private holdB = true;
  constructor(initial: RoadmapFile, private race: boolean) { this.body = clone(initial); }
  install() {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const who = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').endsWith('synthetic-b') ? 'b' : 'a';
      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        this.trace.push(who + ':discover');
        return Response.json({ files: [{ id: 'record-1', name: ROADMAP_FILE_NAME, createdTime: '2026-01-01T00:00:00Z' }] });
      }
      if (url.pathname === '/drive/v3/files/record-1' && method === 'GET') {
        this.trace.push(who + (url.searchParams.get('alt') === 'media' ? ':read-body' : ':read-version'));
        if (url.searchParams.get('alt') === 'media') return Response.json(this.body);
        return Response.json({ id: 'record-1', version: String(this.version), name: ROADMAP_FILE_NAME, mimeType: 'application/json', parents: ['folder-1'], trashed: false });
      }
      if (url.pathname === '/upload/drive/v3/files/record-1' && method === 'PATCH') {
        const prepared = JSON.parse(String(init?.body)) as RoadmapFile;
        this.uploads[who] ??= clone(prepared);
        if (this.race && who === 'b' && this.holdB) {
          this.holdB = false;
          this.trace.push('b:patch-ready-after-version-check');
          this.bReady.resolve();
          await this.releaseB.promise;
        }
        this.body = clone(prepared);
        this.version += 1;
        const answer = Response.json({ id: 'record-1', version: String(this.version) });
        this.trace.push(who + ':patch-committed');
        if (who === 'a') this.aPatches += 1;
        if (who === 'a' && this.clobberWith) {
          this.body = clone(this.clobberWith);
          if (this.clobberAhead) this.body.meta.lamport = prepared.meta.lamport + 1;
          this.version += 1;
        }
        if (this.race && who === 'b') this.bCommitted.resolve();
        if (this.race && who === 'a' && !this.aReleased) {
          this.aReleased = true;
          this.releaseB.resolve();
          await this.bCommitted.promise;
        }
        return answer;
      }
      this.unexpected.push(method + ' ' + url.pathname + url.search);
      throw new Error('Unexpected synthetic Drive request: ' + method + ' ' + url.pathname);
    });
  }
  private aReleased = false;
}
const manager = (who: 'a' | 'b') => new SyncManager(new DriveAdapter('synthetic-' + who), who, ROADMAP_DOC, { now: () => NOW });
function cloudHost(): RecordHost {
  const mirrorCloud = new MemoryCloud();
  let pending = false;
  return {
    tier: 'cloud', store: new DriveAdapter('synthetic-a'),
    clearOffFileData: () => {}, deviceId: () => 'a', clock: { now: () => Date.parse(NOW) },
    timers: { set: (run: () => void) => run, clear: () => {} },
    remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
    mirror: {
      adapter: new MemoryAdapter(mirrorCloud),
      pending: { get: () => pending, set: () => { pending = true; }, clear: () => { pending = false; } },
      writesStopped: () => false, opened: () => {}, wipe: async () => { mirrorCloud.files.clear(); },
    },
  };
}
/** The race really happened: both uploads tie on lamport, B was held past its check, A landed first. */
function racePreconditions(drive: ControlledDrive) {
  expect(drive.unexpected).toEqual([]);
  expect(drive.uploads.a).toBeDefined();
  expect(drive.uploads.b).toBeDefined();
  expect(drive.uploads.a.meta.lamport).toBe(drive.uploads.b.meta.lamport);
  expect(drive.trace.indexOf('b:patch-ready-after-version-check')).toBeLessThan(drive.trace.indexOf('a:patch-committed'));
  expect(drive.trace.indexOf('a:patch-committed')).toBeLessThan(drive.trace.indexOf('b:patch-committed'));
}
afterEach(() => vi.unstubAllGlobals());

describe('a write replaced before its verify is not acknowledged (US-10 AC6a, US-11 AC7)', () => {
  it('control: an uncontended profile save is stored', async () => {
    const base = seeded(); const drive = new ControlledDrive(base, false); drive.install();
    const saved = await manager('a').save(stampProfile(base, { heightCm: 180 }, NOW));
    expect(saved.file.profile.heightCm).toBe(180);
    expect(drive.body.profile.heightCm).toBe(180);
    expect(saved.attempts).toBe(0);
  });

  it('two disjoint profile edits that both report saved are both stored', async () => {
    const base = seeded(); const drive = new ControlledDrive(base, true); drive.install();
    const b = manager('b').save(stampProfile(clone(base), { birthYear: 1981 }, NOW));
    await drive.bReady.promise;
    const a = manager('a').save(stampProfile(clone(base), { heightCm: 180 }, NOW));
    const [aSaved, bSaved] = await Promise.all([a, b]);
    racePreconditions(drive);
    // A's verify finds its edit replaced, re-merges B's in, and lands both.
    expect(aSaved.attempts).toBeGreaterThan(0);
    expect(bSaved.attempts).toBe(0);
    expect(drive.body.profile.heightCm).toBe(180);
    expect(drive.body.profile.birthYear).toBe(1981);
  });

  it('control: a writer that keeps replacing the save ends in "may have landed" after five attempts', async () => {
    // The stale copy's older lamport already fails the baseline check; this
    // bounds the retries the new check adds to the same loop.
    const base = seeded(); const drive = new ControlledDrive(base, false); drive.install();
    drive.clobberWith = clone(base);
    const outcome = await manager('a').save(stampProfile(clone(base), { heightCm: 180 }, NOW)).then(() => null, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(StorageError);
    expect((outcome as StorageError).hint).toMatch(/landed/i);
    expect(drive.aPatches).toBe(5);
    expect(drive.body.profile.heightCm).toBe(170);
  });

  it('a writer that keeps replacing the edit at a newer lamport ends in "may have landed" after five attempts', async () => {
    // Its lamport passes the old check, so only the field check refuses, and
    // the retries it adds stay bounded.
    const base = seeded(); const drive = new ControlledDrive(base, false); drive.install();
    drive.clobberWith = clone(base);
    drive.clobberAhead = true;
    const outcome = await manager('a').save(stampProfile(clone(base), { heightCm: 180 }, NOW)).then(() => null, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(StorageError);
    expect((outcome as StorageError).hint).toMatch(/landed/i);
    expect(drive.aPatches).toBe(5);
    expect(drive.body.meta.lamport).toBeGreaterThan(drive.uploads.a.meta.lamport);
  });

  it('control: a row lost the same way is still recovered by the existing retry', async () => {
    const base = seeded(); const drive = new ControlledDrive(base, true); drive.install();
    const b = manager('b').save(stampProfile(clone(base), { birthYear: 1981 }, NOW));
    await drive.bReady.promise;
    const edited = clone(base);
    edited.measurements.push(createMeasurement({ id: 'new-weight', metricType: 'weight', value: 81, recordedAt: '2026-10-02', createdAt: NOW }));
    const [aSaved] = await Promise.all([manager('a').save(edited), b]);
    expect(aSaved.attempts).toBeGreaterThan(0);
    expect(drive.body.measurements.map(x => x.id)).toContain('new-weight');
    expect(drive.body.profile.birthYear).toBe(1981);
  });

  it('control: an uncontended erase reports success with its marker stored and the row gone', async () => {
    const base = seeded(); const drive = new ControlledDrive(base, false); drive.install();
    const session = await RecordSession.open(cloudHost());
    const result = await session.deleteAllData();
    expect(result.success).toBe(true);
    expect(drive.body.meta.eraseEpoch).toBeGreaterThan(base.meta.eraseEpoch ?? 0);
    expect(drive.body.measurements).toEqual([]);
    expect(drive.body.erasedRows?.ids).toContain('listed-weight');
  });

  it('"Delete all my data" does not report success while a row it erased is still stored', async () => {
    const base = seeded(); const drive = new ControlledDrive(base, true); drive.install();
    const session = await RecordSession.open(cloudHost());
    const b = manager('b').save(stampProfile(clone(base), { birthYear: 1981 }, NOW));
    await drive.bReady.promise;
    const [erased] = await Promise.all([session.deleteAllData(), b]);
    racePreconditions(drive);
    // The erase's verify finds the pre-erase copy, retries, and lands the erase.
    expect(erased.success).toBe(true);
    expect(drive.aPatches).toBeGreaterThan(1);
    expect(drive.body.measurements.map(x => x.id)).not.toContain('listed-weight');
    expect(drive.body.meta.eraseEpoch).toBeGreaterThan(base.meta.eraseEpoch ?? 0);
  });

  it('control: an ordinary save after an erase, with its erased list stored, is not refused', async () => {
    const erased = buildErasedFile({ stored: seeded(), own: seeded(), device: null, ctx: CTX });
    expect(erased.erasedRows?.ids).toContain('listed-weight');
    const drive = new ControlledDrive(erased, false); drive.install();
    const edited = stampProfile(clone(erased), { heightCm: 181 }, NOW);
    edited.measurements.push(createMeasurement({ id: 'after-erase', metricType: 'weight', value: 79, recordedAt: '2026-10-03', createdAt: NOW }));
    const saved = await manager('a').save(edited);
    expect(saved.attempts).toBe(0);
    expect(drive.body.profile.heightCm).toBe(181);
    expect(drive.body.measurements.map(x => x.id)).toEqual(['after-erase']);
  });

  it('a profile save that a newer erase replaced takes the erase in, not its pre-erase copy', async () => {
    // mergeFiles lets the higher erase epoch decide the profile, so the edit
    // is gone by design (US-11 AC6). The save must hand back the erased record
    // after one retry, never its own pre-erase copy, and must not storm.
    const base = stampProfile(createEmptyFile(CTX), { heightCm: 170 }, NOW);
    const drive = new ControlledDrive(base, true); drive.install();
    const erased = buildErasedFile({ stored: clone(base), own: clone(base), device: null, ctx: { deviceId: 'b', now: NOW } });
    const b = manager('b').save(erased);
    await drive.bReady.promise;
    const a = manager('a').save(stampProfile(clone(base), { heightCm: 180 }, NOW));
    const [aSaved, bSaved] = await Promise.allSettled([a, b]);
    expect(drive.unexpected).toEqual([]);
    expect(drive.trace.indexOf('a:patch-committed')).toBeLessThan(drive.trace.indexOf('b:patch-committed'));
    expect(bSaved.status).toBe('fulfilled');
    expect(aSaved.status).toBe('fulfilled');
    if (aSaved.status !== 'fulfilled') throw aSaved.reason;
    expect(aSaved.value.attempts).toBeLessThanOrEqual(1);
    expect(aSaved.value.file.meta.eraseEpoch).toBe(1);
    expect(drive.body.meta.eraseEpoch).toBe(1);
  });
});

describe('verifyPersistedFile: writes that add no row (US-10 AC6a, US-11 AC7)', () => {
  const erasedFrom = (file: RoadmapFile) => buildErasedFile({ stored: clone(file), own: clone(file), device: null, ctx: CTX });
  const readBack = (file: RoadmapFile) => ROADMAP_DOC.migrate(clone(file), CTX);
  const verify = (expected: RoadmapFile, stored: RoadmapFile) => () => verifyPersistedFile(ROADMAP_DOC, expected, readBack(stored), CTX);

  it('accepts its own erase read back', () => {
    const erased = erasedFrom(seeded());
    expect(verify(erased, erased)).not.toThrow();
  });

  it('refuses a stored file whose erase epoch is behind the one written, even with no row to list', () => {
    // A profile-only record: the erase lists nothing, so only the epoch shows
    // that a pre-erase copy replaced it.
    const base = stampProfile(createEmptyFile(CTX), { heightCm: 170 }, NOW);
    const erased = erasedFrom(base);
    expect(erased.erasedRows?.ids ?? []).toEqual([]);
    expect(verify(erased, { ...base, meta: { ...base.meta, lamport: erased.meta.lamport } })).toThrow(/the erase this save wrote/);
  });

  it('refuses a stored file at the erase epoch that still holds a row the erase listed', () => {
    // A writer that erased at the same epoch without our list (an app from
    // before listed erases) kept the row; migration only drops rows the
    // stored file's own list names.
    const base = seeded();
    const erased = erasedFrom(base);
    const back = { ...clone(base), meta: { ...base.meta, eraseEpoch: erased.meta.eraseEpoch, lamport: erased.meta.lamport } };
    expect(readBack(back).measurements.map((row) => row.id)).toContain('listed-weight');
    expect(verify(erased, back)).toThrow(/a row this save erased/);
  });

  it('refuses a stored file at the erase epoch whose erased list lost an id ours wrote', () => {
    // Two erases at one epoch: a concurrent one that listed fewer rows
    // replaced ours. Both files hold no rows, so only the list shows the loss.
    const erased = erasedFrom(seeded());
    const ids = erased.erasedRows!.ids;
    expect(ids).toContain('listed-weight');
    const back = { ...clone(erased), erasedRows: { ...erased.erasedRows!, ids: ids.filter((id) => id !== 'listed-weight') } };
    expect(verify(erased, back)).toThrow(/the erased list this save wrote/);
  });

  it('refuses a stored screening answer older than the one written', () => {
    const base = seeded();
    const ours = setScreening(clone(base), 'colorectalMethod', 'colonoscopy', NOW);
    expect(verify(ours, { ...base, meta: { ...base.meta, lamport: ours.meta.lamport } })).toThrow(/1 profile or screening field/);
  });

  it('on a tied clock, refuses when merge would keep our value and accepts when it keeps theirs', () => {
    // mergeFields breaks a tie by the larger value, so only then is ours lost.
    const base = seeded();
    const at = (h: number) => stampProfile(clone(base), { heightCm: h }, NOW);
    const tied = (ours: RoadmapFile, theirs: RoadmapFile) => ({ ...theirs, meta: { ...theirs.meta, lamport: ours.meta.lamport } });
    expect(at(180).profile.fieldStamps?.heightCm).toEqual(at(175).profile.fieldStamps?.heightCm);
    expect(verify(at(180), tied(at(180), at(175)))).toThrow(/1 profile or screening field/);
    expect(verify(at(175), tied(at(175), at(180)))).not.toThrow();
  });

  it('accepts a stored file whose erase epoch was raised past ours with our fields kept', () => {
    // While a copy is unreadable, writeDriveRecord writes an erase at an epoch
    // past every copy's, above the one SyncManager merged. That is not a lost
    // write, so it must not be refused until the retries run out.
    const ours = buildErasedFile({ stored: seeded(), own: seeded(), device: null, ctx: CTX });
    const raised = clone(ours);
    raised.meta.eraseEpoch = (ours.meta.eraseEpoch ?? 0) + 1;
    expect(verify(ours, raised)).not.toThrow();
  });

  it('accepts a stored field another writer stamped later (last write wins)', () => {
    const base = seeded();
    const ours = stampProfile(clone(base), { heightCm: 180 }, NOW);
    const theirs = stampProfile(clone(ours), { heightCm: 175 }, '2026-10-21T12:00:01.000Z');
    expect(verify(ours, theirs)).not.toThrow();
  });

  it('accepts its own field write when migration clamps a clock that runs ahead of the file', () => {
    const ours = stampProfile(seeded(), { heightCm: 180 }, '2030-01-01T00:00:00.000Z');
    ours.meta.updatedAt = NOW;
    // Precondition: the re-read really does move that field's clock.
    expect(readBack(ours).profile.fieldStamps?.heightCm?.updatedAt).not.toBe(ours.profile.fieldStamps?.heightCm?.updatedAt);
    expect(verify(ours, ours)).not.toThrow();
  });
});

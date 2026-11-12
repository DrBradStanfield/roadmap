/**
 * @vitest-environment jsdom
 *
 * US-09 AC2c: a cloud page takes in this device's copy only while it is still
 * that page's mirror and the page may write. A cloud page whose open is still
 * loading its cloud record when another page logs off, and a guest page then
 * saves on this device and connects (setting the marker), holds its cloud copy
 * only: nothing from the device copy, no save carrying it, and the marker stays
 * for the session that owns it now. Each page is a fresh module graph over the
 * one localStorage, as browser tabs are. The engine rules: health-core
 * record-session.mirror-ours.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, type ReadResult } from '@roadmap/health-core/adapter';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { createMeasurement, type RoadmapFile } from '@roadmap/health-core/roadmap-file';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const BACKEND_KEY = 'health_roadmap_backend';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';

/** A fresh page, loaded with the device's log-off id and chosen store as they are now. */
async function page() {
  vi.resetModules();
  return {
    local: await import('./local-storage-adapter'),
    host: await import('./web-record-host'),
    record: await import('@roadmap/health-core/record-session'),
  };
}
type Page = Awaited<ReturnType<typeof page>>;
type Session = Awaited<ReturnType<Page['record']['RecordSession']['open']>>;

/** A cloud ('memory') whose reads wait until `release`, and which keeps every body written to it. */
class HeldCloud extends MemoryAdapter {
  written: string[] = [];
  private held: Array<() => void> = [];
  hold = true;
  override async read(name: string): Promise<ReadResult> {
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    return super.read(name);
  }
  override async write(...args: Parameters<MemoryAdapter['write']>) {
    this.written.push(JSON.stringify(args[1]));
    return super.write(...args);
  }
  release(): void {
    this.hold = false;
    this.held.splice(0).forEach((resolve) => resolve());
  }
}

const addWeight = (session: Session, id: string) => session.edit((f) => {
  f.measurements.push(createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: '2026-11-13T09:00:00.000Z' }));
});
const ids = (file: RoadmapFile) => file.measurements.map((m) => m.id).sort();

/** A log-off on another page: a new log-off id, the named files cleared, and no store chosen. */
async function logOffOnAnotherPage(): Promise<void> {
  const other = await page();
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
  other.local.clearLocalNamedFiles();
  localStorage.removeItem(BACKEND_KEY);
}

/** A guest page saves `id` to this device's record, then connects a cloud: the connect marks the copy pending. */
async function guestSavesAndConnects(id: string): Promise<void> {
  const guest = await page();
  const session = await guest.record.RecordSession.open(guest.host.webRecordHost(new guest.local.LocalStorageAdapter()));
  addWeight(session, id);
  await session.flush();
  guest.host.markSyncPending(); // as finishFormConnect does before its lift
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory');
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-before');
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('US-09 AC2c: a cloud page takes in the device copy only while it is that page\'s mirror and the page may write', () => {
  it('a cloud page still loading when another page logs off and a guest saves and connects holds its cloud copy only', async () => {
    const cloud = new MemoryCloud();
    const a = await page();
    const seed = await a.record.RecordSession.open(a.host.webRecordHost(new MemoryAdapter(cloud)));
    addWeight(seed, 'cloud-row');
    await seed.flush();

    const held = new HeldCloud(cloud);
    const opening = a.record.RecordSession.open(a.host.webRecordHost(held)); // held on its cloud load
    await logOffOnAnotherPage();
    await guestSavesAndConnects('guest-row');
    expect(localStorage.getItem('health_roadmap_file_v2')).toContain('guest-row'); // the guest's save landed
    const pending = (await page()).host.isSyncPending;
    expect(pending()).toBe(true);

    held.release();
    const session = await opening;
    expect(ids(session.file)).toEqual(['cloud-row']); // its cloud copy only
    await session.flush();
    expect(held.written.some((body) => body.includes('guest-row'))).toBe(false); // no save carries it
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).not.toContain('guest-row');
    expect(pending()).toBe(true); // the marker is left
  });

  it('with no log-off, a cloud page opening with the marker set takes the device copy in and clears the marker once saved', async () => {
    const cloud = new MemoryCloud();
    const guest = await page();
    const device = await guest.record.RecordSession.open(guest.host.webRecordHost(new guest.local.LocalStorageAdapter()));
    addWeight(device, 'device-row');
    await device.flush();
    guest.host.markSyncPending();

    const a = await page();
    const session = await a.record.RecordSession.open(a.host.webRecordHost(new MemoryAdapter(cloud)));
    expect(ids(session.file)).toEqual(['device-row']);
    await session.flush();
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toContain('device-row');
    expect(a.host.isSyncPending()).toBe(false);
  });
});

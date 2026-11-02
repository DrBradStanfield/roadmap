// @vitest-environment jsdom
/**
 * US-09 AC32: the Pages test page's Dropbox round-trip never writes to the
 * person's health record. test.html ships with the Pages build, and the
 * Dropbox tokens are shared with the app on the same origin, so someone who
 * connected Dropbox in the app arrives on it already connected. The real page
 * code and the real SyncManager run over an in-memory Dropbox. Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFile, createMeasurement, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';

const { cloud } = vi.hoisted(() => ({
  cloud: {
    current: null as unknown,
    /** Set once a SyncManager save has returned, so the reads after it are the read-back. */
    saved: false,
    readsAfterSave: [] as string[],
    /** The read-back comes back without the test row, as a lost write would. */
    loseTestRow: false,
  },
}));

vi.mock('../src/storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage')>();
  /** A connected Dropbox whose files live in memory. */
  class FakeDropboxAdapter extends real.MemoryAdapter {
    static async completeRedirect() { return null; }
    constructor() { super(cloud.current as InstanceType<typeof real.MemoryCloud>); }
    isConnected() { return true; }
    async connect() {}
    async disconnect() {}
    async read(fileName: string, signal?: AbortSignal) {
      const result = await super.read(fileName, signal);
      if (!cloud.saved) return result;
      cloud.readsAfterSave.push(fileName);
      if (!cloud.loseTestRow || result.body == null) return result;
      const body = result.body as RoadmapFile;
      return { ...result, body: { ...body, measurements: body.measurements.filter(m => !m.id.startsWith('dbx_test_')) } };
    }
  }
  return { ...real, DropboxAdapter: FakeDropboxAdapter };
});

const { MemoryAdapter, MemoryCloud, SyncManager } = await import('../src/storage');
const { initDropboxTest } = await import('./dropbox-test');

beforeEach(() => {
  Object.assign(cloud, { saved: false, readsAfterSave: [], loseTestRow: false });
  const save = SyncManager.prototype.save;
  vi.spyOn(SyncManager.prototype, 'save').mockImplementation(async function (this: InstanceType<typeof SyncManager>, ...args) {
    const result = await save.apply(this, args);
    cloud.saved = true;
    return result;
  });
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

/** The person's record in their Dropbox: one LDL of their own. */
async function seededCloud() {
  const memory = new MemoryCloud();
  const record: RoadmapFile = createEmptyFile({ deviceId: 'synthetic-phone', now: '2026-10-01T00:00:00.000Z' });
  record.measurements.push(createMeasurement({
    id: 'm_own', metricType: 'ldl', value: 3.4, recordedAt: '2026-09-30', createdAt: '2026-10-01T00:00:00.000Z',
  }));
  await new MemoryAdapter(memory).write(ROADMAP_FILE_NAME, record, null);
  cloud.current = memory;
  return memory;
}

async function runRoundTrip() {
  const els = { status: document.createElement('div'), actions: document.createElement('div'), result: document.createElement('div') };
  document.body.append(els.status, els.actions, els.result);
  await initDropboxTest(els);
  const run = [...els.actions.querySelectorAll('button')].find(b => b.textContent === 'Run round-trip');
  expect(run).toBeDefined();
  run!.click();
  await vi.waitFor(() => expect(els.result.textContent).not.toBe('Running…'));
  return els.result.textContent ?? '';
}

describe('US-09 AC32: the Dropbox round-trip on test.html leaves the health record alone', () => {
  it('the record file is byte for byte as it was, and the round-trip still passes', async () => {
    const memory = await seededCloud();
    const before = memory.files.get(ROADMAP_FILE_NAME)!.json;
    const result = await runRoundTrip();
    expect(result).toMatch(/^✓ PASS/);
    expect(memory.files.get(ROADMAP_FILE_NAME)!.json).toBe(before);
  });

  it('it writes its own file, which the page names, and reads that file back after the save', async () => {
    const memory = await seededCloud();
    const result = await runRoundTrip();
    const own = [...memory.files.keys()].filter(name => name !== ROADMAP_FILE_NAME);
    expect(own).toHaveLength(1);
    const written = JSON.parse(memory.files.get(own[0])!.json) as RoadmapFile;
    expect(written.measurements.map(m => [m.metricType, m.value])).toEqual([['ldl', 2.1]]);
    expect(cloud.readsAfterSave).toEqual([own[0]]);
    expect(result).toContain(own[0]);
    expect(result).not.toContain(ROADMAP_FILE_NAME);
  });

  it('a read-back without the test row reports FAIL, not PASS', async () => {
    await seededCloud();
    cloud.loseTestRow = true;
    const result = await runRoundTrip();
    expect(result).toMatch(/^✗ FAIL — record not found after reload/);
  });
});

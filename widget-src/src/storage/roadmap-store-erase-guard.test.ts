// @vitest-environment jsdom
/**
 * US-16 AC2a (adversary R6, 2026-10-21): the store refuses a write the page
 * made against an erase it no longer holds. Two cases. While this copy's own
 * erase swaps in and writes, every write is refused. And once the page has
 * marked the erase it shows (`showErase`), a write is refused while this copy
 * is at another one: what the page shows is pre-erase. A refusal is each
 * method's own error answer, never a throw, and leaves the record as it was.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAdapter, MemoryCloud, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from './roadmap-store';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const fileOf = (store: RoadmapStore) => (store as unknown as { file: RoadmapFile }).file;
const cloudFile = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;

/** This copy's cloud: `hold` stops the erase at its write until released. */
class HeldCloud extends MemoryAdapter {
  private gate: Promise<void> | null = null;
  private entered: () => void = () => {};
  hold() {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { this.entered = r; });
    return { reached, release };
  }
  async write(...args: Parameters<MemoryAdapter['write']>) {
    if (this.gate && args[0] === ROADMAP_FILE_NAME && ((args[1] as RoadmapFile).meta?.eraseEpoch ?? 0) > 0) {
      this.entered();
      await this.gate;
    }
    return super.write(...args);
  }
}

/** A store holding one of everything a write below can touch. */
async function seeded(adapter: MemoryAdapter) {
  const store = await RoadmapStore.create(adapter);
  store.saveChangedMeasurements({ sex: 'male', heightCm: 178 }, {});
  const weight = store.addMeasurement('weight', 82, '2026-09-01');
  store.saveMedication('statin', 'rosuvastatin', 10, 'mg');
  store.saveSupplement('omega3', 'Omega-3', 1, 'g');
  const { saved } = await store.bulkSaveDocuments([{
    documentType: 'lab_report', title: 'Synthetic report', documentDate: '2026-09-01',
    contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'synthetic.pdf',
  }]);
  await store.flush();
  if (weight.status !== 'inserted') throw new Error('setup failed');
  return { store, weightId: weight.row.id, documentId: saved[0].id };
}

/** Every write the page reaches, each with the answer a refusal gives. */
const WRITES: Array<[string, (s: RoadmapStore, ids: { weightId: string; documentId: string }) => unknown | Promise<unknown>, unknown]> = [
  ['addMeasurement', (s) => s.addMeasurement('waist', 90, '2026-09-02'), { status: 'error' }],
  ['correctValue', (s, ids) => s.correctValue(ids.weightId, 81), 'error'],
  ['saveChangedMeasurements', (s) => s.saveChangedMeasurements({ heightCm: 181 }, { heightCm: 178 }), false],
  ['saveMedication', (s) => s.saveMedication('statin', 'atorvastatin', 20, 'mg'), false],
  ['saveSupplement', (s) => s.saveSupplement('vitd', 'Vitamin D', 25, 'mcg'), false],
  ['deleteSupplementApi', (s) => s.deleteSupplementApi('omega3'), false],
  ['saveScreening', (s) => s.saveScreening('colorectal_method', 'fit'), false],
  ['bulkSaveMeasurements', (s) => s.bulkSaveMeasurements([{ metricType: 'waist', value: 90, recordedAt: '2026-09-02', source: 'manual' }]), { saved: [], skippedDuplicates: 0, errorCount: 1, refused: [] }],
  ['bulkSaveLabValues', (s) => s.bulkSaveLabValues([{ metricName: 'Ferritin', value: 75, unit: 'µg/L', recordedAt: '2026-09-01' }]), { saved: [], skippedDuplicates: 0, errorCount: 1, refused: [] }],
  ['bulkSaveDocuments', (s) => s.bulkSaveDocuments([{
    documentType: 'lab_report', title: 'Another report', documentDate: '2026-09-02',
    contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'another.pdf',
  }]), { saved: [], errorCount: 1 }],
  ['deleteDocument', (s, ids) => s.deleteDocument(ids.documentId), false],
  ['setLpaUnit', (s) => s.setLpaUnit('mg/dL'), undefined],
  ['markReportEmailCaptured', (s) => s.markReportEmailCaptured(), undefined],
  ['setReminderOptIn', (s) => s.setReminderOptIn({ status: 'active', token: 't', email: 'a@example.com', provider: 'dropbox' }), undefined],
];

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('US-16 AC2a: the store refuses a write made against an erase it no longer holds', () => {
  it.each(WRITES)('%s: refused while the page shows another erase, and the record is unchanged', async (_name, write, refusal) => {
    const { store, ...ids } = await seeded(new MemoryAdapter(new MemoryCloud()));
    store.showErase(store.eraseIdentity);
    expect(store.shownErase).toBe(store.eraseIdentity);
    const before = JSON.stringify(fileOf(store));
    store.showErase('[0,"an erase the page showed"]');
    expect(await write(store, ids)).toEqual(refusal);
    expect(JSON.stringify(fileOf(store))).toBe(before);
  });

  it.each(WRITES)('%s: refused while this copy\'s erase is writing, and the erased record stays empty', async (_name, write, refusal) => {
    const cloud = new MemoryCloud();
    const adapter = new HeldCloud(cloud);
    const { store, ...ids } = await seeded(adapter);
    const held = adapter.hold();
    const erase = store.deleteUserData();
    await held.reached;
    const erased = JSON.stringify(fileOf(store));
    expect(await write(store, ids)).toEqual(refusal);
    expect(JSON.stringify(fileOf(store))).toBe(erased);
    held.release();
    expect((await erase).success).toBe(true);
    const file = cloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect([file.measurements, file.labValues, file.medications, file.supplements, file.documents]).toEqual([[], [], [], [], []]);
    expect(file.profile).not.toHaveProperty('heightCm');
  });

  it('with no page mark, and once the erase has written, writes land as before', async () => {
    const cloud = new MemoryCloud();
    const { store } = await seeded(new MemoryAdapter(cloud));
    expect((await store.deleteUserData()).success).toBe(true);
    expect(store.addMeasurement('waist', 90, '2026-09-02').status).toBe('inserted');
    store.showErase(store.eraseIdentity); // the page shows the erased record
    expect(store.saveMedication('statin', 'atorvastatin', 20, 'mg')).toBe(true);
  });
});

// Adversary R3: a pass that folds a remote change in, then a later pass that
// fails, left the page unaware of the change until a reload.
describe('US-34 AC1: a save that folds a remote change in announces it even when a later pass fails', () => {
  it('fires the remote-change event when the second pass throws', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 82, '2026-09-01');
    await store.flush();
    // Another device saves a waist.
    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    other.addMeasurement('waist', 90, '2026-09-01');
    await other.flush();
    // This copy saves; while its first write is in flight it changes again,
    // so the save goes round, and that second write fails.
    let writes = 0;
    const write = MemoryAdapter.prototype.write;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
      writes += 1;
      if (writes === 1) {
        store.addMeasurement('weight', 83, '2026-09-02');
        return write.apply(this, args);
      }
      throw new Error('cloud did not answer');
    });
    const heard = vi.fn();
    window.addEventListener(REMOTE_CHANGED_EVENT, heard);
    try {
      store.addMeasurement('ldl', 3.1, '2026-09-01');
      await expect(store.flush()).rejects.toThrow();
    } finally {
      window.removeEventListener(REMOTE_CHANGED_EVENT, heard);
    }
    expect(store.loadAllHistory().some((m) => m.metricType === 'waist')).toBe(true);
    expect(heard).toHaveBeenCalled();
  });
});

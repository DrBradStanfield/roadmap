/**
 * US-11 AC15 review (R1): a save takes in what its own merge wrote, never the
 * check's read back as truth. A writer that lands between the write and the
 * check can drop a monotonic flag (a document's `deleted`) while keeping the
 * row, so the check passes; the tab must still hold what it merged. The check's
 * read reaches only the erase's teardown (`landedOptIn`). Synthetic data.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost } from './record-host';
import { RecordSession } from './record-session';
import { createEmptyFile, type FileDocument, type RoadmapFile } from './roadmap-file';

const NOW = '2026-11-27T12:00:00.000Z';
let tick = Date.parse(NOW);

/** The tab's cloud: after its next write, `stale` rewrites the file before the check reads it. */
class RacedCloud extends MemoryAdapter {
  stale: ((written: RoadmapFile) => RoadmapFile) | null = null;
  private written: RoadmapFile | null = null;
  async write(...args: Parameters<MemoryAdapter['write']>) {
    const out = await super.write(...args);
    if (this.stale) this.written = args[1] as RoadmapFile;
    return out;
  }
  async read(...args: Parameters<MemoryAdapter['read']>) {
    if (this.stale && this.written) {
      const replaced = this.stale(this.written);
      this.stale = null;
      this.written = null;
      const entry = this.cloud.files.get(ROADMAP_FILE_NAME)!;
      this.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(replaced), version: entry.version + 1 });
    }
    return super.read(...args);
  }
}

function host(store: MemoryAdapter): RecordHost {
  return {
    store,
    clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
    deviceId: () => 'tab',
    clock: { now: () => (tick += 60_000) },
    timers: { set: () => 0, clear: () => {} },
    remoteChanged: () => {},
    failureCause: () => 'x',
    report: () => {},
    tier: 'cloud',
    mirror: {
      adapter: new MemoryAdapter(new MemoryCloud()),
      pending: { get: () => false, set: () => {}, clear: () => {} },
      writesStopped: () => false,
      wipe: async () => {},
      opened: () => {},
    },
  } as unknown as RecordHost;
}

const doc: FileDocument = {
  id: 'doc_d', title: 'Report', type: 'pathology_report', date: '2026-11-01', fileRef: '', contentHash: '',
  mimeType: '', extractedText: '', addedAt: '2026-11-01T00:00:00.000Z', sourceFileName: 'report.pdf',
};

describe('US-11 AC15 review R1: a save adopts what it merged, not the check read', () => {
  it('a check read that keeps document D but loses its deleted flag leaves the tab holding D deleted', async () => {
    const cloud = new MemoryCloud();
    const start = createEmptyFile({ deviceId: 'seed', now: NOW });
    start.documents = [doc];
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(start), version: 1 });
    const store = new RacedCloud(cloud);
    const session = await RecordSession.open(host(store));
    // Another device deletes D.
    const deleted = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    deleted.documents = [{ ...doc, deleted: true }];
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(deleted), version: 2 });
    // A stale writer lands between this tab's write and its check: the same file, D's flag gone.
    store.stale = (written) => ({ ...written, documents: written.documents.map((d) => ({ ...d, deleted: undefined })) });

    session.edit((file) => { file.profile = { ...file.profile, heightCm: 170 }; }, session.shownErase);
    await session.flush();

    expect(session.file.documents.find((d) => d.id === 'doc_d')?.deleted).toBe(true);
  });
});

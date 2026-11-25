/**
 * US-31 AC6 / US-07 — a measurement added "now" slots on the user's LOCAL day.
 *
 * The picked-date path (`ensureIsoDatetime`) already stores the typed calendar
 * day. The now-path stored the raw instant, so an 11am Auckland entry landed on
 * the previous UTC day — the same value entered two ways could occupy two
 * slots. The timezone is pinned per-file, never suite-wide, and vitest.config
 * runs the whole suite in the `forks` pool: only a real child process picks up
 * a `process.env.TZ` assignment (a worker thread inherits a copy of the
 * environment and never re-reads the zone).
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { uploadThrough } from '../testing/upload-save-kit';

afterEach(() => {
  vi.useRealTimers();
});

describe('RoadmapStore — local calendar day', () => {
  it('stores an 11am Auckland entry on 2026-09-02, not the UTC 2026-09-01', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-01T23:00:00.000Z') });
    const store = await RoadmapStore.create(new MemoryAdapter());

    const result = store.addMeasurement('weight', 80, undefined, store.shownErase);
    expect(result.status).toBe('inserted');
    if (result.status === 'inserted') expect(result.row.recordedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('names an undated document’s blob with the local day, not the UTC one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-01T23:00:00.000Z') });
    const store = await RoadmapStore.create(new MemoryAdapter());

    expect(await uploadThrough(store, [{
      documentType: 'lab_result', title: 'Lipid panel', documentDate: null,
      contentMd: '# Lipids', metadata: {}, sourceFileName: 'lipids.pdf',
      file: new Blob(['lipids'], { type: 'application/pdf' }),
    }])).toMatchObject({ ok: true, outcome: { unstored: 0 } });
    const [doc] = store.file.documents;

    expect(doc.fileRef).toContain('2026-09-02');
    expect(doc.fileRef).not.toContain('2026-09-01');
  });
});

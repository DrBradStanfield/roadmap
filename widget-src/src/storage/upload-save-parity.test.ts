// @vitest-environment jsdom
/**
 * US-52 AC8c, design 12c: the web's Save is health-core `uploadSave` in one session edit
 * (RoadmapStore.saveUpload). Before the web's own save path went (lib/upload-save.ts `saveReview`:
 * bulkSaveMeasurements, bulkSaveLabValues, synthesizeLabArchiveEntries, connectorDocumentEntries,
 * bulkSaveDocuments, and useReviewDocuments' screening update through the page), it was run on 40
 * seeded picks and its record pinned: upload-save-parity.pin.json. The new path must write the same
 * rows and the same screening dates on the same picks, the screening date from an eligible letter and
 * none from an ineligible one included. Off-cloud, as the pin was taken. Ids and stamps by content.
 *
 * One documented difference: an edited lab value. The old store filed every lab row `lab_import`;
 * the plan keeps `lab_import_edited` (design 12c), as the old path already did for a core value.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from './roadmap-store';
import { NOW, rowsOf, seededPicks } from './upload-save-parity.picks';

type Rows = { m: Array<Record<string, unknown>>; l: Array<Record<string, unknown>>; d: unknown[]; s: Record<string, unknown> };
const PIN = JSON.parse(readFileSync(join(__dirname, 'upload-save-parity.pin.json'), 'utf8')) as Rows[];

/** The pinned old rows with the one documented difference applied: an edited lab keeps its marker. */
function expected(pin: Rows, edited: Set<string>): Rows {
  const l = pin.l.map((row) => (edited.has(`${row.metricName}|${row.value}`) && !row.core ? { ...row, source: 'lab_import_edited' } : row));
  return { ...pin, l: l.sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q))) };
}

describe('the web saves through uploadSave what its own save path wrote (US-52 AC8c, design 12c)', () => {
  it('on the 40 pinned picks: the same rows and the same screening dates', async () => {
    const picks = seededPicks();
    expect(PIN).toHaveLength(picks.length);
    let screenings = 0;
    let rows = 0;
    for (const [seed, { state, profile }] of picks.entries()) {
      const cloud = new MemoryCloud();
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      store.showErase(store.eraseIdentity);
      const answer = await store.saveUpload(state, store.file, NOW, false, { holds: () => false, original: () => null, mimeType: () => '', screening: profile, now: () => NOW });
      expect(answer.ok, `seed ${seed}`).toBe(true);
      await store.flush();
      const mine = rowsOf(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile) as Rows;
      // The labs a person edited in this pick, by name and number.
      const edited = new Set(('files' in state ? state.files : []).flatMap((f) => (f.status.s === 'read'
        ? Object.entries(f.status.choices.edits).filter(([ref]) => ref[0] === 'a').map(([ref, v]) => `${f.status.s === 'read' ? f.status.extraction.additionalValues?.[Number(ref.slice(1))]?.name : ''}|${v}`) : [])));
      expect(mine, `seed ${seed}`).toEqual(expected(PIN[seed], edited));
      screenings += Object.keys(mine.s).length;
      rows += mine.m.length + mine.l.length + mine.d.length;
    }
    // The pin is meaningful: eligible letters wrote their date, and many rows were compared.
    expect(screenings).toBeGreaterThan(3);
    expect(rows).toBeGreaterThan(150);
  });

  it('an ineligible letter writes no screening date; an eligible one writes its day (US-06 AC5)', async () => {
    const pick = seededPicks().find((p) => p.profile.age === 60 && 'files' in p.state && p.state.files.some((f) => f.status.s === 'read' && f.status.extraction.document?.metadata?.screeningType))!;
    for (const [age, writes] of [[60, true], [30, false]] as const) {
      const cloud = new MemoryCloud();
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      store.showErase(store.eraseIdentity);
      await store.saveUpload(pick.state, store.file, NOW, false, { holds: () => false, original: () => null, mimeType: () => '', screening: { age, sex: 'male' }, now: () => NOW });
      expect(!!store.file.screenings.colorectalLastDate, `age ${age}`).toBe(writes);
    }
  });
});

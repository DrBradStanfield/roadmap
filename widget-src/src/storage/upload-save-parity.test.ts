/**
 * US-52 AC8c: health-core `uploadSave` (the iPhone's one Save) writes the same record rows as the
 * website's own save functions for the same pick: RoadmapStore.bulkSaveMeasurements and
 * bulkSaveLabValues, labRowsByFile, archive-payloads.ts synthesizeLabArchiveEntries and
 * connectorDocumentEntries, then RoadmapStore.bulkSaveDocuments, in useUploadFlow.ts's order.
 * Off-cloud: no original is attached, as the web strips them without a cloud archive.
 * The web's choices are the plan's (one review rule for both); its writes are its own.
 * Seeded synthetic picks; ids and times compared by order, not value.
 */
import { describe, expect, it } from 'vitest';
import { NO_CHOICES as NO } from '@roadmap/health-core/upload-choices';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { labRowsByFile } from '@roadmap/health-core/document-rows';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { uploadSavePlan } from '@roadmap/health-core/upload-plan';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { uploadSave } from '@roadmap/health-core/upload-save';
import { RoadmapStore, type BulkLabValueInput, type BulkMeasurementInput } from './roadmap-store';
import { connectorDocumentEntries, synthesizeLabArchiveEntries } from '../lib/archive-payloads';
import { fileKey } from '../lib/file-key';
import type { FileResult } from '../lib/upload-pipeline';

const NOW = '2026-11-02T00:00:00.000Z';
const value = (metric: string, v: number) => ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const });
const labX = (day: string, v: number): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: day, values: [value('ldl', v), value('hdl', v / 2)], additionalValues: [{ name: 'Ferritin', value: 80 + v, unit: 'µg/L' }], unrecognized: [], document: null });
const letterX = (i: number): UnifiedExtractionResult => ({
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: `Synthetic letter ${i}`, documentDate: '2026-10-20', contentMarkdown: '## Plan', metadata: {} },
});
const read = (id: string, extraction: UnifiedExtractionResult): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: NO } });

/** The website's save of the plan's choices, through its own functions, on a fresh store. */
async function webSave(s: UploadState): Promise<RoadmapFile> {
  const cloud = new MemoryCloud();
  const store = await RoadmapStore.create(new MemoryAdapter(cloud));
  const empty = createEmptyFile({ deviceId: 'web', now: NOW });
  const plan = uploadSavePlan(s, empty, NOW, uploadReview(s, empty, NOW), false);
  const files = 'files' in s ? s.files : [];
  // The reviewed files as the web holds them, in pick order: fileKey is the hash, as on the web.
  const reviewed: FileResult[] = files.flatMap((f) => (f.status.s === 'read' ? [{
    fileName: f.name, contentHash: f.hash ?? undefined, reportDate: f.status.extraction.reportDate,
    values: f.status.extraction.values, additionalValues: f.status.extraction.additionalValues,
    ...(f.status.extraction.document && f.status.extraction.classification !== 'lab_report' ? { document: f.status.extraction.document as FileResult['document'] } : {}),
  }] : []));
  const keyOf = (fileId: string) => fileKey({ contentHash: files.find((f) => f.id === fileId)?.hash ?? undefined }, 0);
  const measurements: Array<BulkMeasurementInput & { file: string }> = [];
  const labs: Array<BulkLabValueInput & { file: string }> = [];
  for (const { fileId, rows } of plan.labRows) {
    for (const row of rows) {
      if (row.kind === 'measurement') { const { kind: _, ...m } = row; measurements.push({ ...m, file: keyOf(fileId) }); } else { const { kind: _, ...l } = row; labs.push({ ...l, file: keyOf(fileId) }); }
    }
  }
  const strip = <T extends { file: string }>(xs: T[]) => xs.map(({ file: _, ...x }) => x);
  const savedValues = store.bulkSaveMeasurements(strip(measurements));
  const savedLabs = store.bulkSaveLabValues(strip(labs));
  const labRows = labRowsByFile([...(savedValues.labRows ?? []), ...(savedLabs.labRows ?? [])], [...measurements, ...labs].map((x) => x.file));
  const covered = new Set(plan.documents.map((d) => keyOf(d.fileId)));
  const payloads = [
    ...plan.documents.map((d) => ({ ...d.fields, contentHash: files.find((f) => f.id === d.fileId)?.hash ?? undefined })),
    ...synthesizeLabArchiveEntries(reviewed, covered, labRows),
    ...connectorDocumentEntries(reviewed, [], covered),
  ];
  if (payloads.length) await store.bulkSaveDocuments(payloads);
  await store.flush();
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

/**
 * The record's rows as sets: every id named by the row's content (its test, day, value and state; a
 * document's hash, kind and state), every stamp left out, each table sorted. The web writes all
 * vitals, then all lab rows, across files; uploadSave writes file by file: the same rows, in another order.
 */
function rows(file: RoadmapFile): unknown {
  const name = new Map<string, string>();
  for (const r of [...file.measurements, ...file.labValues] as unknown as Array<Record<string, unknown>>) {
    name.set(r.id as string, [r.metricType ?? r.metricName, r.recordedAt, r.value, r.status].join('|'));
  }
  for (const d of file.documents) name.set(d.id, `${d.contentHash}|${d.type}|${d.deleted ? 'deleted' : 'live'}`);
  const STAMPS = /^(createdAt|addedAt|updatedAt|lamport|deviceId|lastDeviceId)$/;
  const table = (xs: unknown[]) => xs.map((x) => JSON.parse(JSON.stringify(x), (key, v) => {
    if (STAMPS.test(key)) return undefined;
    if ((key === 'id' || key === 'correctsId') && typeof v === 'string') return name.get(v) ?? v;
    if (key === 'rows' && Array.isArray(v)) return v.map((x: string) => name.get(x) ?? x).sort();
    return v;
  })).sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
  return { m: table(file.measurements), l: table(file.labValues), d: table(file.documents) };
}

describe('uploadSave writes what the website\'s save writes (US-52 AC8c)', () => {
  it('on 40 seeded off-cloud picks of lab reports and letters', async () => {
    let r = 11;
    const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let seed = 0; seed < 40; seed++) {
      const files = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => (rand() < 0.6
        ? read(`f${seed}-${i}`, labX(rand() < 0.5 ? '2026-10-01' : '2026-09-01', 2 + Math.floor(rand() * 5) / 10))
        : read(`f${seed}-${i}`, letterX(i))));
      const s: UploadState = { phase: 'saving', platform: 'web', run: 1, files, started: NOW, firstRead: NOW, attempt: 1 };
      const out = await uploadSave(s, createEmptyFile({ deviceId: 'web', now: NOW }), NOW, false, { holds: () => false, original: () => null, mimeType: () => '', write: async () => {} });
      if (!out.ok) throw new Error(out.reason);
      const mine = out.commit(createEmptyFile({ deviceId: 'web', now: NOW })).file;
      expect(rows(mine), `seed ${seed}`).toEqual(rows(await webSave(s)));
    }
  });
});

// @vitest-environment jsdom
// TEMPORARY: writes the golden pin of the OLD web save path (lib/upload-save.ts saveReview, with
// useReviewDocuments' screening rule) before it is deleted (design 12c). Run once with GENERATE_UPLOAD_PIN=1.
import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { isScreeningEligible } from '@roadmap/health-core/types';
import { uploadSavePlan } from '@roadmap/health-core/upload-plan';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { initRoadmapStore, flushRoadmapStore, saveScreening } from '../lib/roadmap-data';
import { saveReview } from '../lib/upload-save';
import { fileKey } from '../lib/file-key';
import { readDocumentDate } from '../lib/review-dates';
import type { DocumentToSave, FileResult, ReviewDecisions } from '../lib/upload-pipeline';
import { NOW, rowsOf, seededPicks } from './upload-save-parity.picks';

describe.runIf(process.env.GENERATE_UPLOAD_PIN === '1')('generate the old web save pin', () => {
  it('writes upload-save-parity.pin.json', async () => {
    const out: unknown[] = [];
    for (const { state: s, profile } of seededPicks()) {
      const cloud = new MemoryCloud();
      await initRoadmapStore(new MemoryAdapter(cloud));
      const empty = createEmptyFile({ deviceId: 'web', now: NOW });
      const plan = uploadSavePlan(s, empty, NOW, uploadReview(s, empty, NOW), false);
      const files = 'files' in s ? s.files : [];
      const read = files.filter((f) => f.status.s === 'read');
      const keyOf = (id: string) => fileKey({ contentHash: files.find((f) => f.id === id)?.hash ?? undefined }, 0);
      const values: ReviewDecisions['values'] = [];
      const labValues: ReviewDecisions['labValues'] = [];
      for (const { fileId, rows } of plan.labRows) for (const row of rows) {
        if (row.kind === 'measurement') values.push({ metric: row.metricType, valueSI: row.value, recordedAt: row.recordedAt, source: row.source === 'lab_import_edited' ? row.source : undefined, correctsId: row.correctsId, ...(row.comparator ? { comparator: row.comparator } : {}), file: keyOf(fileId) });
        else labValues.push({ name: row.metricName, value: row.value, unit: row.unit, referenceLow: row.referenceLow, referenceHigh: row.referenceHigh, recordedAt: row.recordedAt, correctsId: row.correctsId, ...(row.comparator ? { comparator: row.comparator } : {}), file: keyOf(fileId) });
      }
      const documents: DocumentToSave[] = plan.documents.map((d) => {
        const f = files.find((x) => x.id === d.fileId)!;
        if (f.status.s !== 'read') throw new Error('unread');
        const doc = f.status.extraction.document!;
        const type = doc.metadata?.screeningType as string | undefined;
        // useReviewDocuments: ticked by default when eligible with a known age; the person's tick wins; dated by the day, else the month.
        const ticked = f.status.choices.screening ?? (!!type && profile.age !== undefined && isScreeningEligible(type, profile.age, profile.sex));
        const date = readDocumentDate(doc.documentDate);
        const screeningDate = date.day ?? date.month;
        return { ...d.fields, screeningUpdate: type && ticked && screeningDate ? { key: `${type}_last_date`, date: screeningDate } : undefined, contentHash: f.hash ?? undefined, fileKey: keyOf(f.id) };
      });
      const review = uploadReview(s, empty, NOW);
      const reviewed: FileResult[] = read.map((f) => {
        if (f.status.s !== 'read') throw new Error('unread');
        const x = f.status.extraction;
        const lab = review.labFiles.find((l) => l.fileId === f.id);
        return {
          fileName: f.name, contentHash: f.hash ?? undefined, reportDate: lab ? lab.day : x.reportDate,
          values: x.values, additionalValues: x.additionalValues,
          ...(x.document && x.classification !== 'lab_report' ? { document: x.document as FileResult['document'] } : {}),
        };
      });
      const answer = await saveReview({ values, labValues, documents, reviewed }, {
        earlierRows: new Map(), complete: () => {}, existing: [],
        screening: (key, value) => void saveScreening(key, value),
      });
      if (answer.message) throw new Error(answer.message);
      await flushRoadmapStore();
      out.push(rowsOf(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile));
    }
    writeFileSync(join(__dirname, 'upload-save-parity.pin.json'), `${JSON.stringify(out, null, 1)}\n`);
  });
});

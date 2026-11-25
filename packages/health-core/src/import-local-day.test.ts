/**
 * Issue #934, US-31 AC6: an import with no `latestDay` dates "today" by the
 * writer's LOCAL day, as record-edits does. Before, `prepareImport` and the
 * import_documents tool defaulted to the UTC day, so on a local surface an
 * Auckland-morning lab dated today was refused as a future day. The hosted
 * server passes `latestDayOnEarth(now)` and is unaffected.
 *
 * The zone is pinned in this file only (the forks pool picks it up), as
 * record-edits-local-day.test.ts explains.
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, expect, it } from 'vitest';
import { createEmptyFile } from './roadmap-file';
import type { UnifiedExtractionResult } from './lab-extraction';
import { runToolOverSync } from './mcp-tools';
import { prepareImport, type ExtractedFile, type ImportPayload, type ImportSurface } from './mcp-import';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { recordSync } from './roadmap-doc';
import { ROADMAP_FILE_NAME } from './adapter';

/** 2026-09-01T23:00Z is 2026-09-02, 11am, in Auckland. */
const NOW = '2026-09-01T23:00:00.000Z';
const LOCAL_TODAY = '2026-09-02';

const ldl = { metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const };
function labOn(reportDate: string): ExtractedFile {
  const result: UnifiedExtractionResult = { classification: 'lab_report', reportDate, values: [ldl], additionalValues: [], unrecognized: [], document: null };
  return { name: `lab-${reportDate}.pdf`, contentHash: `sha256-${reportDate}`, mimeType: 'application/pdf', status: 'extracted', result };
}
const prepare = (file: ExtractedFile) =>
  prepareImport(createEmptyFile({ deviceId: 'local_day', now: NOW }), { route: 'dropbox', files: [file], remaining: [] },
    { now: NOW, maxCorrectionAgeDays: 90, payloadId: 'p1' });

describe('#934: with no latestDay, an import dates today by the local day', () => {
  it('takes a lab dated local today', () => {
    expect(prepare(labOn(LOCAL_TODAY)).payload.candidates).toHaveLength(1);
  });

  it('control: still refuses local tomorrow', () => {
    expect(prepare(labOn('2026-09-03')).payload.candidates).toHaveLength(0);
  });
});

describe('#934: the import_documents tool, called with no latestDay, does the same', () => {
  it('offers a lab dated local today', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(createEmptyFile({ deviceId: 'local_day', now: NOW })), version: 1 });
    const surface: ImportSurface = {
      maxCorrectionAgeDays: 90, budgetMs: 40_000,
      async extract() { return { route: 'dropbox', files: [labOn(LOCAL_TODAY)], remaining: [] }; },
      async stash(payload: ImportPayload) { return { receipt: `r-${payload.id}`, expiresAt: '2026-09-02T00:00:00Z' }; },
      async open() { return { refusal: 'unused' }; },
      async discard() {},
    };
    const answer = await runToolOverSync(recordSync(new MemoryAdapter(cloud), 'test', NOW), 'import_documents', {}, NOW, { importer: surface });
    expect((answer.structured as { candidates: unknown[] }).candidates).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import type { UnifiedExtractionResult } from './lab-extraction';
import { runToolOverSync } from './mcp-tools';
import { MAX_UNRECOGNIZED_LINES } from './mcp-tool-contract';
import { extractNext, prepareImport, type ExtractedFile, type ImportBundle, type ImportPayload, type ImportSurface } from './mcp-import';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { recordSync } from './roadmap-doc';
import { ROADMAP_FILE_NAME } from './adapter';
import { LAB_CATALOG } from './lab-catalog';

// US-35 AC10a: `unrecognized` stops at MAX_UNRECOGNIZED_LINES (AC10). The
// count in `next` was taken after the cut, so refused rows past the cap were
// neither listed nor counted.
const NOW = '2026-09-01T09:00:00Z';
const TODAY = '2026-09-01';
const base = (): RoadmapFile => createEmptyFile({ deviceId: 'refused', now: NOW });

/** A dated lab report: one value the record takes, `lines` lines the reader could not place, `badUnits` catalogued tests in a unit the catalogue refuses. */
function report(prefix: string, lines: number, badUnits = 0): UnifiedExtractionResult {
  return {
    classification: 'lab_report', reportDate: '2026-08-20', values: [], document: null,
    unrecognized: Array.from({ length: lines }, (_, i) => `${prefix} line ${i}`),
    additionalValues: [
      { name: `${prefix} test`, value: 5, unit: 'U/L' },
      ...LAB_CATALOG.slice(0, badUnits).map((entry) => ({ name: entry.label, value: 5, unit: 'furlongs' })),
    ],
  };
}
const file = (name: string, result: UnifiedExtractionResult): ExtractedFile =>
  ({ name, contentHash: `sha256-${name}`, mimeType: 'application/pdf', status: 'extracted', result });

interface Extract { candidates: unknown[]; unrecognized: string[]; next: string }

/** One import_documents extract over an in-memory record, the surface handing back these files. */
async function extract(files: ExtractedFile[]): Promise<Extract> {
  const bundle: ImportBundle = { route: 'dropbox', files, remaining: [] };
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(base()), version: 1 });
  const sync = recordSync(new MemoryAdapter(cloud), 'test', NOW);
  const surface: ImportSurface = {
    maxCorrectionAgeDays: 90, budgetMs: 40_000,
    async extract() { return bundle; },
    async stash(payload: ImportPayload) { return { receipt: `r-${payload.id}`, expiresAt: '2026-09-01T10:00:00Z' }; },
    async open() { return { refusal: 'unused' }; },
    async discard() {},
  };
  const answer = await runToolOverSync(sync, 'import_documents', {}, NOW, { importer: surface, latestDay: TODAY });
  return answer.structured as Extract;
}

describe('US-35 AC10a: refused rows past the unrecognized cap are counted in next', () => {
  it('60 refused rows over three reports: 50 lines are listed, and next says 60 and that the list leaves out 10', async () => {
    const r = await extract([file('a.pdf', report('a', 20)), file('b.pdf', report('b', 0, 20)), file('c.pdf', report('c', 20))]);
    expect(r.candidates).toHaveLength(3);
    expect(r.unrecognized).toHaveLength(MAX_UNRECOGNIZED_LINES);
    expect(r.unrecognized[20].startsWith(`${LAB_CATALOG[0].label}: `)).toBe(true); // a refused unit, between the two reports' unread lines
    expect(r.unrecognized[49]).toBe('c line 9');
    expect(r.next).toContain(
      ' 60 value(s) could not be filed: show unrecognized, which lists the first 50. Tell the user the list leaves out 10 more, and to check the reports for them.',
    );
  });

  it('one row past the cap is counted as 1 more', async () => {
    const r = await extract([file('a.pdf', report('a', 51))]);
    expect(r.unrecognized).toHaveLength(MAX_UNRECOGNIZED_LINES);
    expect(r.next).toContain(' 51 value(s) could not be filed: show unrecognized, which lists the first 50. Tell the user the list leaves out 1 more,');
  });

  it('at the cap or under it the sentence is the one it was', async () => {
    for (const n of [50, 3]) {
      const r = await extract([file('a.pdf', report('a', n))]);
      expect(r.unrecognized).toHaveLength(n);
      expect(r.next).toContain(` ${n} value(s) could not be filed: show unrecognized.`);
      expect(r.next).not.toContain('leaves out');
    }
    const none = await extract([file('a.pdf', report('a', 0))]);
    expect(none.next).not.toContain('could not be filed');
  });

  // Not through the tool: file_results takes at most 50 rows a call, so this drives the two functions directly.
  it('prepareImport and extractNext, called directly on the file_results route with 60 lines, carry the same count', () => {
    const bundle: ImportBundle = { route: 'assistant', files: [file('a.pdf', report('a', 60))], remaining: [] };
    const prepared = prepareImport(base(), bundle, { now: NOW, latestDay: TODAY, payloadId: 'p1' });
    const next = extractNext(prepared, [], 'assistant');
    expect(next).toContain(' 60 value(s) could not be filed: show unrecognized, which lists the first 50. Tell the user the list leaves out 10 more,');
    expect(next).toContain('Then call file_results with commit');
  });
});

import { describe, expect, it } from 'vitest';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import type { UnifiedExtractionResult } from './lab-extraction';
import { runToolOverSync } from './mcp-tools';
import { MAX_IMPORT_CANDIDATES } from './mcp-tool-contract';
import { prepareImport, type ExtractedFile, type ImportBundle, type ImportPayload, type ImportSurface } from './mcp-import';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { recordSync } from './roadmap-doc';
import { ROADMAP_FILE_NAME } from './adapter';

// US-35 AC7a: a receipt holds MAX_IMPORT_CANDIDATES candidates. A report whose
// values did not fit was still filed, and a filed report answers
// already_imported, so the values past the cap could never be offered.
const NOW = '2026-09-01T09:00:00Z';
const TODAY = '2026-09-01';

const base = (): RoadmapFile => createEmptyFile({ deviceId: 'cap', now: NOW });

/** A lab report with `n` lab values, named by `prefix` so two reports never share a slot. */
function report(prefix: string, n: number): UnifiedExtractionResult {
  return {
    classification: 'lab_report', reportDate: '2026-08-20', values: [], unrecognized: [`${prefix}: unread line`], document: null,
    additionalValues: Array.from({ length: n }, (_, i) => ({ name: `${prefix} test ${i}`, value: i + 1, unit: 'U/L' })),
  };
}
const LETTER: UnifiedExtractionResult = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'clinic_letter', title: 'Clinic letter', documentDate: '2026-05-01', contentMarkdown: '', metadata: {} },
};
const file = (name: string, result: UnifiedExtractionResult): ExtractedFile =>
  ({ name, contentHash: `sha256-${name}`, mimeType: 'application/pdf', status: 'extracted', result });

interface Extract {
  files: Array<{ name: string; hint?: string; droppedValues?: number }>;
  candidates: Array<{ sourceFileName: string; metric: string }>;
  documents: Array<{ sourceFileName: string }>;
  unrecognized: string[];
  remaining: string[];
  next: string;
  receipt?: string;
}

/** One import_documents extract over an in-memory record, the surface handing back these files. */
async function extract(files: ExtractedFile[], remaining: string[] = [], fileDates?: Record<string, string>): Promise<Extract> {
  const bundle: ImportBundle = { route: 'dropbox', files, remaining, ...(fileDates ? { fileDates } : null) };
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
const sources = (r: Extract) => [...new Set(r.candidates.map((c) => c.sourceFileName))];
const NEXT_CALL = 'file(s) were not reached: commit this receipt first, then call again with fileNames set to remaining.';

describe('US-35 AC7a — a report that would overflow the receipt waits for the next call, and no value is cut unsaid', () => {
  it('the report that would overflow, and every file after it, wait; the earlier report is offered and filed whole', async () => {
    const r = await extract([file('a.pdf', report('a', 200)), file('b.pdf', report('b', 150)), file('letter.pdf', LETTER)], ['c.pdf']);
    expect(r.candidates).toHaveLength(200);
    expect(sources(r)).toEqual(['a.pdf']);
    expect(r.documents.map((d) => d.sourceFileName)).toEqual(['a.pdf']);
    expect(r.files.map((f) => f.name)).toEqual(['a.pdf']);
    expect(r.unrecognized).toEqual(['a: unread line']);
    expect(r.remaining).toEqual(['b.pdf', 'letter.pdf', 'c.pdf']);
    expect(r.next).toContain(`3 ${NEXT_CALL}`);
  });

  it('a report that overflows on its core values waits too', async () => {
    const core: UnifiedExtractionResult = {
      ...report('b', 0),
      values: [
        { metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
        { metric: 'hdl', valueSI: 1.4, displayValue: 1.4, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
      ],
    };
    const r = await extract([file('a.pdf', report('a', MAX_IMPORT_CANDIDATES - 1)), file('b.pdf', core)]);
    expect(sources(r)).toEqual(['a.pdf']);
    expect(r.remaining).toEqual(['b.pdf']);
  });

  it('one value already in the receipt is enough to make a full report wait', async () => {
    const r = await extract([file('a.pdf', report('a', 1)), file('b.pdf', report('b', MAX_IMPORT_CANDIDATES))]);
    expect(sources(r)).toEqual(['a.pdf']);
    expect(r.remaining).toEqual(['b.pdf']);
  });

  it('a report that fills the receipt exactly is filed whole, and the next waits', async () => {
    const r = await extract([file('a.pdf', report('a', MAX_IMPORT_CANDIDATES)), file('b.pdf', report('b', 1))]);
    expect(r.candidates).toHaveLength(MAX_IMPORT_CANDIDATES);
    expect(r.documents.map((d) => d.sourceFileName)).toEqual(['a.pdf']);
    expect(r.remaining).toEqual(['b.pdf']);
  });

  it('reports that fit together are all offered, and a letter after them is filed; nothing waits', async () => {
    const r = await extract([file('a.pdf', report('a', 150)), file('b.pdf', report('b', 150)), file('letter.pdf', LETTER)]);
    expect(r.candidates).toHaveLength(300);
    expect(r.documents.map((d) => d.sourceFileName)).toEqual(['a.pdf', 'b.pdf', 'letter.pdf']);
    expect(r.remaining).toEqual([]);
    expect(r.next).not.toContain(NEXT_CALL);
  });

  it('a file that was not read holds no room in the receipt', async () => {
    const failed: ExtractedFile = { ...file('x.pdf', report('x', 250)), status: 'failed', reason: 'too_large' };
    const r = await extract([file('a.pdf', report('a', 100)), failed, file('b.pdf', report('b', 200))]);
    expect(sources(r)).toEqual(['a.pdf', 'b.pdf']);
    expect(r.remaining).toEqual([]);
  });

  it('a letter before a full report does not make it wait', async () => {
    const r = await extract([file('letter.pdf', LETTER), file('a.pdf', report('a', MAX_IMPORT_CANDIDATES))]);
    expect(r.candidates).toHaveLength(MAX_IMPORT_CANDIDATES);
    expect(r.remaining).toEqual([]);
  });

  it('prepareImport alone still stops at the cap, for a caller that skips fitReceipt', () => {
    const ldl = { metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const };
    const over = { ...report('x', 1), values: Array.from({ length: MAX_IMPORT_CANDIDATES + 1 }, () => ldl) };
    const { payload } = prepareImport(base(), { route: 'dropbox', files: [file('x.pdf', over)], remaining: [] },
      { now: NOW, latestDay: TODAY, maxCorrectionAgeDays: 90, payloadId: 'p1' });
    expect(payload.candidates).toHaveLength(MAX_IMPORT_CANDIDATES);
  });

  it('ZIP members that wait come back once, under the ZIP\'s own name, which is what fileNames can ask for', async () => {
    const member = (name: string, n: number): ExtractedFile => ({ ...file(`labs.zip/${name}`, report(name, n)), zip: 'labs.zip' });
    const skipped: ExtractedFile = { name: 'labs.zip/inner.zip', status: 'skipped', reason: 'nested_zip', zip: 'labs.zip' };
    const r = await extract([member('a', 200), member('b', 150), member('c', 10), skipped, file('d.pdf', report('d', 5))], ['labs.zip', 'e.pdf']);
    expect(sources(r)).toEqual(['labs.zip/a']);
    // labs.zip is also in the surface's own remaining (a member it ran out of time for): named once.
    expect(r.remaining).toEqual(['labs.zip', 'd.pdf', 'e.pdf']);
  });

  it('an undated or refused-date ZIP member ahead of a long one holds no room, so the long one is offered', async () => {
    const member = (name: string, result: UnifiedExtractionResult): ExtractedFile => ({ ...file(`labs.zip/${name}`, result), zip: 'labs.zip' });
    const undated = member('a.pdf', { ...report('a', 200), reportDate: null });
    const r = await extract([undated, member('b.pdf', report('b', 150))]);
    expect(r.files.find((f) => f.name === 'labs.zip/a.pdf')).toMatchObject({ status: 'failed', reason: 'no_date' });
    expect(sources(r)).toEqual(['labs.zip/b.pdf']);
    expect(r.remaining).toEqual([]);
    expect(r.receipt).toBeDefined();
    // A date the user gave that the record refuses (a future day) is bad_date, and holds no room either.
    const refused = await extract([member('a.pdf', report('a', 200)), member('b.pdf', report('b', 150))], [], { 'labs.zip/a.pdf': '2027-01-01' });
    expect(refused.files.find((f) => f.name === 'labs.zip/a.pdf')).toMatchObject({ status: 'failed', reason: 'bad_date' });
    expect(sources(refused)).toEqual(['labs.zip/b.pdf']);
    expect(refused.remaining).toEqual([]);
  });

  it('a second copy of the same bytes in one call holds no room', async () => {
    const twin: ExtractedFile = { ...file('a (1).pdf', report('a', 200)), contentHash: 'sha256-a.pdf' };
    const r = await extract([file('a.pdf', report('a', 200)), twin, file('b.pdf', report('b', 100))]);
    expect(r.files.find((f) => f.name === 'a (1).pdf')).toMatchObject({ status: 'already_imported' });
    expect(sources(r)).toEqual(['a.pdf', 'b.pdf']);
    expect(r.remaining).toEqual([]);
  });

  it('with no receipt issued, next never says to commit one first', async () => {
    const failed: ExtractedFile = { ...file('x.pdf', report('x', 5)), status: 'failed', reason: 'too_large' };
    const r = await extract([failed], ['c.pdf']);
    expect(r.receipt).toBeUndefined();
    expect(r.remaining).toEqual(['c.pdf']);
    expect(r.next).not.toContain('commit this receipt');
    expect(r.next).toContain('1 file(s) were not reached: call again with fileNames set to remaining.');
  });

  it('one report longer than any receipt keeps its first rows, core first, and says how many were left out', async () => {
    const big: UnifiedExtractionResult = {
      ...report('big', MAX_IMPORT_CANDIDATES + 4),
      values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
      droppedValueCount: 2,
    };
    const r = await extract([file('big.pdf', big)]);
    expect(r.candidates).toHaveLength(MAX_IMPORT_CANDIDATES);
    expect(r.candidates[0].metric).toBe('ldl');
    expect(r.candidates.at(-1)!.metric).toBe(`big test ${MAX_IMPORT_CANDIDATES - 2}`);
    expect(r.remaining).toEqual([]);
    // 5 rows past the cap, plus the 2 the parse already could not read.
    expect(r.files[0].droppedValues).toBe(7);
    expect(r.next).toContain("1 file(s) had values that could not be read: relay that file's hint.");
  });
});

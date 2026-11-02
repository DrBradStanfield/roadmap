import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { OUTPUTS, runToolOverSync, type ExtractedFile, type ImportPayload, type ImportSurface } from './mcp-tools';
import { recordSync } from './roadmap-doc';
import { createEmptyFile } from './roadmap-file';

// US-36 AC7a: file_results takes at most 50 rows a call, and its description
// tells the assistant to split a longer report over calls with the same
// sourceFileName. The first commit files the report, and from then on a call
// with that name and date is `already_imported` ("Nothing to do"), so a part
// read after a commit was lost. Each part's `next` told the assistant to show
// the candidates, wait and commit, which is the order that loses the rest. The
// `next` of an assistant read with values now says to send every remaining part
// before any commit. (The tool description is frozen during the connector's
// review, US-35 AC13, so the instruction rides on the result.)
const NOW = '2026-09-01T09:00:00Z';
const TODAY = NOW.slice(0, 10);
const DAY = '2026-08-20';
const SPLIT = 'If the report has result lines this call did not carry, send them now with the same sourceFileName, before any commit: once filed, the report reads as already imported.';
const PER_RECEIPT = 'for each receipt, one call per receipt (each part numbers its ids from c1)';
const part = (values: unknown[]) => ({ sourceFileName: 'Results.pdf', classification: 'lab_report', collectedOn: DAY, values });
const first = part([{ metric: 'ldl', printedName: 'LDL Cholesterol', value: 2.8, unit: 'mmol/L' }]);
const second = part([{ metric: 'Ferritin', printedName: 'Ferritin', value: 180, unit: 'ug/L' }]);
const folderFile: ExtractedFile = {
  name: 'folder-labs.pdf', contentHash: 'sha256-folder', mimeType: 'application/pdf', status: 'extracted',
  result: {
    classification: 'lab_report', reportDate: DAY, document: null, additionalValues: [], unrecognized: [],
    values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
  },
};

function setup() {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(createEmptyFile({ deviceId: 'synthetic', now: NOW })), version: 1 });
  const sync = recordSync(new MemoryAdapter(cloud), 'synthetic', NOW);
  const pending = new Map<string, ImportPayload>();
  const surface: ImportSurface = {
    budgetMs: 10_000,
    maxCorrectionAgeDays: 90,
    async extract() { return { route: 'dropbox', remaining: [], files: [folderFile] }; },
    async stash(payload) { pending.set(payload.id, payload); return { receipt: payload.id, expiresAt: '2026-09-01T10:00:00Z' }; },
    async open(commit) { return pending.get(commit.receipt) ?? { refusal: 'Unknown synthetic receipt.' }; },
    async discard(payload) { pending.delete(payload.id); },
  };
  const call = async (tool: 'file_results' | 'import_documents', args: unknown) => {
    const out = await runToolOverSync(sync, tool, args, NOW, { importer: surface, latestDay: TODAY });
    expect(out.isError, out.text).toBe(false);
    return OUTPUTS[tool].parse(out.structured);
  };
  const commit = (receipt: string | undefined, accept: string[]) =>
    call('file_results', { commit: { receipt, accept, replace: [], approval: 'yes, file them' } });
  return { sync, call, commit };
}

describe('US-36 AC7a — a long report split over file_results calls', () => {
  it('a read with values tells the assistant to send the other parts before any commit', async () => {
    const { call } = setup();
    const read = await call('file_results', first);
    expect(read.next.split('\n')).toContain(SPLIT);
    // Said before the commit instruction, so it is read first.
    expect(read.next.indexOf(SPLIT)).toBeLessThan(read.next.indexOf('Then call file_results with commit'));
  });

  // Each part has its own receipt, and each receipt numbers its candidates from
  // c1, so "commit the receipt" let an assistant commit one part and leave the
  // others to expire unfiled. Every part's `next` says to commit each receipt.
  it('each part of a multi-part read says to commit each receipt, one call per receipt', async () => {
    const { call } = setup();
    const a = await call('file_results', first);
    const b = await call('file_results', second);
    expect(a.receipt).not.toBe(b.receipt);
    for (const part of [a, b]) {
      expect(part.next).toContain(`Then call file_results with commit ${PER_RECEIPT}: the receipt, accept (ids to file)`);
      expect(part.next).not.toContain('with commit: the receipt');
    }
  });

  it('every part read before the first commit lands, under one document', async () => {
    const { sync, call, commit } = setup();
    const a = await call('file_results', first);
    const b = await call('file_results', second);
    expect(b.files[0].status).toBe('extracted');
    await commit(a.receipt, a.candidates.map((c) => c.id));
    await commit(b.receipt, b.candidates.map((c) => c.id));
    const file = await sync.load();
    expect(file.measurements.map((m) => [m.metricType, m.value])).toEqual([['ldl', 2.8]]);
    expect(file.labValues.map((l) => [l.metricName, l.value])).toEqual([['Ferritin', 180]]);
    expect(file.documents.filter((d) => d.sourceFileName === 'Results.pdf')).toHaveLength(1);
  });

  it('a part read after a commit is already_imported and offers nothing, which is why the order matters', async () => {
    const { call, commit } = setup();
    const a = await call('file_results', first);
    await commit(a.receipt, a.candidates.map((c) => c.id));
    const late = await call('file_results', second);
    expect(late.files[0].status).toBe('already_imported');
    expect(late.candidates).toEqual([]);
  });

  it('a letter with no values is not told to split', async () => {
    const { call } = setup();
    const letter = await call('file_results', { sourceFileName: 'letter.pdf', classification: 'clinic_letter', document: { title: 'Synthetic review', type: 'clinic_letter', date: '2026-08-01' } });
    expect(letter.next).toContain('Then call file_results with commit');
    expect(letter.next).not.toContain(SPLIT);
  });

  it('the folder route, which reads whole files itself, is not told to split', async () => {
    const { call } = setup();
    const folder = await call('import_documents', {});
    expect(folder.candidates).toHaveLength(1);
    expect(folder.next).toContain('Then call import_documents with commit');
    expect(folder.next).not.toContain(SPLIT);
    expect(folder.next).not.toContain(PER_RECEIPT);
  });
});

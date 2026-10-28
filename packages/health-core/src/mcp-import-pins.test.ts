/**
 * US-35 / US-36 characterisation pins (plan docs/reviews/2026-10-23-mcp-dedup-plan.md,
 * step 1): what both import tools answer today, through `runToolOverSync`,
 * byte for byte — the extract answer, the pending `ImportPayload` JSON the
 * surface parks, the commit receipt and the rows the commit appends. A later
 * de-dup that moves code must leave every pin alone, except the one row
 * change the plan names (the lab-report archive row's `labArchive: true`).
 *
 * Seams: the clock is `NOW`; the receipt is the surface's own (`receipt-<payload id>`);
 * `crypto.randomUUID` ids (payload, document and row ids) are masked in order of
 * first appearance, so the pins hold whatever the ids are. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { recordSync } from './roadmap-doc';
import { ROADMAP_FILE_NAME } from './adapter';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import { LAB_ARCHIVE_TITLE } from './document-path';
import { zipMemberName, type UnifiedExtractionResult } from './lab-extraction';
import {
  MAX_IMPORT_CANDIDATES,
  runToolOverSync,
  type ExtractedFile,
  type ImportBundle,
  type ImportPayload,
  type ImportSurface,
  type ToolAnswer,
} from './mcp-tools';

const NOW = '2026-09-01T09:00:00Z';
const TODAY = NOW.slice(0, 10);
const LAB_DAY = '2026-08-20';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function base(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'pins', now: '2026-09-01T09:00:00Z' });
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({ id: 'm1', metricType: 'ldl', value: 3.4, recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import' }));
  file.measurements.push(createMeasurement({ id: 'm2', metricType: 'ldl', value: 3.0, recordedAt: '2025-01-01', createdAt: '2025-01-01T08:00:00Z', source: 'lab_import' }));
  file.labValues.push({
    id: 'l1', metricName: 'ferritin', value: 210, unit: 'ug/L', referenceLow: null, referenceHigh: null,
    recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import', status: 'active', correctsId: null,
  });
  return file;
}

function labReport(over: Partial<UnifiedExtractionResult> = {}): UnifiedExtractionResult {
  return {
    classification: 'lab_report', reportDate: LAB_DAY,
    values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
    additionalValues: [{ name: 'ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 300 }],
    unrecognized: ['vitamin D: 45 ng/mL'], document: null, ...over,
  };
}

const ldl = (valueSI: number, reportDate: string | null) => labReport({
  reportDate, additionalValues: [], unrecognized: [],
  values: [{ metric: 'ldl', valueSI, displayValue: valueSI, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
});

function extracted(name: string, result: UnifiedExtractionResult, contentHash = `sha256-${name}`): ExtractedFile {
  return { name, contentHash, mimeType: 'application/pdf', status: 'extracted', result };
}

function letter(name = 'letter.pdf', contentHash = 'sha256-letter'): ExtractedFile {
  return { name, contentHash, mimeType: 'application/pdf', status: 'extracted', result: {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2026-05-01', contentMarkdown: 'body', summary: 'Seen in clinic.', metadata: { specialty: 'cardiology' } },
  } };
}

interface Run {
  /** Every step's output, in order, masked: what the pins compare. */
  log: string[];
  answer: ToolAnswer;
  receipt?: string;
}

/**
 * One record, one surface and its parked receipts. `tamper` rewrites a parked
 * payload as `open` hands it back (what a write refuses that the preview did
 * not); `between` changes the record between the two calls (another device).
 */
function harness(opts: { file?: RoadmapFile; bundle?: ImportBundle; client?: string; tamper?: (p: ImportPayload) => ImportPayload } = {}) {
  const cloud = new MemoryCloud();
  const before = opts.file ?? base();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(before), version: 1 });
  const sync = recordSync(new MemoryAdapter(cloud), 'test', NOW);
  const parked = new Map<string, string>();
  const ids = new Map<string, string>();
  const mask = (s: string) => s.replace(UUID, (u) => {
    if (!ids.has(u)) ids.set(u, `<uuid-${ids.size + 1}>`);
    return ids.get(u)!;
  });
  const surface: ImportSurface = {
    maxCorrectionAgeDays: 90,
    budgetMs: 40_000,
    ...(opts.client ? { client: opts.client } : null),
    async extract() { return opts.bundle!; },
    async stash(payload) {
      const receipt = `receipt-${payload.id}`;
      parked.set(receipt, JSON.stringify(payload));
      return { receipt, expiresAt: '2026-09-01T10:00:00Z' };
    },
    async open(commit) {
      const json = parked.get(commit.receipt);
      if (!json) return { refusal: 'That receipt is not valid. Nothing was written.' };
      const payload = JSON.parse(json) as ImportPayload;
      return opts.tamper ? opts.tamper(payload) : payload;
    },
    async discard() {},
  };
  const record = (): RoadmapFile => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);
  /** The rows the record gained, and the rows whose status or tombstone changed. */
  function appended(): string {
    const now = record();
    const was = (rows: Array<{ id: string }>) => new Map(rows.map((r) => [r.id, JSON.stringify(r)]));
    // Sorted on everything but the id: the merge on save orders rows by their random ids.
    const key = (r: { id: string }) => JSON.stringify({ ...r, id: undefined });
    const diff = <T extends { id: string }>(old: T[], next: T[]) => {
      const prior = was(old);
      return next.filter((r) => prior.get(r.id) !== JSON.stringify(r)).sort((x, y) => key(x).localeCompare(key(y)));
    };
    return mask(JSON.stringify({
      measurements: diff(before.measurements, now.measurements),
      labValues: diff(before.labValues, now.labValues),
      documents: diff(before.documents, now.documents),
    }, null, 1));
  }
  async function extract(tool: 'import_documents' | 'file_results', args: unknown): Promise<Run> {
    const answer = await runToolOverSync(sync, tool, args, NOW, { importer: surface, latestDay: TODAY });
    const receipt = (answer.structured as { receipt?: string } | undefined)?.receipt;
    const log = [mask(JSON.stringify({ text: answer.text, isError: answer.isError, reason: answer.reason ?? null }))];
    log.push(receipt ? mask(parked.get(receipt)!) : 'no receipt');
    return { log, answer, receipt };
  }
  async function commit(tool: 'import_documents' | 'file_results', receipt: string, accept: string[], replace: string[] = []): Promise<string[]> {
    const answer = await runToolOverSync(sync, tool, { commit: { receipt, accept, replace } }, NOW, { importer: surface, latestDay: TODAY });
    return [mask(JSON.stringify({ text: answer.text, isError: answer.isError, reason: answer.reason ?? null, structured: answer.structured ?? null })), appended()];
  }
  return { extract, commit, cloud, record, mask, parked, before };
}

const folder = (files: ExtractedFile[], remaining: string[] = []): ImportBundle => ({ route: 'dropbox', remaining, files });

describe('US-35 / US-36 pins — import_documents and file_results answer byte for byte as today', () => {
  it('a lab report: core and additional values, its archive row, all accepted', async () => {
    const h = harness({ bundle: folder([extracted('labs.pdf', labReport())]) });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2'])]).toMatchSnapshot();
  });

  it('a value on its own day (the assistant route), a client named on the rows', async () => {
    const h = harness({ client: 'ChatGPT' });
    const run = await h.extract('file_results', {
      sourceFileName: 'own-day.pdf', classification: 'lab_report', collectedOn: LAB_DAY,
      values: [
        { metric: 'ldl', printedName: 'LDL Cholesterol', value: 2.6, unit: 'mmol/L' },
        { metric: 'ldl', printedName: 'LDL Cholesterol', value: 3.1, unit: 'mmol/L', recordedAt: '2026-02-03' },
        { metric: 'ferritin', printedName: 'Ferritin', value: 90, unit: 'ug/L', recordedAt: '2026-02-03' },
      ],
    });
    expect([...run.log, ...await h.commit('file_results', run.receipt!, ['c1', 'c2', 'c3'])]).toMatchSnapshot();
  });

  it('a dated previous column: dropped on the folder route, kept on the assistant route', async () => {
    const withPrevious = labReport({
      values: [
        { metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
        { metric: 'ldl', valueSI: 3.3, displayValue: 3.3, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', recordedAt: '2026-03-01' },
      ],
      additionalValues: [{ name: 'ferritin', value: 70, unit: 'ug/L', recordedAt: '2026-03-01' }],
    });
    const dropped = harness({ bundle: folder([extracted('prev.pdf', withPrevious)]) });
    const kept = harness({ bundle: { route: 'assistant', remaining: [], files: [extracted('prev.pdf', withPrevious)] } });
    expect([...(await dropped.extract('import_documents', {})).log, ...(await kept.extract('import_documents', {})).log]).toMatchSnapshot();
  });

  it(`MAX_IMPORT_CANDIDATES (${MAX_IMPORT_CANDIDATES}) caps the candidates`, async () => {
    const many = labReport({
      values: [],
      unrecognized: [],
      additionalValues: Array.from({ length: MAX_IMPORT_CANDIDATES + 5 }, (_, i) => ({ name: `Test ${i}`, value: i + 1, unit: 'U/L' })),
    });
    const h = harness({ bundle: folder([extracted('many.pdf', many)]) });
    const run = await h.extract('import_documents', {});
    const data = run.answer.structured as { candidates: unknown[] };
    expect(data.candidates).toHaveLength(MAX_IMPORT_CANDIDATES);
    expect(run.log).toMatchSnapshot();
  });

  it('held_equal is skipped; held_different writes only with replace', async () => {
    const files = [extracted('same.pdf', ldl(3.4, '2026-07-14')), extracted('other.pdf', labReport({ reportDate: '2026-07-14', values: [], unrecognized: [], additionalValues: [{ name: 'ferritin', value: 150, unit: 'ug/L' }] }))];
    const silent = harness({ bundle: folder(files) });
    const s = await silent.extract('import_documents', {});
    const replaced = harness({ bundle: folder(files) });
    const r = await replaced.extract('import_documents', {});
    expect([
      ...s.log, ...await silent.commit('import_documents', s.receipt!, ['c1', 'c2']),
      ...await replaced.commit('import_documents', r.receipt!, ['c1'], ['c2']),
    ]).toMatchSnapshot();
  });

  it('the age rule refuses a replace past 90 days', async () => {
    const h = harness({ bundle: folder([extracted('old.pdf', ldl(3.6, '2025-01-01'))]) });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, [], ['c1'])]).toMatchSnapshot();
  });

  it('a slot that moved between the calls refuses the whole commit', async () => {
    const h = harness({ bundle: folder([extracted('labs.pdf', labReport())]) });
    const run = await h.extract('import_documents', {});
    const moved = h.record();
    moved.measurements.push(createMeasurement({ id: 'm9', metricType: 'ldl', value: 2.2, recordedAt: LAB_DAY, createdAt: NOW, source: 'manual' }));
    h.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(moved), version: 2 });
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2'])]).toMatchSnapshot();
  });

  it('two chosen candidates on one slot (sameDayAs) refuse the commit', async () => {
    const h = harness({ bundle: folder([extracted('prelim.pdf', ldl(3.9, LAB_DAY)), extracted('final.pdf', ldl(3.7, LAB_DAY))]) });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2'])]).toMatchSnapshot();
  });

  it('a write-time unit refusal is said, the rest filed', async () => {
    const h = harness({
      bundle: folder([extracted('units.pdf', labReport({ values: [], unrecognized: [], additionalValues: [
        { name: 'Ferritin', value: 80, unit: 'µg/L' }, { name: 'Neutrophils', value: 2.4, unit: '×10⁹/L' }, { name: 'Sodium', value: 140, unit: 'mmol/L' },
      ] }))]),
      tamper: (p) => ({ ...p, candidates: p.candidates.map((c) => (c.metric === 'ferritin' ? { ...c, unit: 'pmol/L' } : c.metric === 'neutrophils' ? { ...c, unit: 'cells/uL' } : c)) }),
    });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2', 'c3'])]).toMatchSnapshot();
  });

  it('a measurement the write refuses rejects the commit', async () => {
    const h = harness({
      bundle: folder([extracted('labs.pdf', labReport())]),
      tamper: (p) => ({ ...p, candidates: p.candidates.map((c) => (c.kind === 'measurement' ? { ...c, value: 99 } : c)) }),
    });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2'])]).toMatchSnapshot();
  });

  it('fileDates: a refused day is bad_date, an undated report no_date, a good day files', async () => {
    const h = harness({ bundle: folder([extracted('future.pdf', ldl(2.9, null)), extracted('undated.pdf', ldl(2.9, null)), extracted('given.pdf', ldl(2.9, null))]) });
    const run = await h.extract('import_documents', { fileDates: [{ file: 'future.pdf', date: '2099-01-01' }, { file: 'given.pdf', date: '2026-06-02' }] });
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1'])]).toMatchSnapshot();
  });

  it('a clinic letter files metadata only, with an empty commit', async () => {
    const h = harness({ bundle: folder([letter()]) });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, [])]).toMatchSnapshot();
  });

  it('a ZIP member is named zip/member on the rows', async () => {
    const h = harness({ bundle: folder([extracted(zipMemberName('bundle.zip', 'inner/labs.pdf'), labReport()), letter(zipMemberName('bundle.zip', 'letter.pdf'), 'sha256-zip-letter')]) });
    const run = await h.extract('import_documents', {});
    expect([...run.log, ...await h.commit('import_documents', run.receipt!, ['c1', 'c2'])]).toMatchSnapshot();
  });

  it('a hashless re-import: refused at extract by name and date, and dropped at commit when the row lands in between', async () => {
    const held = () => ({
      id: 'd1', title: LAB_ARCHIVE_TITLE, type: 'pathology_report' as const, date: LAB_DAY, fileRef: '', contentHash: '', mimeType: '',
      extractedText: '', addedAt: '2026-08-21T08:00:00Z', metadata: { importedVia: 'assistant' }, sourceFileName: 'labs (1).pdf',
    });
    const call = {
      sourceFileName: 'labs.pdf', classification: 'lab_report', collectedOn: LAB_DAY,
      values: [{ metric: 'hdl', printedName: 'HDL Cholesterol', value: 1.3, unit: 'mmol/L' }],
    };
    const file = base();
    file.documents.push(held());
    const atExtract = harness({ file, client: 'Claude' });
    const refused = await atExtract.extract('file_results', call);
    const atCommit = harness({ client: 'Claude' });
    const run = await atCommit.extract('file_results', call);
    const landed = atCommit.record();
    landed.documents.push(held());
    atCommit.cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(landed), version: 2 });
    expect([...refused.log, ...run.log, ...await atCommit.commit('file_results', run.receipt!, ['c1'])]).toMatchSnapshot();
  });

  it('a hashless assistant-route letter files with its client', async () => {
    const h = harness({ client: 'Claude' });
    const run = await h.extract('file_results', {
      sourceFileName: 'discharge.pdf', classification: 'discharge_summary',
      document: { title: 'Discharge summary', type: 'discharge_summary', date: '2026-06-01', summary: 'Home after two days.' },
    });
    expect([...run.log, ...await h.commit('file_results', run.receipt!, [])]).toMatchSnapshot();
  });

  it('a receipt parked before the change still commits after it', async () => {
    // A pending file exactly as today's extract parks it (captured, not built),
    // so a receipt issued by the old server commits on the new one.
    const parked = '{"id":"11111111-2222-4333-8444-555555555555","route":"dropbox","createdAt":"2026-09-01T09:00:00Z","candidates":[{"id":"c1","kind":"measurement","metric":"ldl","value":2.8,"unit":"mmol/L","displayValue":"2.8","displayUnit":"mmol/L","recordedAt":"2026-08-20","confidence":"high","sourceFileName":"labs.pdf","slot":{"state":"free"}},{"id":"c2","kind":"lab","metric":"ferritin","value":85,"unit":"ug/L","displayValue":"85","displayUnit":"ug/L","recordedAt":"2026-08-20","confidence":"high","referenceLow":30,"referenceHigh":300,"sourceFileName":"labs.pdf","printedName":"ferritin","slot":{"state":"free"}}],"documents":[{"sourceFileName":"labs.pdf","contentHash":"sha256-labs.pdf","mimeType":"application/pdf","type":"pathology_report","title":"Blood test results","date":"2026-08-20"}]}';
    const h = harness();
    h.parked.set('receipt-old', parked);
    expect(await h.commit('import_documents', 'receipt-old', ['c1', 'c2'])).toMatchSnapshot();
  });
});

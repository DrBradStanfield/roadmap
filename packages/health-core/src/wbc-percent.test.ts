/**
 * US-21 AC28 (Brad 2026-11-15): a white-cell differential printed in % is
 * stored as its own blood test (`neutrophils_pct` and the rest), never refused
 * and never worked out from the count. Every door that takes a printed name and
 * unit files a count's name in % under its share: the upload's extraction and
 * bulk save, the connector's file_results, add_lab_values, the CLI's
 * appendLabValue and the typed add. A report that prints both lines stores
 * both, each in its own (metric, day) slot. No suggestion reads them.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { createCoreRow } from './blood-tests';
import { labSearch, parseUnifiedResult, toUnifiedResult } from './lab-extraction';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { addLabValues, OUTPUTS, runToolOverSync } from './mcp-tools';
import { prepareImport, type ExtractedFile, type ImportPayload, type ImportSurface } from './mcp-import';
import { computePlan } from './plan';
import { classifyImportValues } from './import-review';
import { extra, lab } from './import-review.test-helpers';
import { addLabValue, appendLabValue, bulkAppendValues, sameLabQuantity } from './record-edits';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = '2026-09-01T09:00:00Z';
const TODAY = NOW.slice(0, 10);
const DAY = '2026-08-20';
const CTX = { deviceId: 'us21_ac28', now: NOW };

function base(): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({ id: 'm1', metricType: 'weight', value: 82, recordedAt: '2026-01-05', createdAt: '2026-01-05T08:00:00Z', source: 'manual' }));
  file.labValues.push(createCoreRow({ id: 'l1', metric: 'ldl', value: 3.4, recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import' }));
  return file;
}

/** The active lab rows as [metricName, value, unit], sorted. */
const labs = (file: RoadmapFile) => file.labValues.filter((r) => !r.core && r.status === 'active')
  .map((r) => [r.metricName, r.value, r.unit]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

/** A full blood count's differential as the model returns it, printed name beside each row. */
function extracted(rows: Array<[string, number, string]>) {
  return toUnifiedResult(parseUnifiedResult({
    classification: 'lab_report', reportDate: DAY, values: [], document: null,
    additionalValues: rows.map(([printedName, value, unit]) => ({ name: printedName.toLowerCase(), printedName, value, unit, referenceLow: null, referenceHigh: null })),
  }), 'full');
}

/** The website's save of an extraction: every additional value, through the bulk rule. */
function saveUpload(file: RoadmapFile, result: ReturnType<typeof extracted>) {
  return bulkAppendValues(file, result.additionalValues.map((v) => ({
    kind: 'lab' as const, metricName: v.name, value: v.value, unit: v.unit, recordedAt: `${DAY}T00:00:00.000Z`, source: 'lab_import' as const,
  })), NOW);
}

/** file_results over a memory cloud holding `file`: the call, and the cloud to read the record back from. */
function fileResults(file: RoadmapFile) {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
  const sync = recordSync(new MemoryAdapter(cloud), 'synthetic', NOW);
  const pending = new Map<string, ImportPayload>();
  const surface: ImportSurface = {
    budgetMs: 10_000, maxCorrectionAgeDays: 90,
    async extract() { return { route: 'dropbox', remaining: [], files: [] }; },
    async stash(payload) { pending.set(payload.id, payload); return { receipt: payload.id, expiresAt: '2026-09-01T10:00:00Z' }; },
    async open(commit) { return pending.get(commit.receipt) ?? { refusal: 'Unknown synthetic receipt.' }; },
    async discard(payload) { pending.delete(payload.id); },
  };
  const call = async (args: unknown) => {
    const out = await runToolOverSync(sync, 'file_results', args, NOW, { importer: surface, latestDay: TODAY });
    expect(out.isError, out.text).toBe(false);
    return OUTPUTS.file_results.parse(out.structured);
  };
  return { call, cloud };
}

const BOTH: Array<[string, number, string]> = [
  ['Neutrophils', 3.1, '×10⁹/L'], ['Neutrophils', 55, '%'],
  ['Lymphocytes', 1.8, 'x10^9/L'], ['Lymphocytes', 32, '%'],
  ['Monocytes', 0.4, '×10⁹/L'], ['Monocytes', 7, '%'],
  ['Eosinophils', 0.2, '×10⁹/L'], ['Eosinophils', 4, '%'],
  ['Basophils', 0.05, '×10⁹/L'], ['Basophils', 1, '%'],
  ['Immature Granulocytes', 0.02, '×10⁹/L'], ['Immature Granulocytes', 0.4, '%'],
  ['Reticulocytes', 50, '×10⁹/L'], ['Reticulocytes', 1.1, '%'],
  ['NRBC', 0, '×10⁹/L'], ['NRBC', 0, '/100 WBC'],
];

describe('US-21 AC28 — an upload stores a count and its % each under its own key', () => {
  it('US-21 AC28 — a report printing both lines files both, each in its own slot', () => {
    const result = extracted(BOTH);
    expect(result.additionalValues.map((v) => v.name)).toEqual([
      'Neutrophils', 'neutrophils_pct', 'Lymphocytes', 'lymphocytes_pct', 'Monocytes', 'monocytes_pct',
      'Eosinophils', 'eosinophils_pct', 'Basophils', 'basophils_pct', 'Immature Granulocytes', 'immature_granulocytes_pct',
      'Reticulocytes', 'reticulocytes_pct', 'NRBC', 'nrbc_per_100_wbc',
    ]);
    // The printed name rides along unchanged.
    expect(result.additionalValues.find((v) => v.name === 'neutrophils_pct')?.printedName).toBe('Neutrophils');
    const saved = saveUpload(base(), result);
    expect(saved.refused).toEqual([]);
    expect(saved.skippedDuplicates).toBe(0);
    expect(saved.saved).toHaveLength(16);
    expect(labs(saved.file)).toEqual([
      ['Basophils', 0.05, '×10⁹/L'], ['basophils_pct', 1, '%'],
      ['Eosinophils', 0.2, '×10⁹/L'], ['eosinophils_pct', 4, '%'],
      ['Immature Granulocytes', 0.02, '×10⁹/L'], ['immature_granulocytes_pct', 0.4, '%'],
      ['Lymphocytes', 1.8, '×10⁹/L'], ['lymphocytes_pct', 32, '%'],
      ['Monocytes', 0.4, '×10⁹/L'], ['monocytes_pct', 7, '%'],
      ['Neutrophils', 3.1, '×10⁹/L'], ['neutrophils_pct', 55, '%'],
      ['NRBC', 0, '×10⁹/L'], ['nrbc_per_100_wbc', 0, '/100 WBC'],
      ['Reticulocytes', 50, '×10⁹/L'], ['reticulocytes_pct', 1.1, '%'],
    ]);
  });

  it('US-21 AC28 — a report printing only the % stores only the % row', () => {
    const saved = saveUpload(base(), extracted([['Neutrophils', 55, '%'], ['Lymphocytes', 32, '%'], ['NRBC', 0.5, '%']]));
    expect(saved.refused).toEqual([]);
    expect(labs(saved.file)).toEqual([['lymphocytes_pct', 32, '%'], ['neutrophils_pct', 55, '%'], ['nrbc_per_100_wbc', 0.5, '/100 WBC']]);
  });

  it('US-21 AC28 — the bulk save files a count name in % under its share, as the iPhone and the web send it', () => {
    const saved = bulkAppendValues(base(), [
      { kind: 'lab', metricName: 'Neutrophils', value: 55, unit: '%', recordedAt: `${DAY}T00:00:00.000Z`, source: 'lab_import' },
      { kind: 'lab', metricName: 'neutrophils_pct', value: 56, unit: '%', recordedAt: `${DAY}T00:00:00.000Z`, source: 'lab_import' },
    ], NOW);
    // One slot: the second row is the same test on the same day, so dedup keeps the first.
    expect(saved.skippedDuplicates).toBe(1);
    expect(labs(saved.file)).toEqual([['neutrophils_pct', 55, '%']]);
  });

  it('US-21 AC28 — a % past 100 is refused for its number, never stored', () => {
    const saved = saveUpload(base(), extracted([['Neutrophils', 550, '%']]));
    expect(saved.saved).toEqual([]);
    expect(saved.refused).toMatchObject([{ key: 'neutrophils_pct', unit: '%', fault: 'implausible' }]);
  });
});

describe('US-21 AC28 — the agent, CLI and typed doors accept a differential in %', () => {
  it('US-21 AC28 — add_lab_values files Lymphocytes 30 % as lymphocytes_pct beside the count', () => {
    const outcome = addLabValues(base(), { values: [
      { metricName: 'Lymphocytes', value: 30, unit: '%', recordedAt: TODAY },
      { metricName: 'Lymphocytes', value: 1.8, unit: '×10⁹/L', recordedAt: TODAY },
    ] }, CTX);
    expect(outcome.status, outcome.text).toBe('ok');
    expect(labs((outcome as { file: RoadmapFile }).file)).toEqual([['lymphocytes', 1.8, '×10⁹/L'], ['lymphocytes_pct', 30, '%']]);
  });

  it('US-21 AC28 — appendLabValue (the CLI) files Reticulocytes 1.2 % under reticulocytes_pct, and a second one that day is the same slot', () => {
    const first = appendLabValue(base(), { metricName: 'Reticulocytes', value: 1.2, unit: '%', recordedAt: TODAY, now: NOW });
    expect(first.ok && first.row).toMatchObject({ metricName: 'reticulocytes_pct', value: 1.2, unit: '%' });
    const again = appendLabValue((first as { file: RoadmapFile }).file, { metricName: 'Reticulocytes %', value: 1.3, unit: '%', recordedAt: TODAY, now: NOW });
    expect(again).toMatchObject({ ok: false, reason: 'slot-occupied' });
    // The count that day is its own slot.
    const count = appendLabValue((first as { file: RoadmapFile }).file, { metricName: 'Reticulocytes', value: 50, unit: '×10⁹/L', recordedAt: TODAY, now: NOW });
    expect(count.ok && count.row).toMatchObject({ metricName: 'reticulocytes', value: 50 });
  });

  it('US-21 AC28 — the typed add files Neutrophils in % under its share, and names the held row when the day is taken', () => {
    const added = addLabValue(base(), { metricName: 'Neutrophils', value: 55, unit: '%', day: TODAY }, NOW);
    expect(added.ok && added.row).toMatchObject({ metricName: 'neutrophils_pct', value: 55, unit: '%' });
    const taken = addLabValue((added as { file: RoadmapFile }).file, { metricName: 'Neutrophils', value: 60, unit: '%', day: TODAY }, NOW);
    expect(taken).toMatchObject({ ok: false, reason: 'slot-occupied' });
    const nrbc = addLabValue(base(), { metricName: 'NRBC', value: 0.4, unit: '%', day: TODAY }, NOW);
    expect(nrbc.ok && nrbc.row).toMatchObject({ metricName: 'nrbc_per_100_wbc', value: 0.4, unit: '/100 WBC' });
  });

  it('US-21 AC28 — file_results offers and files both lines of a differential', async () => {
    const { call, cloud } = fileResults(base());
    const read = await call({ sourceFileName: 'FBC.pdf', classification: 'lab_report', collectedOn: DAY, values: [
      { metric: 'Neutrophils', printedName: 'Neutrophils', value: 3.1, unit: '×10⁹/L' },
      { metric: 'Neutrophils', printedName: 'Neutrophils', value: 55, unit: '%' },
    ] });
    expect(read.candidates.map((c) => c.metric)).toEqual(['neutrophils', 'neutrophils_pct']);
    expect(read.unrecognized).toEqual([]);
    await call({ commit: { receipt: read.receipt, accept: read.candidates.map((c) => c.id), replace: [], approval: 'yes, file them' } });
    const stored = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(labs(stored)).toEqual([['Neutrophils', 3.1, '×10⁹/L'], ['neutrophils_pct', 55, '%']]);
  });
});

describe('US-21 AC28 — the iPhone add sheet finds the shares by name', () => {
  it('US-21 AC28 — a search for "neutrophils" finds the count and the %, each with its own units', () => {
    const found = labSearch('neutrophils').filter((m) => m.key.startsWith('neutrophils'));
    expect(found.map((m) => [m.key, m.units[0]])).toEqual([['neutrophils', '×10⁹/L'], ['neutrophils_pct', '%']]);
    expect(labSearch('nrbc').map((m) => m.key)).toContain('nrbc_per_100_wbc');
  });
});

describe('US-21 AC28 — no suggestion reads a share', () => {
  it('US-21 AC28 — the plan is the same with and without the % rows, but for its list of labs', () => {
    const without = base();
    const withShares = saveUpload(base(), extracted(BOTH.filter(([, , unit]) => unit === '%' || unit === '/100 WBC'))).file;
    expect(labs(withShares)).toHaveLength(8);
    const at = new Date(NOW);
    const { labs: labsWithout, generatedAt: _a, ...planWithout } = computePlan(without, at);
    const { labs: labsWith, generatedAt: _b, ...planWith } = computePlan(withShares, at);
    expect(planWith).toEqual(planWithout);
    expect(labsWith.length - labsWithout.length).toBe(8);
  });
});

describe('US-21 AC28 — review round: the claimed key, re-imports and a legacy series', () => {
  it('US-21 AC28 — file_results accepts the share key with the plain printed name, keeping the printed name', async () => {
    const { call, cloud } = fileResults(base());
    const read = await call({ sourceFileName: 'FBC.pdf', classification: 'lab_report', collectedOn: DAY, values: [
      { metric: 'neutrophils_pct', printedName: 'Neutrophils', value: 55, unit: '%' },
      { metric: 'nrbc_per_100_wbc', printedName: 'NRBC', value: 0.4, unit: '/100 WBC' },
    ] });
    expect(read.unrecognized).toEqual([]);
    expect(read.candidates.map((c) => [c.metric, c.printedName])).toEqual([['neutrophils_pct', 'Neutrophils'], ['nrbc_per_100_wbc', 'NRBC']]);
    await call({ commit: { receipt: read.receipt, accept: read.candidates.map((c) => c.id), replace: [], approval: 'yes, file them' } });
    expect(labs(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile)).toEqual([['neutrophils_pct', 55, '%'], ['nrbc_per_100_wbc', 0.4, '/100 WBC']]);
  });

  it('US-21 AC28 — the same % is the same quantity under the count name or the share key; BUN keeps its factor', () => {
    expect(sameLabQuantity({ name: 'neutrophils_pct', value: 55, unit: '%' }, { name: 'Neutrophils', value: 55, unit: '%' })).toBe(true);
    expect(sameLabQuantity({ name: 'neutrophils_pct', value: 55, unit: '%' }, { name: 'Neutrophils', value: 56, unit: '%' })).toBe(false);
    expect(sameLabQuantity({ name: 'urea', value: 5.355, unit: 'mmol/L' }, { name: 'BUN', value: 15, unit: 'mg/dL' })).toBe(true);
  });

  it('US-21 AC28 — a website upload, then file_results of the same %, is already recorded: no correction', async () => {
    const uploaded = saveUpload(base(), extracted([['Neutrophils', 55, '%']])).file;
    const { call, cloud } = fileResults(uploaded);
    const read = await call({ sourceFileName: 'Again.pdf', classification: 'lab_report', collectedOn: DAY, values: [
      { metric: 'Neutrophils', printedName: 'Neutrophils', value: 55, unit: '%' },
    ] });
    expect(read.candidates.map((c) => c.slot.state)).toEqual(['held_equal']);
    const before = cloud.files.get(ROADMAP_FILE_NAME)!.json;
    await call({ commit: { receipt: read.receipt, accept: [], replace: [], approval: 'no' } });
    const after = JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(after.labValues.filter((l) => l.correctsId)).toEqual([]);
    expect(labs(after)).toEqual(labs(JSON.parse(before) as RoadmapFile));
  });

  it('US-21 AC28 — import_documents of the same % over an uploaded one offers it as already recorded', () => {
    const uploaded = saveUpload(base(), extracted([['Neutrophils', 55, '%'], ['Neutrophils', 3.1, '×10⁹/L']])).file;
    const file: ExtractedFile = {
      name: 'fbc.pdf', contentHash: 'sha256-fbc', mimeType: 'application/pdf', status: 'extracted',
      result: { classification: 'lab_report', reportDate: DAY, values: [], unrecognized: [], document: null, additionalValues: [
        { name: 'Neutrophils', value: 55, unit: '%', referenceLow: null, referenceHigh: null },
        { name: 'Neutrophils', value: 3.1, unit: '×10⁹/L', referenceLow: null, referenceHigh: null },
      ] },
    };
    const { payload } = prepareImport(uploaded, { route: 'dropbox', files: [file], remaining: [] }, { now: NOW, maxCorrectionAgeDays: 90, payloadId: 'p1', latestDay: TODAY });
    expect(payload.candidates.map((c) => [c.metric, c.slot.state])).toEqual([['neutrophils_pct', 'held_equal'], ['neutrophils', 'held_equal']]);
  });

  it('US-21 AC28 — "+" on a count series whose old rows are in % adds under the share, starting that series', () => {
    const legacy = base();
    legacy.labValues.push({ id: 'old', metricName: 'Neutrophils', value: 54, unit: '%', referenceLow: null, referenceHigh: null,
      recordedAt: '2026-06-01', createdAt: '2026-06-01T08:00:00Z', source: 'lab_import', status: 'active', correctsId: null });
    const added = addLabValue(legacy, { metricName: 'Neutrophils', value: 56, unit: '%', day: TODAY, existingSeries: true }, NOW);
    expect(added.ok && added.row).toMatchObject({ metricName: 'neutrophils_pct', value: 56, unit: '%' });
    // The old row is left as it was: no migration.
    expect((added as { file: RoadmapFile }).file.labValues.find((l) => l.id === 'old')).toMatchObject({ metricName: 'Neutrophils', unit: '%', status: 'active' });
    // A count unit on that page still adds the count; a page with no such series still refuses.
    const count = addLabValue(legacy, { metricName: 'Neutrophils', value: 3.1, unit: '×10⁹/L', day: TODAY, existingSeries: true }, NOW);
    expect(count.ok && count.row).toMatchObject({ metricName: 'neutrophils', value: 3.1 });
    expect(addLabValue(base(), { metricName: 'Neutrophils', value: 56, unit: '%', day: TODAY, existingSeries: true }, NOW))
      .toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('US-21 AC28 — the import review (US-13 AC13) keys a % row as the write does', () => {
  it('US-21 AC28 — Neutrophils in % and in count classify as two new values and both save', () => {
    // Names as printed, not routed by the extraction, so the review's own slot rule is what keeps them apart.
    const file = lab({ additionalValues: [extra({ name: 'Neutrophils', value: 55, unit: '%' }), extra({ name: 'Neutrophils', value: 3.1, unit: '×10⁹/L' })] });
    const { values, rows } = classifyImportValues([file], base(), NOW);
    expect(values.map((v) => [v.ref, v.group, v.writes])).toEqual([['a0', 'sure', true], ['a1', 'sure', true]]);
    const run = bulkAppendValues(base(), rows, NOW);
    expect(run.outcomes).toEqual(['written', 'written']);
    expect(labs(run.file)).toEqual([['Neutrophils', 3.1, '×10⁹/L'], ['neutrophils_pct', 55, '%']]);
    // Saved, the same file reads as already held, both lines.
    expect(classifyImportValues([file], run.file, NOW).values.map((v) => [v.ref, v.writes])).toEqual([['a0', false], ['a1', false]]);
  });
});

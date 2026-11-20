/**
 * Test support for the save parity pin (US-52 AC8c, design 12c; PR 1906 fix round item 6): seeded
 * synthetic uploads, each a record that already holds rows, the files picked (their bytes, so both
 * sides hash them the same), the plan's age and sex, the archive mode, and what the person does in the
 * review (edit, clear, Replace, untick a screening). The same file drives main's old web review and
 * save (run from main's code, outside this branch) and this branch's. It imports only health-core
 * code both trees share unchanged. Imported by tests only. Synthetic values, names and hashes only.
 */
import { recordFromHistory } from '@roadmap/health-core/import-review';
import type { RoadmapFile, FileDocument } from '@roadmap/health-core/roadmap-file';

export const PARITY_NOW = '2026-11-02T00:00:00.000Z';

export interface ParityFile {
  name: string; zip?: string; bytes: string;
  extraction: {
    classification: string; reportDate: string | null; unrecognized: never[]; document: null | { classification: string; title: string; documentDate: string | null; contentMarkdown: string; metadata: Record<string, unknown> };
    values: Array<{ metric: string; valueSI: number; displayValue: number; displayUnit: string; displaySystem: 'si'; confidence: 'high' }>;
    additionalValues: Array<{ name: string; value: number; unit: string }>;
  };
}
export type ParityAction =
  | { kind: 'edit'; from: string; to: string }
  | { kind: 'clear'; from: string }
  | { kind: 'replace'; test: string }
  | { kind: 'untickScreening' };
export interface ParityHistory {
  measurements: Array<{ id: string; metricType: string; value: number; recordedAt: string; createdAt: string }>;
  labValues: Array<{ id: string; metricName: string; value: number; unit: string; referenceLow: null; referenceHigh: null; recordedAt: string; source: string; createdAt: string }>;
  documents: Array<{ id: string; documentType: string; title: string; documentDate: string | null; contentMd: string; metadata: Record<string, unknown>; sourceFileName: string | null; createdAt: string; fileRef: string | null; contentHash: string | null }>;
}
export interface ParityScenario {
  seed: number; files: ParityFile[]; history: ParityHistory; age: number | undefined; sex: 'male' | 'female'; cloud: boolean; actions: ParityAction[];
  /** The record holds bytes of one of the files metadata-only (index), so it is known before it is read. */
  heldFile: number | null;
}

/** The hash both sides compute for a file's bytes: sha256 of its text, as `sha256Blob` names it. */
export async function parityHash(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
  return `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const v = (metric: string, x: number) => ({ metric, valueSI: x, displayValue: x, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const });

/** 32 seeded uploads. Every value is unique within its upload, so the review finds it by its text. */
export async function parityScenarios(): Promise<ParityScenario[]> {
  let r = 7;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: ParityScenario[] = [];
  for (let seed = 0; seed < 32; seed++) {
    const day = rand() < 0.5 ? '2026-10-01' : '2026-09-01';
    const sex: 'male' | 'female' = rand() < 0.5 ? 'male' : 'female';
    const age = [62, 34, undefined][Math.floor(rand() * 3)];
    const cloud = rand() < 0.5;
    // One decimal, never .0: the cell shows the number as written.
    const ldl = Number((2.1 + (seed % 8) / 10).toFixed(1));
    const hdl = Number((1.1 + (seed % 8) / 10).toFixed(1));
    const ferritin = 81 + seed;
    const files: ParityFile[] = [{
      name: 'labs.pdf', ...(rand() < 0.3 ? { zip: `labs-${seed}.zip` } : {}), bytes: `lab bytes ${seed}`,
      extraction: { classification: 'lab_report', reportDate: day, unrecognized: [], document: null, values: [v('ldl', ldl), v('hdl', hdl)], additionalValues: [{ name: 'Ferritin', value: ferritin, unit: 'µg/L' }] },
    }];
    const screeningType = sex === 'female' && rand() < 0.5 ? 'breast' : 'colorectal';
    if (rand() < 0.7) files.push({
      name: `scan-${seed}.pdf`, bytes: `scan bytes ${seed}`,
      extraction: { classification: 'scan_result', reportDate: null, unrecognized: [], values: [], additionalValues: [],
        document: { classification: 'scan_result', title: `Synthetic scan ${seed}`, documentDate: rand() < 0.7 ? '2026-08-15' : null, contentMarkdown: '## Findings', metadata: rand() < 0.7 ? { screeningType } : {} } },
    });
    if (rand() < 0.4) files.push({
      name: `letter-${seed}.pdf`, bytes: `letter bytes ${seed}`,
      extraction: { classification: 'clinic_letter', reportDate: null, unrecognized: [], values: [], additionalValues: [],
        document: { classification: 'clinic_letter', title: `Synthetic letter ${seed}`, documentDate: '2026-07-20', contentMarkdown: 'Plan', metadata: {} } },
    });
    // The record: sometimes an LDL on the report's day that differs (a conflict), sometimes a held metadata-only letter.
    const history: ParityHistory = { measurements: [], labValues: [], documents: [] };
    const conflict = rand() < 0.4;
    if (conflict) history.measurements.push({ id: `held-ldl-${seed}`, metricType: 'ldl', value: ldl + 1, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });
    if (rand() < 0.3) history.labValues.push({ id: `held-b12-${seed}`, metricName: 'Vitamin B12', value: 400 + seed, unit: 'pmol/L', referenceLow: null, referenceHigh: null, recordedAt: '2026-01-01T00:00:00.000Z', source: 'lab_import', createdAt: '2026-01-01T00:00:00.000Z' });
    const letterAt = files.findIndex((f) => f.extraction.classification === 'clinic_letter');
    let heldFile: number | null = null;
    if (letterAt >= 0 && rand() < 0.5) {
      heldFile = letterAt;
      const f = files[letterAt];
      history.documents.push({ id: `held-doc-${seed}`, documentType: 'clinic_letter', title: 'Connector letter', documentDate: '2026-07-20', contentMd: '', metadata: { importedVia: 'connector' },
        sourceFileName: f.name, createdAt: '2026-07-21T00:00:00.000Z', fileRef: null, contentHash: await parityHash(f.bytes) });
    }
    // A held document under a scan's name, other bytes (main skipped such a letter by its name).
    const scanAt = files.findIndex((f) => f.extraction.classification === 'scan_result');
    if (scanAt >= 0 && rand() < 0.35) history.documents.push({ id: `named-${seed}`, documentType: 'scan_result', title: 'Earlier scan', documentDate: '2025-01-10', contentMd: 'Earlier',
      metadata: {}, sourceFileName: files[scanAt].name, createdAt: '2025-01-11T00:00:00.000Z', fileRef: null, contentHash: null });
    const actions: ParityAction[] = [];
    if (rand() < 0.4) actions.push({ kind: 'edit', from: String(hdl), to: String(Number((hdl + 0.05).toFixed(2))) });
    if (rand() < 0.25) actions.push({ kind: 'clear', from: String(ferritin) });
    else if (rand() < 0.3) actions.push({ kind: 'edit', from: String(ferritin), to: String(ferritin + 10) });
    if (conflict && rand() < 0.6) actions.push({ kind: 'replace', test: 'LDL Cholesterol' });
    if (rand() < 0.2) actions.push({ kind: 'untickScreening' });
    out.push({ seed, files, history, age, sex, cloud, actions, heldFile });
  }
  return out;
}

/** The scenario's record as the store opens it: the history's rows and documents. */
export function parityRecord(history: ParityHistory): RoadmapFile {
  const file = recordFromHistory(history.measurements, history.labValues);
  const documents = history.documents.map((d) => ({
    id: d.id, title: d.title, type: d.documentType, date: d.documentDate, fileRef: d.fileRef ?? '', contentHash: d.contentHash ?? '',
    mimeType: '', extractedText: d.contentMd, addedAt: d.createdAt, metadata: d.metadata, sourceFileName: d.sourceFileName,
  }) as FileDocument);
  return { ...file, documents };
}

/**
 * The record's rows as sets: every id named by the row's content (its test, day, value and state; a
 * document's hash, kind and state), every stamp left out, each table sorted; the screenings; and the
 * originals the cloud holds, by path.
 */
export function parityRows(file: RoadmapFile, originals: string[] = []): unknown {
  const name = new Map<string, string>();
  for (const row of [...file.measurements, ...file.labValues] as unknown as Array<Record<string, unknown>>) {
    name.set(row.id as string, [row.metricType ?? row.metricName, row.recordedAt, row.value, row.status].join('|'));
  }
  for (const d of file.documents) name.set(d.id, `${d.contentHash}|${d.type}|${d.deleted ? 'deleted' : 'live'}`);
  const STAMPS = /^(createdAt|addedAt|updatedAt|lamport|deviceId|lastDeviceId)$/;
  const table = (xs: unknown[]) => xs.map((x) => JSON.parse(JSON.stringify(x), (key, value) => {
    if (STAMPS.test(key)) return undefined;
    if ((key === 'id' || key === 'correctsId') && typeof value === 'string') return name.get(value) ?? value;
    if (key === 'rows' && Array.isArray(value)) return value.map((x: string) => name.get(x) ?? x).sort();
    return value;
  })).sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
  const { fieldStamps: _stamps, updatedAt: _at, lamport: _l, ...screenings } = file.screenings as unknown as Record<string, unknown>;
  return { m: table(file.measurements), l: table(file.labValues), d: table(file.documents), s: screenings, o: [...originals].sort() };
}

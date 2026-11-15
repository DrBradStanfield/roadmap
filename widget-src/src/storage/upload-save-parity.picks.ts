/**
 * Test support for the save parity pin (US-52 AC8c, design 12c): seeded synthetic picks of lab
 * reports and letters, with the person's choices and the plan's age and sex, and the record's rows
 * named by content so two saves compare by what they wrote. Imported by tests only.
 */
import { NO_CHOICES, type FileChoices } from '@roadmap/health-core/upload-choices';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import type { ScreeningProfile } from '@roadmap/health-core/upload-review';

export const NOW = '2026-11-02T00:00:00.000Z';
const value = (metric: string, v: number) => ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const });
const labX = (day: string, v: number): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: day, values: [value('ldl', v), value('hdl', v / 2)], additionalValues: [{ name: 'Ferritin', value: 80 + v, unit: 'µg/L' }], unrecognized: [], document: null });
const DATES = ['2026-10-20', '2026-06', null] as const;
const letterX = (i: number, screening: boolean, date: string | null): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: `Synthetic scan ${i}`, documentDate: date, contentMarkdown: '## Findings', metadata: screening ? { screeningType: 'colorectal' } : {} },
});
const read = (id: string, extraction: UnifiedExtractionResult, choices: FileChoices = NO_CHOICES): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices } });

export interface Pick { state: UploadState; profile: ScreeningProfile }

/** 40 seeded picks: 1 to 4 files, lab reports with a cleared or edited value now and then, letters with and without a screening. */
export function seededPicks(): Pick[] {
  let r = 11;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const picks: Pick[] = [];
  for (let seed = 0; seed < 40; seed++) {
    const files = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => {
      const id = `f${seed}-${i}`;
      if (rand() < 0.55) {
        const choices: FileChoices = { ...NO_CHOICES, ticks: rand() < 0.2 ? { v1: false } : {}, edits: rand() < 0.2 ? { v0: 4.4 } : rand() < 0.2 ? { a0: 77 } : {} };
        return read(id, labX(rand() < 0.5 ? '2026-10-01' : '2026-09-01', 2 + Math.floor(rand() * 5) / 10), choices);
      }
      const screening = rand() < 0.6;
      const date = DATES[Math.floor(rand() * DATES.length)];
      const choices: FileChoices = rand() < 0.15 ? { ...NO_CHOICES, screening: true } : rand() < 0.1 ? { ...NO_CHOICES, screening: false } : NO_CHOICES;
      return read(id, letterX(i, screening, date), choices);
    });
    const age = [60, 30, undefined][Math.floor(rand() * 3)];
    picks.push({ state: { phase: 'saving', platform: 'web', run: 1, files, started: NOW, firstRead: NOW, attempt: 1 }, profile: { age, sex: 'male' } });
  }
  return picks;
}

/**
 * The record's rows as sets: every id named by the row's content (its test, day, value and state; a
 * document's hash, kind and state), every stamp left out, each table sorted; and the screenings set.
 */
export function rowsOf(file: RoadmapFile): unknown {
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
  const { fieldStamps: _stamps, updatedAt: _at, lamport: _l, ...screenings } = file.screenings as unknown as Record<string, unknown>;
  return { m: table(file.measurements), l: table(file.labValues), d: table(file.documents), s: screenings };
}

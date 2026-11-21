// @vitest-environment jsdom
/**
 * Mount step 3a, the proof (US-52 AC8c, US-14 AC10, US-13 AC6, AC14, US-16 AC2a): today's web Save (the grid's
 * `saveReview`) and the shared Save's web adapter (`saveUpload`), each over a real RoadmapStore, from the same
 * starting record, the same reads and the same review choices, keep the same value rows, documents, archive rows and
 * the rows they list, originals and screening dates, report the same failed originals, and send the same counts.
 * Every difference is named on its seed with the rule on each side; any other fails. `upload_saved` counts one fewer
 * per lab report's archive row (owner ruling 2026-11-22, recorded in the story at the mount). Synthetic values,
 * plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { UploadReview } from '@roadmap/health-core/upload-review';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { Sentry } from '../lib/sentry';
import { adapterSave, parityBundle, readFor, todaySave, type Seed, type Side } from '../testing/upload-save-parity-kit';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
const tracked = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock('../lib/server-api', async (original) => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: (name: string, meta?: unknown) => { tracked.push([name, meta]); },
}));
vi.mock('../lib/archive-payloads', async (original) => ({
  ...(await original<typeof import('../lib/archive-payloads')>()),
  sha256Blob: vi.fn(async (blob: Blob) => `hash-${await blob.text()}`),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

beforeEach(() => {
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation(async (pages) => readFor(pages));
  Object.assign(window, { HealthUpload: parityBundle() });
});
afterEach(() => { localStorage.clear(); });

const sentryCalls = () => vi.mocked(Sentry.captureException).mock.calls.length;
const COUNTED = ['lab_unit_refused', 'measurement_refused', 'measurement_added', 'upload_review'];
/** Each side as compared: the record, the counts but `upload_saved`, the failed originals reported, whether it saved. */
const view = (side: Side) => ({
  ...side.record, sentry: side.sentry, done: side.done,
  counts: side.events.filter(([n]) => COUNTED.includes(n)).map(([n, m]) => `${n} ${JSON.stringify(m)}`).sort(),
});
const savedCount = (side: Side) => side.events.filter(([n]) => n === 'upload_saved').map(([, m]) => (m as { count: number }).count);
/** What differs, key by key: a list by its items on one side alone. */
function differences(today: Side, adapter: Side) {
  const t = view(today) as Record<string, unknown>;
  const a = view(adapter) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(t).flatMap((k): Array<[string, unknown]> => {
    if (JSON.stringify(t[k]) === JSON.stringify(a[k])) return [];
    if (!Array.isArray(t[k])) return [[k, { today: t[k], adapter: a[k] }]];
    const [tt, aa] = [t[k] as string[], a[k] as string[]];
    return [[k, { onlyToday: tt.filter((x) => !aa.includes(x)), onlyAdapter: aa.filter((x) => !tt.includes(x)) }]];
  }));
}
const doc = (fields: { title: string; type: string; date: string | null; name: string; hash: string | null; stored: boolean; archive?: boolean; rows?: string[] | null }) =>
  JSON.stringify({ title: fields.title, type: fields.type, date: fields.date, name: fields.name, hash: fields.hash, stored: fields.stored, archive: fields.archive ?? false, rows: fields.rows ?? null, deleted: false });

type Case = Seed & {
  /** The differences the owner ruled, each with the rule on both sides. */
  differs?: ReturnType<typeof differences>;
  /** What the seed must have done on today's side, so a seed that tests nothing fails. */
  holds: (today: Side) => void;
  /** `upload_saved` on each side, where one side saves and the other does not. */
  saved?: { today: number[]; adapter: number[] };
};
const pdf = (read: string, name = `${read}.pdf`) => ({ name, read });
const heldLdl = (review: UploadReview) => review.held.get('0:v0')!;
const nothingTicked = (cloud: boolean): Pick<Case, 'cloud' | 'files' | 'grid' | 'choices'> => ({
  cloud, files: [pdf('labB')],
  grid: () => {
    fireEvent.click(screen.getByRole('button', { name: /^Show all \d+$/ }));
    for (const v of ['2.6', '70']) fireEvent.change(screen.getByDisplayValue(v), { target: { value: '' } });
    return true;
  },
  choices: () => [{ file: 0, change: { tick: 'v0', on: false } }, { file: 0, change: { tick: 'a0', on: false } }],
});

const CASES: Case[] = [
  { name: 'labs only', cloud: true, files: [pdf('labA'), pdf('labB')], holds: (t) => expect(t.record.documents.filter((d) => d.includes('"archive":true,"rows":["'))).toHaveLength(2) },
  { name: 'letters only', cloud: true, files: [pdf('letterA')], holds: (t) => expect(t.record.documents).toEqual([doc({ title: 'Synthetic letter A', type: 'clinic_letter', date: '2025-08-01', name: 'letterA.pdf', hash: 'hash-read:letterA', stored: true })]) },
  { name: 'mixed', cloud: true, files: [pdf('labA'), pdf('letterA')], holds: (t) => expect(t.record.documents).toHaveLength(2) },
  {
    name: 'a ZIP', cloud: true, files: [{ name: 'bundle.zip', members: [{ name: 'm0', read: 'labB' }, { name: 'm1', read: 'letterA' }] }],
    holds: (t) => expect(t.record.documents.every((d) => d.includes('"name":"bundle.zip/') && d.includes('"stored":true'))).toBe(true),
  },
  {
    name: 'duplicates of saved values', cloud: true, files: [pdf('labA')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); store.addMeasurement('hdl', 1.4, '2025-09-02'); },
    holds: (t) => expect(t.record.labValues.filter((r) => r.startsWith('ldl|'))).toEqual(['ldl|2025-09-02|2.8|mmol/L|active|manual']),
  },
  {
    name: 'a Replace', cloud: true, files: [pdf('labConflict')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); },
    grid: () => { fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved LDL/ })); return false; },
    choices: (review) => [{ file: 0, change: { replace: 'v0', correctsId: heldLdl(review) } }],
    holds: (t) => expect(t.record.labValues).toContain('ldl|2025-09-02|3.5|mmol/L|active corrects ldl|2025-09-02|2.8|mmol/L|entered-in-error|lab_import'),
  },
  {
    name: 'an undated report with a picked day', cloud: true, files: [pdf('labUndated')],
    grid: () => { fireEvent.change(screen.getByLabelText('Choose column date'), { target: { value: '2025-07-01' } }); return false; },
    choices: () => [{ file: 0, change: { testDay: '2025-07-01' } }],
    holds: (t) => expect(t.record.labValues).toEqual(['Ferritin|2025-07-01|60|µg/L|active|lab_import', 'ldl|2025-07-01|3.1|mmol/L|active|lab_import']),
  },
  { name: 'previous-results columns', cloud: true, files: [pdf('labPrev')], holds: (t) => expect(t.record.labValues).toContain('ldl|2025-03-01|3.3|mmol/L|active|lab_import') },
  { name: 'refused values', cloud: true, files: [pdf('labRefused')], holds: (t) => expect(view(t).counts).toContain('lab_unit_refused {"key":"ferritin","unit":"mmol/L"}') },
  {
    name: 'a core value the write refuses, cleared', cloud: true, files: [pdf('labOutOfRange')],
    grid: () => { fireEvent.change(screen.getByDisplayValue('95.0'), { target: { value: '' } }); return false; },
    choices: () => [{ file: 0, change: { tick: 'v0', on: false } }],
    holds: (t) => expect(t.record.labValues).toEqual(['hdl|2025-09-02|1.4|mmol/L|active|lab_import']),
  },
  { name: 'no cloud', cloud: false, files: [pdf('labA'), pdf('letterA')], holds: (t) => expect(t.record.documents.every((d) => d.includes('"stored":false') && d.includes('"hash":"hash-read:'))).toBe(true) },
  {
    name: 'a failing original write', cloud: true, failWrite: true, files: [pdf('labA'), pdf('letterA')],
    holds: (t) => { expect(t.sentry).toBe(2); expect(t.record.documents.every((d) => d.includes('"stored":false'))).toBe(true); },
  },
  {
    name: 'two letters of one screening type', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterC1'), pdf('letterC2')],
    holds: (t) => expect(t.record.screenings).toEqual({ colorectalLastDate: '2025-06-12' }),
  },
  {
    name: 'an erase between plan and commit', cloud: true, eraseMidway: true, files: [pdf('labA'), pdf('letterA')],
    holds: (t) => { expect(t.done).toBe(false); expect([...t.record.labValues, ...t.record.measurements, ...t.record.documents]).toEqual([]); },
    // Today writes the values first, so their count goes out though the erase removed them (lib/upload-save.ts:54,
    // roadmap-data.ts `countMeasuresAdded`); the adapter counts only rows its commit landed (upload-save-store.ts).
    differs: { counts: { onlyToday: ['measurement_added {"measure":"blood_pressure"}'], onlyAdapter: [] } },
  },
  {
    name: 'a letter of a type outside the screening table', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterOther'), pdf('letterC1')],
    holds: (t) => expect(t.record.screenings).toEqual({ colorectalLastDate: '2025-05-10' }),
  },
  // The owner's rulings, each shown once.
  {
    name: 'ruled: a read letter starts from the reader, never from a held row (US-13 AC6, US-14 AC4)', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await store.bulkSaveDocuments([{ documentType: 'clinic_letter', title: 'Synthetic connector title', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-read:letterA' }]); },
    holds: (t) => expect(t.record.documents.filter((d) => d.includes('"deleted":true'))).toHaveLength(1),
    // Today: the card starts from the newest held row (useReviewDocuments.ts:105-120 `heldRows`). Shared: from the
    // reader's answer and the person's fixes (upload-plan.ts:76-88, `letterStart`). Both tombstone the held row.
    differs: { documents: {
      onlyToday: [doc({ title: 'Synthetic connector title', type: 'clinic_letter', date: '2025-01-01', name: 'letterA.pdf', hash: 'hash-read:letterA', stored: true })],
      onlyAdapter: [doc({ title: 'Synthetic letter A', type: 'clinic_letter', date: '2025-08-01', name: 'letterA.pdf', hash: 'hash-read:letterA', stored: true })],
    } },
  },
  {
    name: 'ruled: every letter saves, none unticked (US-13 AC14)', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await store.bulkSaveDocuments([{ documentType: 'clinic_letter', title: 'Synthetic earlier letter', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-other-bytes' }]); },
    holds: (t) => expect(t.done).toBe(false),
    // Today: a letter named like one the record holds starts unticked, so Save offers nothing (useReviewDocuments.ts:
    // 81-89 `isDocDuplicate`). Shared: every read letter saves (upload-plan.ts:73-89); its new bytes are a new row.
    differs: {
      documents: { onlyToday: [], onlyAdapter: [doc({ title: 'Synthetic letter A', type: 'clinic_letter', date: '2025-08-01', name: 'letterA.pdf', hash: 'hash-read:letterA', stored: true })] },
      done: { today: false, adapter: true },
      counts: { onlyToday: [], onlyAdapter: ['upload_review {"saved":1}'] },
    },
    saved: { today: [], adapter: [1] },
  },
  {
    name: 'ruled: a report with nothing ticked keeps its original, with a cloud (US-14 AC11)', ...nothingTicked(true),
    holds: (t) => expect(t.record.documents).toEqual([doc({ title: 'Blood test results', type: 'pathology_report', date: '2025-10-02', name: 'labB.pdf', hash: 'hash-read:labB', stored: true, archive: true })]),
  },
  {
    name: 'ruled: a report with nothing ticked writes no row, with no cloud (US-14 AC11)', ...nothingTicked(false),
    holds: (t) => expect(t.record.labValues).toEqual([]),
  },
];

describe('mount 3a: the shared Save keeps what today\'s Save keeps', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const today = await todaySave(c, tracked, sentryCalls);
      c.holds(today);
      const adapter = await adapterSave(c, parityBundle(), tracked, sentryCalls, today.showAll ?? false);
      expect(differences(today, adapter)).toEqual(c.differs ?? {});
      // `upload_saved`: today counts each lab report's archive row as a document; the shared count does not.
      const archiveRows = today.record.documents.filter((d) => d.includes('"archive":true')).length;
      if (c.saved) expect({ today: savedCount(today), adapter: savedCount(adapter) }).toEqual(c.saved);
      else expect(savedCount(adapter)).toEqual(savedCount(today).map((n) => n - archiveRows));
    });
  }
});

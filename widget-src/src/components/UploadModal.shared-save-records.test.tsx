// @vitest-environment jsdom
/**
 * The web's one upload Save, the records it keeps (US-52 AC8c, US-14 AC10, AC11, US-13 AC6, AC14, US-16 AC2a, US-12
 * AC6a): the shared Save's web adapter (`sharedSave` → `saveUpload`) over a real RoadmapStore, from a starting record,
 * the reads and the person's choices. Mount 3a proved it against the grid's Save, seed by seed (PR 1959, its
 * differences ruled); the grid went with mount 3b, so each seed now pins what the shared Save keeps: rows, documents,
 * originals, screening dates, the failed originals reported, whether it finished, its counts and its usage events
 * (`lab_unit_refused`, `measurement_refused`, `measurement_added`). Synthetic values, plain fake hashes.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadReview } from '@roadmap/health-core/upload-review';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { addMeasurement } from '../lib/roadmap-data';
import { Sentry } from '../lib/sentry';
import { RoadmapStore } from '../storage/roadmap-store';
import { adapterSave, eraseHere, parityBundle, readFor, type Probes, type Seed, type Side } from '../testing/upload-save-parity-kit';
import { seedDocuments } from '../testing/seed-record';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
const probes = vi.hoisted(() => ({ tracked: [], failNext: { shared: false } }) as unknown as Omit<Probes, 'sentryCalls'>);
vi.mock('../lib/server-api', async (original) => ({
  ...(await original<typeof import('../lib/server-api')>()),
  // The throttle key too: an out-of-range core value keys the tab's throttle by its metric (roadmap-data.ts).
  trackProductEvent: (name: string, meta?: unknown, key?: string) => { probes.tracked.push(key === undefined ? [name, meta] : [name, meta, key] as unknown as [string, unknown]); },
}));
vi.mock('../lib/archive-payloads', async (original) => ({
  ...(await original<typeof import('../lib/archive-payloads')>()),
  sha256Blob: vi.fn(async (blob: Blob) => `hash-${await blob.text()}`),
}));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

/** US-12 AC20: a report that printed Lp(a) as a limit, "< 10" nmol/L. */
const LIMIT_READS: Record<string, Awaited<ReturnType<typeof labImport>>> = {
  lpaLimit: { result: { classification: 'lab_report', document: null, reportDate: '2025-09-02', additionalValues: [],
    values: [{ metric: 'lpa', valueSI: 10, displayValue: 10, displayUnit: 'nmol/L', displaySystem: 'si', confidence: 'high', comparator: '<' }] } } as unknown as Awaited<ReturnType<typeof labImport>>,
};
const P: Probes =Object.assign(probes, { sentryCalls: () => vi.mocked(Sentry.captureException).mock.calls.length });
beforeEach(() => {
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockClear().mockImplementation(async (pages) => LIMIT_READS[(pages[0] as { content: string }).content.slice('read:'.length)] ?? readFor(pages));
  Object.assign(window, { HealthUpload: parityBundle() });
  // A failed first Save (`failFirst`): the shared Save rejects once.
  const shared = RoadmapStore.prototype.saveUpload;
  vi.spyOn(RoadmapStore.prototype, 'saveUpload').mockImplementation(function (this: RoadmapStore, ...a) {
    if (P.failNext.shared) { P.failNext.shared = false; return Promise.reject(new Error('Synthetic test: the store threw')); }
    return shared.apply(this, a);
  });
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

const rows = (xs: string[]) => xs.map((x) => JSON.parse(x) as Record<string, unknown>);
const EVENTS = ['lab_unit_refused', 'measurement_refused', 'measurement_added'];
const events = (side: Side) => side.events.filter(([n]) => EVENTS.includes(n)).map((e) => `${e[0]} ${JSON.stringify(e[1])}${e.length > 2 ? ` key ${(e as unknown[])[2]}` : ''}`).sort();
const documents = (side: Side) => rows(side.record.documents);
const labs = (side: Side) => rows(side.record.labValues).map((r) => `${r.metricName} ${r.recordedAt} ${r.value} ${r.unit} ${r.status}${r.correctsId ? ` corrects ${r.correctsId}` : ''}`);
/** Each Lp(a) row: value, comparator, the row it corrects (named by content), status; in record order of status. */
const lpa = (side: Side) => rows(side.record.labValues).filter((r) => r.metricName === 'lpa')
  .map((r) => ({ value: r.value, comparator: r.comparator, correctsId: r.correctsId, status: r.status }))
  .sort((a, b) => String(b.status).localeCompare(String(a.status)));
const archives = (side: Side) => documents(side).filter((d) => !d.deleted && (d.metadata as { labArchive?: boolean } | undefined)?.labArchive);

type Case = Seed & { holds: (side: Side) => void };
const pdf = (read: string, name = `${read}.pdf`) => ({ name, read });
const letterRow = (title: string, date: string) => JSON.stringify({ id: 'another id', title, type: 'clinic_letter', date, fileRef: `Clinic letters/${date} ${title}.pdf`, contentHash: 'hash-read:letterA', mimeType: 'application/pdf', extractedText: 'Synthetic letter text', metadata: {}, sourceFileName: 'letterA.pdf' });
const labAArchive = (listed: string[]) => JSON.stringify({ id: 'another id', title: 'Blood test results', type: 'pathology_report', date: '2025-09-02', fileRef: 'Lab results/2025-09-02 Blood test results.pdf', contentHash: 'hash-read:labA', mimeType: 'application/pdf', extractedText: '', metadata: { labArchive: true, rows: listed }, sourceFileName: 'labA.pdf' });
const heldLdl = (review: UploadReview) => review.held.get('0:v0')!;
const nothingTicked = (cloud: boolean): Pick<Case, 'cloud' | 'files' | 'choices'> => ({
  cloud, files: [pdf('labB')], choices: () => [{ file: 0, change: { tick: 'v0', on: false } }, { file: 0, change: { tick: 'a0', on: false } }],
});

const CASES: Case[] = [
  { name: 'labs only', cloud: true, files: [pdf('labA'), pdf('labB')], holds: (s) => expect(archives(s)).toHaveLength(2) },
  { name: 'letters only', cloud: true, files: [pdf('letterA')], holds: (s) => expect(documents(s).map((d) => d.title)).toEqual(['Synthetic letter A']) },
  { name: 'mixed', cloud: true, files: [pdf('labA'), pdf('letterA')], holds: (s) => expect(s.record.originals).toHaveLength(2) },
  {
    name: 'a ZIP', cloud: true, files: [{ name: 'bundle.zip', members: [{ name: 'm0', read: 'labB' }, { name: 'm1', read: 'letterA' }] }],
    holds: (s) => { expect(documents(s)).toHaveLength(2); expect(documents(s).every((d) => String(d.sourceFileName).startsWith('bundle.zip/') && d.fileRef)).toBe(true); },
  },
  {
    name: 'duplicates of saved values', cloud: true, files: [pdf('labA')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); store.addMeasurement('hdl', 1.4, '2025-09-02'); },
    holds: (s) => expect(labs(s).filter((r) => r.startsWith('ldl '))).toHaveLength(1),
  },
  {
    name: 'a Replace', cloud: true, files: [pdf('labConflict')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); },
    choices: (review) => [{ file: 0, change: { replace: 'v0', correctsId: heldLdl(review) } }],
    holds: (s) => expect(labs(s).some((r) => r.startsWith('ldl') && r.includes(' 3.5 ') && r.includes('corrects ldl'))).toBe(true),
  },
  { name: 'an edited value', cloud: true, files: [pdf('labA')], choices: () => [{ file: 0, change: { edit: 'v0', value: 3 } }], holds: (s) => expect(labs(s).some((r) => r.startsWith('ldl') && r.includes(' 3 '))).toBe(true) },
  { name: 'an undated report with a picked day', cloud: true, files: [pdf('labUndated')], choices: () => [{ file: 0, change: { testDay: '2025-07-01' } }], holds: (s) => { expect(labs(s).length).toBeGreaterThan(0); expect(labs(s).every((r) => r.includes('2025-07-01'))).toBe(true); } },
  { name: 'previous-results columns', cloud: true, files: [pdf('labPrev')], holds: (s) => expect(labs(s).some((r) => r.includes('2025-03-01'))).toBe(true) },
  { name: 'a picked day on a dated previous-results column', cloud: true, files: [pdf('labPrev')], choices: () => [{ file: 0, change: { columnDay: '2025-03-01', day: '2025-03-05' } }], holds: (s) => expect(labs(s).some((r) => r.includes('2025-03-05'))).toBe(true) },
  { name: 'a picked day on an undated previous-results column', cloud: true, files: [pdf('labPrevUndated')], choices: () => [{ file: 0, change: { previousDay: '2025-04-04' } }], holds: (s) => expect(labs(s).some((r) => r.includes('2025-04-04'))).toBe(true) },
  { name: 'refused values', cloud: true, files: [pdf('labRefused')], holds: (s) => expect(events(s)).toContain('lab_unit_refused {"key":"ferritin","unit":"mmol/L"}') },
  { name: 'a core value the write refuses, cleared', cloud: true, files: [pdf('labOutOfRange')], choices: () => [{ file: 0, change: { tick: 'v0', on: false } }], holds: (s) => expect(labs(s)).toHaveLength(1) },
  { name: 'no cloud', cloud: false, files: [pdf('labA'), pdf('letterA')], holds: (s) => { expect(documents(s)).toHaveLength(2); expect(documents(s).every((d) => !d.fileRef && d.contentHash)).toBe(true); } },
  { name: 'a failing original write', cloud: true, failWrite: true, files: [pdf('labA'), pdf('letterA')], holds: (s) => { expect(s.sentry).toBe(2); expect(s.record.originals).toEqual([]); expect(s.counts?.documents).toBe(1); } },
  { name: 'two letters of one screening type', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterC1'), pdf('letterC2')], holds: (s) => expect(s.record.screenings).toEqual({ colorectalLastDate: '2025-06-12' }) },
  { name: 'a letter of a type outside the screening table', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterOther'), pdf('letterC1')], holds: (s) => expect(s.record.screenings).toEqual({ colorectalLastDate: '2025-05-10' }) },
  {
    name: 'another writer\'s edit between plan and commit (another test)', cloud: true, files: [pdf('labA'), pdf('letterA')],
    midway: async () => { await addMeasurement('weight', 80, '2025-09-02'); },
    holds: (s) => expect(rows(s.record.measurements).some((m) => m.metricType === 'weight')).toBe(true),
  },
  {
    // U2, ruled 2026-11-22 (US-12 AC6a): the shared Save commits last (health-core upload-save.ts): the other writer's
    // HDL stays, the upload's is skipped and counted, and the report's archive row lists only the rows its commit wrote.
    name: 'another writer\'s edit between plan and commit (the same slot)', cloud: true, files: [pdf('labA'), pdf('letterA')],
    midway: async () => { await addMeasurement('hdl', 1.6, '2025-09-02'); },
    holds: (s) => {
      expect(labs(s).filter((r) => r.startsWith('hdl'))).toEqual(['hdl 2025-09-02 1.6 mmol/L active']);
      expect(s.record.documents).toContain(labAArchive(['Ferritin|2025-09-02|90|µg/L|active', 'ldl|2025-09-02|2.8|mmol/L|active']));
      expect(s.counts).toEqual({ values: 4, documents: 1, skipped: 1, refused: 0 });
    },
  },
  {
    // The one refusal a commit can produce: another writer's diastolic lands after the review, so the upload's systolic
    // reads the wrong way up beside it.
    name: 'a blood-pressure half from another writer, after the review: the pair reads the wrong way up', cloud: true, files: [pdf('labBP')],
    beforeValues: async () => { await addMeasurement('diastolic_bp', 130, '2025-09-02'); },
    holds: (s) => expect(events(s).filter((e) => e.startsWith('measurement_refused'))).toEqual(['measurement_refused {"refusal":"out-of-range"} key diastolic_bp', 'measurement_refused {"refusal":"out-of-range"} key systolic_bp']),
  },
  {
    // U3, ruled 2026-11-22: one commit or none, so the retry writes everything once and skips nothing.
    name: 'a retry after a failed Save', cloud: true, failFirst: true, files: [pdf('labA'), pdf('letterA')],
    holds: (s) => { expect(s.done).toBe(true); expect(documents(s).filter((d) => d.fileRef)).toHaveLength(2); expect(s.counts).toEqual({ values: 5, documents: 1, skipped: 0, refused: 0 }); },
  },
  {
    // Ruled 2026-11-22: nothing lands and nothing is counted after an erase the page has shown (US-16 AC2a).
    name: 'an erase between plan and commit', cloud: true, midway: eraseHere, files: [pdf('labA'), pdf('letterA')],
    holds: (s) => { expect(s.done).toBe(false); expect(s.counts).toBeNull(); expect([...s.record.labValues, ...s.record.measurements, ...s.record.documents]).toEqual([]); expect(events(s)).toEqual([]); },
  },
  {
    // Owner ruling 7 (mount 3b, US-12 AC27): a file the record holds without its original is never read again, with a
    // cloud too: the shared Save files its original unread under the held row's details and tombstones that row
    // (upload-plan.ts `archiveOnly`). Before, the web read it again and saved the reader's title and date.
    name: 'ruled: a file the record holds without its original is filed unread, under its held details', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await seedDocuments(store, [{ documentType: 'clinic_letter', title: 'Synthetic connector title', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-read:letterA' }]); },
    holds: (s) => {
      expect(labImport).not.toHaveBeenCalled();
      expect(documents(s).filter((d) => d.deleted).map((d) => d.fileRef)).toEqual(['']);
      expect(documents(s).filter((d) => !d.deleted).map((d) => [d.title, d.date, d.fileRef])).toEqual([['Synthetic connector title', '2025-01-01', 'Clinic letters/2025-01-01 Synthetic connector title.pdf']]);
      expect(s.record.originals).toEqual(['Clinic letters/2025-01-01 Synthetic connector title.pdf: application/pdf read:letterA']);
    },
  },
  {
    // Ruled: every read letter saves, none unticked (US-13 AC14); its new bytes are a new row.
    name: 'ruled: every letter saves, none unticked', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await seedDocuments(store, [{ documentType: 'clinic_letter', title: 'Synthetic earlier letter', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-other-bytes' }]); },
    holds: (s) => { expect(s.done).toBe(true); expect(s.record.documents).toContain(letterRow('Synthetic letter A', '2025-08-01')); expect(s.counts).toEqual({ values: 0, documents: 1, skipped: 0, refused: 0 }); },
  },
  // US-12 AC20 (moved from UploadModal.lab-limits.test.tsx): a printed limit saves as a limit; an edit is exact.
  {
    name: 'US-12 AC20: an uploaded limit, untouched, saves as the limit it printed (control)', cloud: true, files: [pdf('lpaLimit')],
    holds: (s) => expect(lpa(s)).toEqual([{ value: 10, comparator: '<', correctsId: null, status: 'active' }]),
  },
  {
    name: 'US-12 AC20: an uploaded limit edited to 12 saves exact, with no comparator', cloud: true, files: [pdf('lpaLimit')],
    choices: () => [{ file: 0, change: { edit: 'v0', value: 12 } }],
    holds: (s) => expect(lpa(s)).toEqual([{ value: 12, comparator: undefined, correctsId: null, status: 'active' }]),
  },
  {
    name: 'US-12 AC20: a held exact 10 and an uploaded "< 10" offer Replace, and Replace writes the limit as its correction', cloud: true, files: [pdf('lpaLimit')],
    record: (store) => { store.addMeasurement('lpa', 10, '2025-09-02'); },
    choices: (review) => {
      // The held exact value and the printed limit are a conflict: the review holds the row Replace corrects.
      expect(review.held.get('0:v0')).toEqual(expect.any(String));
      return [{ file: 0, change: { replace: 'v0', correctsId: review.held.get('0:v0')! } }];
    },
    holds: (s) => expect(lpa(s)).toEqual([
      { value: 10, comparator: undefined, correctsId: null, status: 'entered-in-error' },
      { value: 10, comparator: '<', correctsId: 'lpa|2025-09-02|10|nmol/L|entered-in-error', status: 'active' },
    ]),
  },
  { name: 'ruled: a report with nothing ticked keeps its original, with a cloud (US-14 AC11)', ...nothingTicked(true), holds: (s) => expect(s.record.originals).toHaveLength(1) },
  { name: 'ruled: a report with nothing ticked writes no row, with no cloud (US-14 AC11)', ...nothingTicked(false), holds: (s) => expect(s.record.labValues).toEqual([]) },
];

describe('the shared Save keeps what each seed should keep', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const side = await adapterSave(c, parityBundle(), P);
      // U1, ruled 2026-11-22: a value's day is written as a bare day (health-core import-review.ts `recordedAt: day`).
      if (side.record.dayForms.length) expect(side.record.dayForms).toEqual(['day']);
      c.holds(side);
    });
  }
});

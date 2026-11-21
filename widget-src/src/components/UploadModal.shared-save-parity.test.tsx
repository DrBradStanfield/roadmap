// @vitest-environment jsdom
/**
 * Mount step 3a, the proof (US-52 AC8c, US-14 AC10, US-13 AC6, AC14, US-16 AC2a): today's web Save (the grid's
 * `saveReview`) and the shared Save's web adapter (`sharedSave` → `saveUpload`), each over a real RoadmapStore, from
 * the same starting record, the same reads and the same review choices. Compared: every field of every value row and
 * document (ids named by content, stamps left out), each stored original's bytes and type, the screening dates, the
 * failed originals reported, whether the Save finished, the counts each Save says it made (values, documents, skipped
 * values, refused lines) and the usage events both send (`lab_unit_refused`, `measurement_refused`,
 * `measurement_added`). Every difference is named on its seed with the rule on each side; any other fails.
 * Not compared, for the mount (3b): `upload_review` and `upload_saved`, which the flow sends and which do not run
 * unmounted. Synthetic values, plain fake hashes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { UploadReview } from '@roadmap/health-core/upload-review';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { addMeasurement } from '../lib/roadmap-data';
import { Sentry } from '../lib/sentry';
import { RoadmapStore } from '../storage/roadmap-store';
import { adapterSave, eraseHere, parityBundle, readFor, todaySave, type Probes, type Seed, type Side } from '../testing/upload-save-parity-kit';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
const probes = vi.hoisted(() => ({ tracked: [], todayTotals: [], failNext: { today: false, shared: false } }) as unknown as Omit<Probes, 'sentryCalls'>);
vi.mock('../lib/server-api', async (original) => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: (name: string, meta?: unknown) => { probes.tracked.push([name, meta]); },
}));
vi.mock('../lib/archive-payloads', async (original) => ({
  ...(await original<typeof import('../lib/archive-payloads')>()),
  sha256Blob: vi.fn(async (blob: Blob) => `hash-${await blob.text()}`),
}));
// Today's session totals, as the flow adds each attempt (useUploadFlow.ts).
vi.mock('../lib/upload-save-outcome', async (original) => {
  const real = await original<typeof import('../lib/upload-save-outcome')>();
  return { ...real, withAttempt: (...a: Parameters<typeof real.withAttempt>) => { const total = real.withAttempt(...a); probes.todayTotals.push(total); return total; } };
});
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));

const P: Probes = Object.assign(probes, { sentryCalls: () => vi.mocked(Sentry.captureException).mock.calls.length });
beforeEach(() => {
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockImplementation(async (pages) => readFor(pages));
  Object.assign(window, { HealthUpload: parityBundle() });
  // A failed first Save: today's document write rejects once, or the shared Save does (`failFirst`).
  const bulk = RoadmapStore.prototype.bulkSaveDocuments;
  vi.spyOn(RoadmapStore.prototype, 'bulkSaveDocuments').mockImplementation(function (this: RoadmapStore, ...a) {
    if (P.failNext.today) { P.failNext.today = false; return Promise.reject(new Error('Synthetic test: the store threw')); }
    return bulk.apply(this, a);
  });
  const shared = RoadmapStore.prototype.saveUpload;
  vi.spyOn(RoadmapStore.prototype, 'saveUpload').mockImplementation(function (this: RoadmapStore, ...a) {
    if (P.failNext.shared) { P.failNext.shared = false; return Promise.reject(new Error('Synthetic test: the store threw')); }
    return shared.apply(this, a);
  });
});
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

const rows = (xs: string[]) => xs.map((x) => JSON.parse(x) as Record<string, unknown>);
const EVENTS = ['lab_unit_refused', 'measurement_refused', 'measurement_added'];
/** Each side as compared. Today's document count takes out each lab report's archive row, which the shared count leaves
 *  out (owner ruling 2026-11-22: `upload_saved`, built from these counts, counts one fewer per report). */
const archiveRows = (side: Side) => rows(side.record.documents).filter((d) => !d.deleted && (d.metadata as { labArchive?: boolean } | undefined)?.labArchive).length;
const view = (side: Side, today = false) => ({
  ...side.record, sentry: side.sentry, done: side.done,
  saveCounts: side.counts && today ? { ...side.counts, documents: side.counts.documents - archiveRows(side) } : side.counts,
  events: side.events.filter(([n]) => EVENTS.includes(n)).map(([n, m]) => `${n} ${JSON.stringify(m)}`).sort(),
});
/** What differs, key by key: a list by its items on one side alone. */
function differences(today: Side, adapter: Side) {
  const t = view(today, true) as Record<string, unknown>;
  const a = view(adapter) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(t).flatMap((k): Array<[string, unknown]> => {
    if (JSON.stringify(t[k]) === JSON.stringify(a[k])) return [];
    if (!Array.isArray(t[k])) return [[k, { today: t[k], adapter: a[k] }]];
    const [tt, aa] = [t[k] as string[], a[k] as string[]];
    return [[k, { onlyToday: tt.filter((x) => !aa.includes(x)), onlyAdapter: aa.filter((x) => !tt.includes(x)) }]];
  }));
}
const documents = (side: Side) => rows(side.record.documents);
const labs = (side: Side) => rows(side.record.labValues).map((r) => `${r.metricName} ${r.recordedAt} ${r.value} ${r.unit} ${r.status}${r.correctsId ? ` corrects ${r.correctsId}` : ''}`);

type Case = Seed & {
  /** The differences the owner ruled, or this round found and named, each with the rule on both sides. */
  differs?: Record<string, unknown>;
  /** What the seed must have done on today's side, so a seed that tests nothing fails. */
  holds: (today: Side) => void;
};
const pdf = (read: string, name = `${read}.pdf`) => ({ name, read });
/** A read letter's row and its stored original, as the snapshot names them. */
const letterRow = (title: string, date: string) => JSON.stringify({ id: 'another id', title, type: 'clinic_letter', date, fileRef: `Clinic letters/${date} ${title}.pdf`, contentHash: 'hash-read:letterA', mimeType: 'application/pdf', extractedText: 'Synthetic letter text', metadata: {}, sourceFileName: 'letterA.pdf' });
const letterOriginal = (title: string, date: string) => `Clinic letters/${date} ${title}.pdf: application/pdf read:letterA`;
const heldLdl = (review: UploadReview) => review.held.get('0:v0')!;
const showAll = () => fireEvent.click(screen.getByRole('button', { name: /^Show all \d+$/ }));
const nothingTicked = (cloud: boolean): Pick<Case, 'cloud' | 'files' | 'grid' | 'choices'> => ({
  cloud, files: [pdf('labB')],
  grid: () => { showAll(); for (const v of ['2.6', '70']) fireEvent.change(screen.getByDisplayValue(v), { target: { value: '' } }); },
  choices: () => [{ file: 0, change: { tick: 'v0', on: false } }, { file: 0, change: { tick: 'a0', on: false } }],
});

const CASES: Case[] = [
  { name: 'labs only', cloud: true, files: [pdf('labA'), pdf('labB')], holds: (t) => expect(documents(t).filter((d) => (d.metadata as { labArchive?: boolean }).labArchive)).toHaveLength(2) },
  { name: 'letters only', cloud: true, files: [pdf('letterA')], holds: (t) => expect(documents(t).map((d) => d.title)).toEqual(['Synthetic letter A']) },
  { name: 'mixed', cloud: true, files: [pdf('labA'), pdf('letterA')], holds: (t) => expect(t.record.originals).toHaveLength(2) },
  {
    name: 'a ZIP', cloud: true, files: [{ name: 'bundle.zip', members: [{ name: 'm0', read: 'labB' }, { name: 'm1', read: 'letterA' }] }],
    holds: (t) => expect(documents(t).every((d) => String(d.sourceFileName).startsWith('bundle.zip/') && d.fileRef)).toBe(true),
  },
  {
    name: 'duplicates of saved values', cloud: true, files: [pdf('labA')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); store.addMeasurement('hdl', 1.4, '2025-09-02'); },
    holds: (t) => expect(labs(t).filter((r) => r.startsWith('ldl '))).toHaveLength(1),
  },
  {
    name: 'a Replace', cloud: true, files: [pdf('labConflict')],
    record: (store) => { store.addMeasurement('ldl', 2.8, '2025-09-02'); },
    grid: () => { fireEvent.click(screen.getByRole('checkbox', { name: /Replace the saved LDL/ })); },
    choices: (review) => [{ file: 0, change: { replace: 'v0', correctsId: heldLdl(review) } }],
    holds: (t) => expect(labs(t).some((r) => r.startsWith('ldl') && r.includes(' 3.5 ') && r.includes('corrects ldl'))).toBe(true),
  },
  {
    name: 'an edited value', cloud: true, files: [pdf('labA')],
    grid: () => { showAll(); const cell = screen.getByDisplayValue('2.8'); fireEvent.change(cell, { target: { value: '3.0' } }); fireEvent.blur(cell); },
    choices: () => [{ file: 0, change: { edit: 'v0', value: 3 } }],
    holds: (t) => expect(labs(t).some((r) => r.startsWith('ldl') && r.includes(' 3 '))).toBe(true),
  },
  {
    name: 'an undated report with a picked day', cloud: true, files: [pdf('labUndated')],
    grid: () => { fireEvent.change(screen.getByLabelText('Choose column date'), { target: { value: '2025-07-01' } }); },
    choices: () => [{ file: 0, change: { testDay: '2025-07-01' } }],
    holds: (t) => expect(labs(t).every((r) => r.includes('2025-07-01'))).toBe(true),
  },
  { name: 'previous-results columns', cloud: true, files: [pdf('labPrev')], holds: (t) => expect(labs(t).some((r) => r.includes('2025-03-01'))).toBe(true) },
  {
    name: 'a picked day on a dated previous-results column', cloud: true, files: [pdf('labPrev')],
    grid: () => { showAll(); const picker = screen.getAllByLabelText('Choose column date').find((p) => (p as HTMLInputElement).value === '2025-03-01')!; fireEvent.change(picker, { target: { value: '2025-03-05' } }); },
    choices: () => [{ file: 0, change: { columnDay: '2025-03-01', day: '2025-03-05' } }],
    holds: (t) => expect(labs(t).some((r) => r.includes('2025-03-05'))).toBe(true),
  },
  {
    name: 'a picked day on an undated previous-results column', cloud: true, files: [pdf('labPrevUndated')],
    grid: () => { fireEvent.change(screen.getByLabelText('Choose the date of the previous results'), { target: { value: '2025-04-04' } }); },
    choices: () => [{ file: 0, change: { previousDay: '2025-04-04' } }],
    holds: (t) => expect(labs(t).some((r) => r.includes('2025-04-04'))).toBe(true),
  },
  { name: 'refused values', cloud: true, files: [pdf('labRefused')], holds: (t) => expect(view(t).events).toContain('lab_unit_refused {"key":"ferritin","unit":"mmol/L"}') },
  {
    name: 'a core value the write refuses, cleared', cloud: true, files: [pdf('labOutOfRange')],
    grid: () => { fireEvent.change(screen.getByDisplayValue('95.0'), { target: { value: '' } }); },
    choices: () => [{ file: 0, change: { tick: 'v0', on: false } }],
    holds: (t) => expect(labs(t)).toHaveLength(1),
  },
  { name: 'no cloud', cloud: false, files: [pdf('labA'), pdf('letterA')], holds: (t) => expect(documents(t).every((d) => !d.fileRef && d.contentHash)).toBe(true) },
  { name: 'a failing original write', cloud: true, failWrite: true, files: [pdf('labA'), pdf('letterA')], holds: (t) => { expect(t.sentry).toBe(2); expect(t.record.originals).toEqual([]); } },
  {
    name: 'two letters of one screening type', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterC1'), pdf('letterC2')],
    holds: (t) => expect(t.record.screenings).toEqual({ colorectalLastDate: '2025-06-12' }),
  },
  {
    name: 'a letter of a type outside the screening table', cloud: true, person: { age: 55, sex: 'female' }, files: [pdf('letterOther'), pdf('letterC1')],
    holds: (t) => expect(t.record.screenings).toEqual({ colorectalLastDate: '2025-05-10' }),
  },
  {
    name: 'another writer\'s edit between plan and commit (another test)', cloud: true, files: [pdf('labA'), pdf('letterA')],
    midway: async () => { await addMeasurement('weight', 80, '2025-09-02'); },
    holds: (t) => expect(rows(t.record.measurements).some((m) => m.metricType === 'weight')).toBe(true),
  },
  {
    name: 'another writer\'s edit between plan and commit (the same slot)', cloud: true, files: [pdf('labA'), pdf('letterA')],
    midway: async () => { await addMeasurement('hdl', 1.6, '2025-09-02'); },
    holds: (t) => expect(labs(t).filter((r) => r.startsWith('hdl'))).toHaveLength(1),
  },
  {
    name: 'a retry after a failed Save', cloud: true, failFirst: true, files: [pdf('labA'), pdf('letterA')],
    holds: (t) => { expect(t.done).toBe(true); expect(documents(t).filter((d) => d.fileRef)).toHaveLength(2); },
  },
  {
    name: 'an erase between plan and commit', cloud: true, midway: eraseHere, files: [pdf('labA'), pdf('letterA')],
    holds: (t) => { expect(t.done).toBe(false); expect([...t.record.labValues, ...t.record.measurements, ...t.record.documents]).toEqual([]); },
    // Ruled 2026-11-22 (accepted): today writes the values first, so their count goes out though the erase removed them
    // (lib/upload-save.ts:54, roadmap-data.ts `countMeasuresAdded`); the adapter counts only a landed commit.
    differs: {
      saveCounts: { today: { values: 5, documents: 0, skipped: 0, refused: 0 }, adapter: null },
      events: { onlyToday: ['measurement_added {"measure":"blood_pressure"}'], onlyAdapter: [] },
    },
  },
  // The owner's rulings, each shown once.
  {
    name: 'ruled: a read letter starts from the reader, never from a held row (US-13 AC6, US-14 AC4)', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await store.bulkSaveDocuments([{ documentType: 'clinic_letter', title: 'Synthetic connector title', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-read:letterA' }]); },
    holds: (t) => expect(documents(t).filter((d) => d.deleted)).toHaveLength(1),
    // Today: the card starts from the newest held row (useReviewDocuments.ts:105-120 `heldRows`). Shared: from the
    // reader's answer and the person's fixes (upload-plan.ts:76-88 `letterStart`). Both tombstone the held row.
    differs: {
      documents: { onlyToday: [letterRow('Synthetic connector title', '2025-01-01')], onlyAdapter: [letterRow('Synthetic letter A', '2025-08-01')] },
      originals: { onlyToday: [letterOriginal('Synthetic connector title', '2025-01-01')], onlyAdapter: [letterOriginal('Synthetic letter A', '2025-08-01')] },
    },
  },
  {
    name: 'ruled: every letter saves, none unticked (US-13 AC14)', cloud: true, files: [pdf('letterA')],
    record: async (store) => { await store.bulkSaveDocuments([{ documentType: 'clinic_letter', title: 'Synthetic earlier letter', documentDate: '2025-01-01', contentMd: 'Synthetic', metadata: {}, sourceFileName: 'letterA.pdf', contentHash: 'hash-other-bytes' }]); },
    holds: (t) => expect(t.done).toBe(false),
    // Today: a letter named like one the record holds starts unticked, so Save offers nothing (useReviewDocuments.ts:
    // 81-89 `isDocDuplicate`). Shared: every read letter saves (upload-plan.ts:73-89); its new bytes are a new row.
    differs: {
      documents: { onlyToday: [], onlyAdapter: [letterRow('Synthetic letter A', '2025-08-01')] },
      originals: { onlyToday: [], onlyAdapter: [letterOriginal('Synthetic letter A', '2025-08-01')] },
      done: { today: false, adapter: true },
      saveCounts: { today: null, adapter: { values: 0, documents: 1, skipped: 0, refused: 0 } },
    },
  },
  { name: 'ruled: a report with nothing ticked keeps its original, with a cloud (US-14 AC11)', ...nothingTicked(true), holds: (t) => expect(t.record.originals).toHaveLength(1) },
  { name: 'ruled: a report with nothing ticked writes no row, with no cloud (US-14 AC11)', ...nothingTicked(false), holds: (t) => expect(t.record.labValues).toEqual([]) },
];

describe('mount 3a: the shared Save keeps what today\'s Save keeps', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const today = await todaySave(c, P);
      c.holds(today);
      const adapter = await adapterSave(c, parityBundle(), P);
      if (process.env.PARITY_DISCOVER) console.log(`SEED ${c.name}`, JSON.stringify({ differs: differences(today, adapter), today: view(today) }));
      expect(differences(today, adapter)).toEqual(c.differs ?? {});
    });
  }
  it.todo('a value the commit refuses after the record changed sends measurement_refused on both sides (engine PR: closed codes for commit refusals)');
  // Not expressible on today's grid: a ZIP member that reaches Save still as an entry (today reads every member it saves,
  // upload-effects.ts:96); covered through the store in storage/roadmap-store-upload-save.test.ts.
});

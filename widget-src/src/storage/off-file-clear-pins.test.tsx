/**
 * @vitest-environment jsdom
 *
 * Root fix R4, PR 2 (lead A23): what each clear of this browser's off-file health data must still remove, pinned
 * before the stored leftovers carry the erase they were written under (docs/drafts/r4-leftover-stamps-design.md).
 *
 * - A matrix draft typed before an erase is gone, whichever tab typed it and whichever took the erase in (US-11 AC1,
 *   AC6). A tab that showed the older erase when it typed counts as before.
 * - Every Lp(a) answer kept before an erase is gone, and a reload asks about its row again (US-11 AC1, AC6; US-05 AC3).
 * - Every stored original the erase did not keep is gone, and the page can no longer read it; one a live document
 *   names after the erase stays readable (US-11 AC6; US-09 AC20, AC23).
 * - Log-off removes all three, even those written after the latest erase (US-09 AC2d).
 *
 * Every leftover is written by the code the page writes it with (the matrix draft hook, the Lp(a) check's answer, a
 * device store's writeDocument), so the pins keep their meaning when that code changes its stored shape. Each page is
 * a fresh module graph, as each tab is in a real browser; jsdom gives every page one window and one localStorage. A
 * matrix is unmounted before the erase it is tested against: one window means another page's clear would drop its
 * screen copy too, and its own effect would then remove the stored draft, hiding a clear that skipped it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCloud as MemoryCloudType } from '@roadmap/health-core/memory-adapter';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { BT_TIMELINE_DRAFT_KEY, DOC_KEY_PREFIX, LPA_CHECK_KEPT_KEY, VITALS_DRAFT_KEY } from '../lib/storage';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

const BACKEND_KEY = 'health_roadmap_backend';
const MEMORY = 'memory'; // MemoryAdapter's id
const draftKeys = () => [localStorage.getItem(BT_TIMELINE_DRAFT_KEY), localStorage.getItem(VITALS_DRAFT_KEY)];
const originalKeys = () => Object.keys(localStorage).filter((key) => key.startsWith(DOC_KEY_PREFIX)).sort();
const pdf = (text: string) => new Blob([`%PDF-1.4 ${text}`], { type: 'application/pdf' });
/** Past the re-read's throttle. */
const later = () => vi.setSystemTime(Date.now() + 60_000);

/** An Lp(a) row the check asks about: typed while the field was mislabelled (lpa-unit.ts), on a US-units device. */
const lpaRow = (id: string) => ({
  id, metricType: 'lpa', value: 10, recordedAt: '2026-09-20', createdAt: '2026-09-20T10:00:00.000Z', source: 'manual', status: 'active',
}) as ApiMeasurement;

const unmounts: Array<() => void> = [];

/** A page (a tab) opened on `cloud`, or on this browser's device record when `cloud` is null. */
async function openPage(cloud: MemoryCloudType | null, cloudUnreachable = false) {
  vi.resetModules();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useMatrixDraft } = await import('../lib/useMatrixDraft');
  const { keepLpaAsIs, lpaRowsToCheck } = await import('../lib/lpa-unit');
  const data = await import('../lib/roadmap-data');
  const { seedDocuments } = await import('../testing/seed-record');
  const { RoadmapStore } = await import('./roadmap-store');
  const { LocalStorageAdapter } = await import('./local-storage-adapter');
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  const opening = vi.spyOn(RoadmapStore, 'create');
  await data.initRoadmapStore(cloud ? new MemoryAdapter(cloud) : new LocalStorageAdapter(), cloudUnreachable);
  const store = await (opening.mock.results.at(-1)!.value as ReturnType<typeof RoadmapStore.create>);
  opening.mockRestore();

  let matrix: ReturnType<typeof useMatrixDraft<'ldl'>> | null = null;
  function Matrix() {
    matrix = useMatrixDraft<'ldl'>(BT_TIMELINE_DRAFT_KEY, { onScreen: () => true, rowsUnder: () => ({}) });
    return null;
  }
  let root: ReturnType<typeof createRoot> | null = null;
  const mount = () => {
    root = createRoot(document.createElement('div'));
    React.act(() => root!.render(React.createElement(Matrix)));
    unmounts.push(() => React.act(() => root?.unmount()));
  };
  return {
    store,
    /** Type into the blood-test matrix's draft column, then leave the matrix. */
    typeDraft(value: string) {
      mount();
      React.act(() => matrix!.type([null, 'ldl'], value));
      React.act(() => root!.unmount());
      root = null;
    },
    /** What the matrix shows when it mounts on this page: the draft it restored, if any. */
    restoredDraft() {
      mount();
      const shown = matrix!.draft.values.ldl ?? null;
      React.act(() => root!.unmount());
      root = null;
      return shown;
    },
    keepLpa: (id: string) => keepLpaAsIs(id),
    /** The rows among `ids` the Lp(a) check asks about on this page. */
    lpaAsks: (ids: string[]) => lpaRowsToCheck(ids.map(lpaRow), 'conventional').map((check) => check.row.id),
    async upload(name: string): Promise<string> {
      const [row] = await seedDocuments(store, [{
        documentType: 'pathology_report', title: name, documentDate: '2026-11-20', contentMd: 'x', metadata: {},
        sourceFileName: `${name}.pdf`, file: pdf(name),
      }]);
      await store.flush();
      return row.fileRef!;
    },
    /** Whether the page can still read the original stored at `ref`. */
    async readsOriginal(ref: string): Promise<boolean> {
      return store.readDocumentFile(ref).then(() => true, () => false);
    },
  };
}

/** A cloud record with one saved row, chosen by this browser. */
async function chosenCloud(): Promise<MemoryCloudType> {
  const { MemoryCloud } = await import('@roadmap/health-core/memory-adapter');
  const cloud = new MemoryCloud();
  localStorage.setItem(BACKEND_KEY, MEMORY);
  const first = await openPage(cloud);
  first.store.addMeasurement('weight', 80, '2026-11-01T00:00:00.000Z', first.store.shownErase);
  await first.store.flush();
  return cloud;
}

/** Another device erases the cloud record: only the cloud file is shared, so nothing on this browser moves. */
async function eraseElsewhere(cloud: MemoryCloudType): Promise<void> {
  const { MemoryAdapter } = await import('@roadmap/health-core/memory-adapter');
  const elsewhere = new MemoryAdapter(cloud);
  const { body, version } = await elsewhere.read(ROADMAP_FILE_NAME);
  const erased = body as { meta: { eraseEpoch?: number }; measurements: unknown[] };
  await elsewhere.write(ROADMAP_FILE_NAME, { ...erased, measurements: [], meta: { ...erased.meta, eraseEpoch: (erased.meta.eraseEpoch ?? 0) + 1 } }, version);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'));
  localStorage.clear();
});
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('US-11 AC1, AC6: a draft typed before an erase is gone, whichever tab typed it', () => {
  it('typed in the tab that erases: its own erase removes it, and a reload restores nothing', async () => {
    const cloud = await chosenCloud();
    const tab = await openPage(cloud);
    tab.typeDraft('2.7');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).not.toBeNull();

    expect((await tab.store.deleteAllData()).success).toBe(true);

    expect(draftKeys()).toEqual([null, null]);
    expect((await openPage(cloud)).restoredDraft()).toBeNull();
  });

  it('typed in tab A, erased in tab B: gone once B erases, and gone after A takes the erase in', async () => {
    const cloud = await chosenCloud();
    const a = await openPage(cloud);
    const b = await openPage(cloud);
    a.typeDraft('2.7');

    expect((await b.store.deleteAllData()).success).toBe(true);
    expect(draftKeys()).toEqual([null, null]);

    later();
    expect(await a.store.refreshFromRemote()).toBe(true);
    expect(draftKeys()).toEqual([null, null]);
    expect(a.restoredDraft()).toBeNull();
  });

  it('typed in tab A, erased on another device, taken in by tab B: gone, and a reload restores nothing', async () => {
    const cloud = await chosenCloud();
    const a = await openPage(cloud);
    const b = await openPage(cloud);
    a.typeDraft('2.7');
    await eraseElsewhere(cloud);

    later();
    expect(await b.store.refreshFromRemote()).toBe(true);

    expect(draftKeys()).toEqual([null, null]);
    expect((await openPage(cloud)).restoredDraft()).toBeNull();
  });

  it('typed in tab Y while it still showed the older erase, after tab X took the new one in: gone once Y takes it in', async () => {
    const cloud = await chosenCloud();
    const x = await openPage(cloud);
    const y = await openPage(cloud);
    await eraseElsewhere(cloud);
    later();
    expect(await x.store.refreshFromRemote()).toBe(true);
    const older = y.store.shownErase;
    expect(older).not.toBe(x.store.eraseIdentity);

    y.typeDraft('2.7'); // Y shows the erase before the new one
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).not.toBeNull();
    later();
    expect(await y.store.refreshFromRemote()).toBe(true);

    expect(draftKeys()).toEqual([null, null]);
    expect((await openPage(cloud)).restoredDraft()).toBeNull();
  });
});

describe('US-11 AC1, AC6; US-05 AC3: every Lp(a) answer kept before an erase is gone', () => {
  it('answers kept in two tabs, then one tab erases: none is stored, and a reload asks about both rows again', async () => {
    const cloud = await chosenCloud();
    const a = await openPage(cloud);
    const b = await openPage(cloud);
    a.keepLpa('row-a');
    b.keepLpa('row-b');
    expect(a.lpaAsks(['row-a', 'row-b'])).toEqual([]);

    expect((await b.store.deleteAllData()).success).toBe(true);

    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect((await openPage(cloud)).lpaAsks(['row-a', 'row-b'])).toEqual(['row-a', 'row-b']);
  });

  it('an answer kept in tab A, erased on another device, taken in by tab B: not stored, and a reload asks again', async () => {
    const cloud = await chosenCloud();
    const a = await openPage(cloud);
    const b = await openPage(cloud);
    a.keepLpa('row-a');
    await eraseElsewhere(cloud);

    later();
    expect(await b.store.refreshFromRemote()).toBe(true);

    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect((await openPage(cloud)).lpaAsks(['row-a'])).toEqual(['row-a']);
  });

  it('an answer kept in tab Y while it still showed the older erase: gone once Y takes the new one in', async () => {
    const cloud = await chosenCloud();
    const x = await openPage(cloud);
    const y = await openPage(cloud);
    await eraseElsewhere(cloud);
    later();
    expect(await x.store.refreshFromRemote()).toBe(true);

    y.keepLpa('row-y');
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).not.toBeNull();
    later();
    expect(await y.store.refreshFromRemote()).toBe(true);

    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect((await openPage(cloud)).lpaAsks(['row-y'])).toEqual(['row-y']);
  });
});

describe('US-11 AC6; US-09 AC20, AC23: every stored original the erase did not keep is gone', () => {
  it('originals stored by two guest tabs before one erases are gone in both; one uploaded after the erase stays readable', async () => {
    const a = await openPage(null);
    const before1 = await a.upload('lipids');
    const b = await openPage(null);
    const before2 = await b.upload('thyroid');
    expect(originalKeys()).toEqual([DOC_KEY_PREFIX + before1, DOC_KEY_PREFIX + before2].sort());

    expect((await b.store.deleteAllData()).success).toBe(true);
    expect(originalKeys()).toEqual([]);
    expect(await b.readsOriginal(before2)).toBe(false);

    const after = await b.upload('kidney'); // after the erase: its row survives, so its original stays
    later();
    expect(await a.store.refreshFromRemote()).toBe(true); // A takes the erase in

    expect(originalKeys()).toEqual([DOC_KEY_PREFIX + after]);
    expect(await a.readsOriginal(before1)).toBe(false);
    expect(await a.readsOriginal(before2)).toBe(false);
    expect(await a.readsOriginal(after)).toBe(true);
  });
});

describe('US-09 AC2d: log-off removes every off-file leftover, those written after the latest erase included', () => {
  it('a draft, an Lp(a) answer and a stored original, all written after an erase: log-off removes them all', async () => {
    const cloud = await chosenCloud();
    const tab = await openPage(cloud);
    expect((await tab.store.deleteAllData()).success).toBe(true); // the latest erase: everything below is newer
    tab.typeDraft('2.7');
    tab.keepLpa('row-a');
    const fallback = await openPage(null, true); // a tab of this browser that could not read the cloud
    const ref = await fallback.upload('lipids');
    expect(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)).not.toBeNull();
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).not.toBeNull();
    expect(originalKeys()).toEqual([DOC_KEY_PREFIX + ref]);

    vi.stubGlobal('location', { reload: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
    const { logOff } = await import('../../standalone/connect');
    await logOff('self-host');

    expect(draftKeys()).toEqual([null, null]);
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect(originalKeys()).toEqual([]);
    const next = await openPage(null); // the page after the reload: a guest on this browser
    expect(next.restoredDraft()).toBeNull();
    expect(next.lpaAsks(['row-a'])).toEqual(['row-a']);
    expect(await next.readsOriginal(ref)).toBe(false);
  });
});

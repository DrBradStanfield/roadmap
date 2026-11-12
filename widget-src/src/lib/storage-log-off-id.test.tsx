// @vitest-environment jsdom
/**
 * US-09 AC2c: a cloud page writes nothing to this device after a log-off on
 * this device, whether or not it heard of the log-off. Every on-device health
 * writer checks one state (healthWritesAllowed): the saved-record mirror, the
 * matrix drafts, the Lp(a) kept answers and the record's device copy. A page
 * whose device copy is its only store keeps writing.
 *
 * Each test is a fresh page: a fresh module graph, loaded after the device's
 * log-off id is set. The id then changes with no storage event, as for a tab
 * that heard nothing. Synthetic values; in-memory cloud; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const BACKEND_KEY = 'health_roadmap_backend';
const MIRROR_KEY = 'health_roadmap_data';
const LPA_KEPT_KEY = 'health_roadmap_lpa_check_kept';
const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
const FILE_KEY = 'health_roadmap_file_v2';

const med = { id: 'm1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-10-20T00:00:00.000Z' } as never;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-at-load');
  localStorage.setItem(BACKEND_KEY, 'memory'); // MemoryAdapter's id
});
afterEach(async () => {
  (await import('@testing-library/react')).cleanup();
  localStorage.clear();
});

/** This page opens a cloud record, as the standalone page does at load. */
async function cloudPage() {
  const { RoadmapStore } = await import('../storage/roadmap-store');
  return RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
}
/** Another tab logs off and the device signs in again; this page hears nothing. */
const logOffElsewhere = () => localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');

async function typeWeight(value: string) {
  const { render, fireEvent } = await import('@testing-library/react');
  const { StartingInfoVitals } = await import('../components/StartingInfoVitals');
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const view = render(<StartingInfoVitals vitalsHistory={history} unitSystem="si"
    onSave={async () => new Map()} onDraftValue={() => {}} formStage={3} plan={null}
    unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
  fireEvent.change(row.querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!, { target: { value } });
}

describe('US-09 AC2c: a cloud page loaded before a log-off writes no health data to this device after it', () => {
  it('a profile save writes no saved-record mirror', async () => {
    await cloudPage();
    const { patchMirror, saveToLocalStorage } = await import('./storage');
    logOffElsewhere();
    patchMirror({ profile: { heightCm: 175, sex: 'female' } as never });
    saveToLocalStorage({ heightCm: 175 } as never, [], [med], []);
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
  });

  it('a typed vitals value is not kept as a draft', async () => {
    await cloudPage();
    logOffElsewhere();
    await typeWeight('80');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  });

  it("a typed vitals value leaves the draft the device holds since the log-off", async () => {
    await cloudPage();
    logOffElsewhere();
    const theirs = JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} });
    localStorage.setItem(VITALS_DRAFT_KEY, theirs);
    await typeWeight('81');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(theirs);
  });

  it('an Lp(a) answer is not kept on the device', async () => {
    await cloudPage();
    const { keepLpaAsIs } = await import('./lpa-unit');
    logOffElsewhere();
    keepLpaAsIs('lpa-row-1');
    expect(localStorage.getItem(LPA_KEPT_KEY)).toBeNull();
  });

  it("a switch's copy to this device writes no record", async () => {
    const store = await cloudPage();
    store.addMeasurement('weight', 80, '2026-10-01T00:00:00.000Z');
    await store.flush();
    logOffElsewhere();
    await store.copyToDevice().catch(() => {});
    expect(localStorage.getItem(FILE_KEY)).toBeNull();
  });
});

describe('US-09 AC2c controls', () => {
  it("after this page's own log-off begins, a typed value removes the draft", async () => {
    await cloudPage();
    const { beginRoadmapLogOff } = await import('../storage/web-record-host');
    beginRoadmapLogOff();
    localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} }));
    await typeWeight('81');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  });

  it('a page that heard a log-off while loading writes nothing when it opens on the device with the same id', async () => {
    const { listenForOtherTabsLogOff, LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    listenForOtherTabsLogOff();
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'health_roadmap_log_off_signal' }));
    const { RoadmapStore } = await import('../storage/roadmap-store');
    await RoadmapStore.create(new LocalStorageAdapter());
    const { healthWritesAllowed, patchMirror } = await import('./storage');
    expect(localStorage.getItem(LOG_OFF_ID_KEY)).toBe('id-at-load');
    expect(healthWritesAllowed()).toBe(false);
    patchMirror({ medications: [med] });
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
  });

  it('a page that finds the id changed as it opens on the device leaves the draft key alone', async () => {
    const { healthWritesAllowed } = await import('./storage');
    logOffElsewhere();
    const { RoadmapStore } = await import('../storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    await RoadmapStore.create(new LocalStorageAdapter());
    expect(healthWritesAllowed()).toBe(false);
    const theirs = JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} });
    localStorage.setItem(VITALS_DRAFT_KEY, theirs);
    await typeWeight('81');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(theirs);
  });

  it('a page whose device copy is its only store keeps writing after the id changes; its typed draft stays on screen only', async () => {
    localStorage.removeItem(BACKEND_KEY);
    const { RoadmapStore } = await import('../storage/roadmap-store');
    const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    const { patchMirror } = await import('./storage');
    const { keepLpaAsIs } = await import('./lpa-unit');
    logOffElsewhere();
    patchMirror({ medications: [med] });
    keepLpaAsIs('lpa-row-1');
    await typeWeight('80');
    store.addMeasurement('weight', 80, '2026-10-01T00:00:00.000Z');
    await store.flush();
    expect(localStorage.getItem(MIRROR_KEY)).not.toBeNull();
    expect(localStorage.getItem(LPA_KEPT_KEY)).not.toBeNull();
    // A page whose log-off id changed since load owns no off-file data, so it writes no draft (US-11 AC6).
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
  });

  it('a cloud page loaded after the log-off writes normally', async () => {
    logOffElsewhere();
    const store = await cloudPage();
    const { patchMirror } = await import('./storage');
    const { keepLpaAsIs } = await import('./lpa-unit');
    patchMirror({ medications: [med] });
    keepLpaAsIs('lpa-row-1');
    await typeWeight('80');
    await store.copyToDevice();
    expect(localStorage.getItem(MIRROR_KEY)).not.toBeNull();
    expect(localStorage.getItem(LPA_KEPT_KEY)).not.toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
    expect(localStorage.getItem(FILE_KEY)).not.toBeNull();
  });
});

describe('US-09 AC2h: a page whose record is still opening', () => {
  it('writes no health data after a log-off elsewhere, before it knows it is a device page', async () => {
    const { patchMirror } = await import('./storage');
    const { keepLpaAsIs } = await import('./lpa-unit');
    logOffElsewhere();
    patchMirror({ medications: [med] });
    keepLpaAsIs('lpa-row-1');
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
    expect(localStorage.getItem(LPA_KEPT_KEY)).toBeNull();
  });

  it('control: writes while the id is the one it loaded with', async () => {
    const { patchMirror } = await import('./storage');
    patchMirror({ medications: [med] });
    expect(localStorage.getItem(MIRROR_KEY)).not.toBeNull();
  });
});

describe('US-09 AC2c: a cloud page restored from the back-forward cache', () => {
  it('still writes nothing after a log-off elsewhere while it was away', async () => {
    await cloudPage();
    const { patchMirror, healthWritesAllowed } = await import('./storage');
    logOffElsewhere();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(healthWritesAllowed()).toBe(false);
    patchMirror({ medications: [med] });
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
  });
});

describe('US-09 AC2c, AC2h: the health-write state', () => {
  const quiet = { mode: 'loading', logOffHeard: false } as const;
  const heard = { mode: 'loading', logOffHeard: true } as const;
  const device = { mode: 'device' } as const;
  const cloud = { mode: 'cloud', storeId: 'memory' } as const;
  const otherCloud = { mode: 'cloud', storeId: 'google-drive' } as const;
  const stopped = { mode: 'stopped' } as const;
  const same = { type: 'deviceOpened', sameSignIn: true } as const;
  const changed = { type: 'deviceOpened', sameSignIn: false } as const;
  const opened = { type: 'cloudOpened', storeId: 'memory' } as const;
  const otherOpened = { type: 'cloudOpened', storeId: 'google-drive' } as const;
  const hear = { type: 'logOffHeard' } as const;
  const stop = { type: 'stop' } as const;
  it.each([
    [quiet, same, device],
    [quiet, changed, stopped],
    [quiet, opened, cloud],
    [quiet, hear, heard],
    [quiet, stop, stopped],
    [heard, same, stopped],
    [heard, changed, stopped],
    [heard, opened, stopped],
    [heard, hear, heard],
    [heard, stop, stopped],
    [device, same, device],
    [device, changed, device],
    [device, opened, cloud],
    [device, hear, device],
    [device, stop, stopped],
    [cloud, same, device],
    [cloud, changed, stopped],
    [cloud, opened, cloud],
    [cloud, otherOpened, otherCloud], // two cloud hosts in a row (the OAuth return's lift, then the store): the last one's id
    [cloud, hear, stopped],
    [cloud, stop, stopped],
    [stopped, same, stopped],
    [stopped, changed, stopped],
    [stopped, opened, stopped],
    [stopped, otherOpened, stopped],
    [stopped, hear, stopped],
    [stopped, stop, stopped],
  ] as const)('%o + %o -> %o', async (state, event, next) => {
    const { healthWritesTransition } = await import('./storage');
    expect(healthWritesTransition(state, event)).toEqual(next);
  });
});

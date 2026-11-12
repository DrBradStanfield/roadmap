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

  it('a page whose device copy is its only store keeps writing after the id changes', async () => {
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
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
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

describe('US-09 AC2c: the health-write state moves one way only', () => {
  it.each([
    ['device', 'cloudOpened', 'cloud'],
    ['device', 'stop', 'stopped'],
    ['cloud', 'cloudOpened', 'cloud'],
    ['cloud', 'stop', 'stopped'],
    ['stopped', 'cloudOpened', 'stopped'],
    ['stopped', 'stop', 'stopped'],
  ] as const)('%s + %s -> %s', async (state, event, next) => {
    const { healthWritesTransition } = await import('./storage');
    expect(healthWritesTransition(state, event)).toBe(next);
  });
});

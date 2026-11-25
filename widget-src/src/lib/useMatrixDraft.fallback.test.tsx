// @vitest-environment jsdom
/**
 * US-11 AC6, US-09 AC13 — the matrix drafts and the Lp(a) kept answer on a
 * page that runs on its device copy while this browser has chosen a cloud (a
 * fallback page). Only a page on the chosen record reads, writes or removes
 * the shared draft key, and writes the Lp(a) answer: a fallback page is on
 * the record of the cloud it fell back from while that cloud stays chosen.
 *
 * Each test is a fresh page (a fresh module graph). Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const BACKEND_KEY = 'health_roadmap_backend';
const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
const LPA_KEPT_KEY = 'health_roadmap_lpa_check_kept';
const THEIRS = JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} });

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-at-load');
  localStorage.setItem(BACKEND_KEY, 'memory'); // MemoryAdapter's id: the cloud this browser chose
});
afterEach(async () => {
  (await import('@testing-library/react')).cleanup();
  localStorage.clear();
});

/** The cloud's first read failed, so this page runs on its device copy. */
async function fallbackPage() {
  const { RoadmapStore } = await import('../storage/roadmap-store');
  const { LocalStorageAdapter } = await import('../storage/local-storage-adapter');
  return RoadmapStore.create(new LocalStorageAdapter());
}

/** The vitals matrix, mounted on this page; its weight cell's input. */
async function vitals() {
  const { render } = await import('@testing-library/react');
  const { StartingInfoVitals } = await import('../components/StartingInfoVitals');
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn(async () => new Map());
  const view = render(<StartingInfoVitals vitalsHistory={history} unitSystem="si"
    onSave={onSave} formStage={3} plan={null}
    unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
  return { weight: row.querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!, onSave, unmount: view.unmount, view };
}

describe('US-11 AC6: a matrix mounted before the record opens', () => {
  it.each([
    ['its device copy, as a fallback', async () => { await fallbackPage(); }],
    ['its cloud', async () => { (await import('./storage')).noteCloudPage('memory'); }],
  ] as const)('keeps typing on screen only, then on the device from the first change after the record opens on %s', async (_, open) => {
    const { fireEvent } = await import('@testing-library/react');
    const m = await vitals(); // the page is still loading
    fireEvent.change(m.weight, { target: { value: '80' } });
    expect(m.weight.value).toBe('80');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();

    await open();
    const waist = Array.from(m.view.container.querySelectorAll<HTMLElement>('.bt-row'))
      .find(r => r.querySelector('.bt-name-label')?.textContent === 'Waist Circumference')!
      .querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!;
    fireEvent.change(waist, { target: { value: '90' } });
    expect(JSON.parse(localStorage.getItem(VITALS_DRAFT_KEY)!).draft.values).toEqual({ weight: '80', waist: '90' });
  });
});

describe('US-11 AC6: a fallback page while its cloud stays chosen', () => {
  it('keeps a typed value as a draft, removes it once the value is saved, and the next good load shows no draft', async () => {
    const { fireEvent, act } = await import('@testing-library/react');
    await fallbackPage();
    const m = await vitals();
    fireEvent.change(m.weight, { target: { value: '80' } });
    expect(JSON.parse(localStorage.getItem(VITALS_DRAFT_KEY)!).draft.values).toEqual({ weight: '80' });

    await act(async () => { fireEvent.keyDown(m.weight, { key: 'Enter' }); });
    expect(m.onSave).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    m.unmount();

    vi.resetModules(); // the next load reaches the cloud
    const { RoadmapStore } = await import('../storage/roadmap-store');
    await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    expect((await vitals()).weight.value).toBe('');
  });
});

describe('US-11 AC6: a page off the chosen record', () => {
  it('a fallback page whose cloud is no longer chosen restores, writes and removes no draft, and keeps the Lp(a) answer on the page', async () => {
    const { fireEvent } = await import('@testing-library/react');
    await fallbackPage();
    localStorage.setItem(BACKEND_KEY, 'google-drive'); // another tab switched
    localStorage.setItem(VITALS_DRAFT_KEY, THEIRS);
    const m = await vitals();
    expect(m.weight.value).toBe(''); // the shared draft is the chosen record's, not this page's

    fireEvent.change(m.weight, { target: { value: '81' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(THEIRS);
    fireEvent.change(m.weight, { target: { value: '' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(THEIRS);

    const { keepLpaAsIs } = await import('./lpa-unit');
    keepLpaAsIs('lpa-row-1');
    expect(localStorage.getItem(LPA_KEPT_KEY)).toBeNull();
  });

  it('a cloud page after a log-off elsewhere since it loaded restores no draft', async () => {
    const { RoadmapStore } = await import('../storage/roadmap-store');
    await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-after'); // another tab logged off; this page heard nothing
    localStorage.setItem(VITALS_DRAFT_KEY, THEIRS);
    expect((await vitals()).weight.value).toBe('');
  });

  it('control: a page on the chosen record restores the draft', async () => {
    const { RoadmapStore } = await import('../storage/roadmap-store');
    await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
    localStorage.setItem(VITALS_DRAFT_KEY, THEIRS);
    expect((await vitals()).weight.value).toBe('79');
  });
});

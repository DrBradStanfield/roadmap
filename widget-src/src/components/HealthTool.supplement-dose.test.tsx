// @vitest-environment jsdom
/** US-06 AC1b: the displayed supplement dose limits also apply to autosave.
 * Keep the real InputPanel -> HealthTool -> RoadmapStore -> localStorage path.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION, MemoryAdapter, MemoryCloud, migrateFile, ROADMAP_FILE_NAME, rowRootIds, upsertSupplement, type RoadmapFile } from '@roadmap/health-core';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements, saveSupplement } from '../lib/roadmap-data';
import { ERASE_UNREACHABLE, RoadmapStore } from '../storage/roadmap-store';
import { DRAFTS_CLEARED_EVENT } from '../lib/storage';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

async function page(initial: number | null = null) {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980 }, [['weight', 80]]);
  await saveSupplement('custom_test_supplement', 'Test supplement', initial, null);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.supplement-dose')).not.toBeNull());
  return view;
}

function dose(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.supplement-dose')!;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await flushRoadmapStore();
  });
}

async function persisted(): Promise<RoadmapFile> {
  const read = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
  expect(read.body).not.toBeNull();
  return read.body as RoadmapFile;
}

describe('US-06 AC1b: supplement dose autosave', () => {
  it.each([
    { initial: null, invalid: '0' },
    { initial: 25, invalid: '0' },
    { initial: null, invalid: '-5' },
    { initial: null, invalid: '100000' },
    { initial: 25, invalid: '-5' },
    { initial: 25, invalid: '100000' },
    { initial: 25, invalid: '1e1' },
  ])('refuses $invalid without changing the saved $initial dose or history', async ({ initial, invalid }) => {
    const view = await page(initial);
    const before = await persisted();
    fireEvent.change(dose(view.container), { target: { value: invalid } });
    fireEvent.blur(dose(view.container));
    await settle();
    const after = await persisted();
    expect(after.supplements).toEqual(before.supplements);
    expect(after.supplementHistory).toEqual(before.supplementHistory);
    expect(dose(view.container).value).toBe(invalid);
    expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toContain('greater than 0 and no more than 99999');

    // A unit edit must use the accepted dose, never publish the invalid draft.
    fireEvent.change(view.container.querySelector('.supplement-unit')!, { target: { value: 'mg' } });
    await settle();
    expect((await persisted()).supplements[0]).toMatchObject({ doseValue: initial, doseUnit: 'mg' });
    expect(dose(view.container).value).toBe(invalid);
    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = render(<HealthTool />);
    await waitFor(() => expect(dose(reloaded.container)?.value).toBe(initial === null ? '' : String(initial)));
    expect((await persisted()).supplements[0]).toMatchObject({ doseValue: initial, doseUnit: 'mg' });
  });

  it.each([0.5, 99999])('saves the legitimate dose %s without requiring a unit', async value => {
    const view = await page();
    fireEvent.change(dose(view.container), { target: { value: String(value) } });
    await settle();
    expect((await persisted()).supplements[0]).toMatchObject({ doseValue: value, doseUnit: null });
    expect(dose(view.container).validity.valid).toBe(true);
    expect(dose(view.container).getAttribute('aria-invalid')).not.toBe('true');
    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = render(<HealthTool />);
    await waitFor(() => expect(dose(reloaded.container)?.value).toBe(String(value)));
  });

  it('saves valid typing prefixes, refuses an excess digit and accepts a correction', async () => {
    const view = await page(25);
    const beforeZero = await persisted();
    fireEvent.change(dose(view.container), { target: { value: '0' } });
    await settle();
    expect((await persisted()).supplements).toEqual(beforeZero.supplements);
    expect((await persisted()).supplementHistory).toEqual(beforeZero.supplementHistory);
    expect(dose(view.container).value).toBe('0');
    expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
    for (const raw of ['0.5', '1', '10', '100', '1000', '10000']) {
      fireEvent.change(dose(view.container), { target: { value: raw } });
      expect(dose(view.container).value).toBe(raw);
      await settle();
      expect((await persisted()).supplements[0].doseValue).toBe(Number(raw));
    }
    const beforeInvalid = await persisted();
    fireEvent.change(dose(view.container), { target: { value: '100000' } });
    await settle();
    expect((await persisted()).supplements).toEqual(beforeInvalid.supplements);
    expect((await persisted()).supplementHistory).toEqual(beforeInvalid.supplementHistory);
    fireEvent.change(dose(view.container), { target: { value: '99999' } });
    await settle();
    expect((await persisted()).supplements[0].doseValue).toBe(99999);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('clears a rejected draft deliberately without removing its supplement', async () => {
    const view = await page(25);
    fireEvent.change(dose(view.container), { target: { value: '-5' } });
    fireEvent.change(dose(view.container), { target: { value: '' } });
    await settle();
    expect((await persisted()).supplements).toEqual([expect.objectContaining({ doseValue: null, doseUnit: null, status: 'active' })]);
    expect(dose(view.container).value).toBe('');
    expect(view.queryByRole('alert')).toBeNull();
    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = render(<HealthTool />);
    await waitFor(() => expect(dose(reloaded.container)?.value).toBe(''));
  });

  it('does not replace a pending valid autosave with an invalid draft', async () => {
    const view = await page(25);
    fireEvent.change(dose(view.container), { target: { value: '30' } });
    fireEvent.change(dose(view.container), { target: { value: '-5' } });
    await settle();
    expect((await persisted()).supplements[0]).toMatchObject({ doseValue: 30, doseUnit: null });
    expect(dose(view.container).value).toBe('-5');
  });

  it('does not treat the browser badInput empty value as an explicit clear', async () => {
    const view = await page(25);
    const before = await persisted();
    // jsdom cannot type an incomplete number. Model only the browser validity
    // boundary; all React events, callers and persistence remain real.
    const badInput = vi.spyOn(dose(view.container).validity, 'badInput', 'get').mockReturnValue(true);
    fireEvent.change(dose(view.container), { target: { value: '' } });
    await settle();
    expect((await persisted()).supplements).toEqual(before.supplements);
    expect((await persisted()).supplementHistory).toEqual(before.supplementHistory);
    expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
    badInput.mockRestore();
    fireEvent.change(dose(view.container), { target: { value: '0.5' } });
    await settle();
    expect((await persisted()).supplements[0].doseValue).toBe(0.5);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('removes a supplement with a rejected draft and restarts it without that draft', async () => {
    const view = await page(25);
    fireEvent.change(dose(view.container), { target: { value: '100000' } });
    fireEvent.click(view.container.querySelector('.supplement-remove')!);
    await settle();
    expect((await persisted()).supplements[0]).toMatchObject({ doseValue: 25, status: 'stopped' });
    expect(view.container.querySelector('.supplement-dose')).toBeNull();
    fireEvent.change(view.container.querySelector('.supplement-add input')!, { target: { value: 'Test supplement' } });
    fireEvent.click(view.container.querySelector('.supplement-custom')!);
    expect(dose(view.container).value).toBe('');
    expect(view.queryByRole('alert')).toBeNull();
    fireEvent.change(dose(view.container), { target: { value: '2.5' } });
    await settle();
    expect((await persisted()).supplements).toEqual([expect.objectContaining({ doseValue: 2.5, status: 'active' })]);
  });
});

// US-11 AC1/AC6: off-file drafts follow an erase, not an ordinary re-read.
// Only the cloud bytes are synthetic; the mounted panel, erase action, store,
// merge, draft-clear notification and remote-change reload all remain real.
describe('US-11: supplement dose draft erase lifecycle', () => {
  async function cloudPage() {
    // Drive refresh explicitly so background polling cannot consume its throttle.
    vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
    const created = vi.spyOn(RoadmapStore, 'create');
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    await initRoadmapStore(adapter);
    const store = await created.mock.results[0].value;
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1980 }, {});
    await addMeasurement('weight', 80, '2026-09-01');
    await saveSupplement('custom_test_supplement', 'Test supplement', 25, null);
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(dose(view.container)?.value).toBe('25'));
    const panel = view.container.querySelector('.health-input-panel');
    fireEvent.change(dose(view.container), { target: { value: '-5' } });
    expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
    return { adapter, store, view, panel };
  }

  async function remoteDose(adapter: MemoryAdapter, value: number) {
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const now = new Date().toISOString();
    const file = migrateFile(body, { deviceId: 'other-device', now });
    const changed = upsertSupplement(file, {
      supplementKey: 'custom_test_supplement', supplementName: 'Test supplement',
      doseValue: value, doseUnit: 'mg', status: 'active',
    }, now).file;
    // A new saved weight reopens stage 3 after erase; without it progressive
    // disclosure correctly hides every supplement, including the new row.
    if (changed.measurements.length === 0) changed.measurements.push({
      id: 'post-erase-weight', metricType: 'weight', value: 80, recordedAt: '2026-09-02',
      createdAt: now, source: 'manual', status: 'active', correctsId: null, externalId: null,
    });
    await adapter.write(ROADMAP_FILE_NAME, changed, version);
    expect((await adapter.read(ROADMAP_FILE_NAME)).body).toEqual(changed);
  }

  async function remoteErase(adapter: MemoryAdapter) {
    const { body, version } = await adapter.read(ROADMAP_FILE_NAME);
    const ctx = { deviceId: 'other-device', now: new Date().toISOString() };
    const prior = migrateFile(body, ctx);
    const erased = migrateFile(null, ctx);
    const epoch = (prior.meta.eraseEpoch ?? 0) + 1;
    erased.schemaVersion = CURRENT_SCHEMA_VERSION;
    erased.meta.eraseEpoch = epoch;
    erased.meta.erasedAt = ctx.now;
    erased.erasedRows = {
      fromEpoch: prior.erasedRows?.fromEpoch ?? epoch,
      ids: [...new Set([...rowRootIds(prior), ...(prior.erasedRows?.ids ?? [])])].sort(),
    };
    await adapter.write(ROADMAP_FILE_NAME, erased, version);
    expect((await adapter.read(ROADMAP_FILE_NAME)).body).toEqual(erased);
  }

  for (const origin of ['this page', 'another device']) {
    it(`drops the rejected draft after ${origin} erases, before a remote same-key row arrives`, async () => {
      const { adapter, store, view, panel } = await cloudPage();
      if (origin === 'this page') {
        vi.stubGlobal('confirm', () => true);
        const alert = vi.fn();
        vi.stubGlobal('alert', alert);
        fireEvent.click(view.getByText('Delete All My Data'));
        await waitFor(() => expect(alert).toHaveBeenCalled());
      } else {
        await remoteErase(adapter);
        await act(async () => { expect(await store.refreshFromRemote()).toBe(true); });
      }
      await waitFor(() => expect(view.container.querySelector('.supplement-dose')).toBeNull());
      expect(((await adapter.read(ROADMAP_FILE_NAME)).body as RoadmapFile).supplements).toEqual([]);
      expect(view.container.querySelector('.health-input-panel')).toBe(panel);
      // Past the real store's re-read throttle; no remount or local add masks
      // a draft retained under this key.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5100)); });
      await remoteDose(adapter, 40);
      await act(async () => { expect(await store.refreshFromRemote()).toBe(true); });
      await waitFor(() => expect(dose(view.container)).toBeTruthy());
      expect(store.loadLatestMeasurements().supplements).toEqual([
        expect.objectContaining({ supplementKey: 'custom_test_supplement', doseValue: 40, doseUnit: 'mg' }),
      ]);
      expect(view.container.querySelector('.health-input-panel')).toBe(panel);
      expect(dose(view.container).value).toBe('40');
      expect(dose(view.container).getAttribute('aria-invalid')).not.toBe('true');
      expect(view.queryByRole('alert')).toBeNull();
    }, 20000);
  }

  it('keeps the rejected draft through an ordinary remote re-read, including a changed accepted dose', async () => {
    const { adapter, store, view, panel } = await cloudPage();
    await remoteDose(adapter, 40);
    await act(async () => { expect(await store.refreshFromRemote()).toBe(true); });
    expect(store.loadLatestMeasurements().supplements?.[0].doseValue).toBe(40);
    expect(view.container.querySelector('.health-input-panel')).toBe(panel);
    expect(dose(view.container).value).toBe('-5');
    expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toContain('This dose was not saved.');
  });

  it('keeps the rejected draft when the real erase refuses an unreachable cloud read', async () => {
    const { adapter, store, view, panel } = await cloudPage();
    const before = await adapter.read(ROADMAP_FILE_NAME);
    const identity = store.eraseIdentity;
    const cleared = vi.fn();
    window.addEventListener(DRAFTS_CLEARED_EVENT, cleared);
    try {
      const failure = vi.spyOn(adapter, 'read').mockRejectedValueOnce(new Error('synthetic cloud unavailable'));
      const alert = vi.fn();
      vi.stubGlobal('confirm', () => true);
      vi.stubGlobal('alert', alert);
      fireEvent.click(view.getByText('Delete All My Data'));
      await waitFor(() => expect(alert).toHaveBeenCalledWith(ERASE_UNREACHABLE));
      failure.mockRestore();
      expect(cleared).not.toHaveBeenCalled();
      expect(store.eraseIdentity).toBe(identity);
      expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual(before);
      expect(view.container.querySelector('.health-input-panel')).toBe(panel);
      expect(dose(view.container).value).toBe('-5');
      expect(dose(view.container).getAttribute('aria-invalid')).toBe('true');
      expect(view.getByRole('alert').textContent).toContain('This dose was not saved.');
    } finally {
      window.removeEventListener(DRAFTS_CLEARED_EVENT, cleared);
    }
  });
});

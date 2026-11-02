// @vitest-environment jsdom
/** US-06: custom additions must not replace another supplement's current dose.
 * Exercise InputPanel -> HealthTool -> RoadmapStore -> shared writer and the
 * actual localStorage adapter, not a replacement onSupplementChange callback.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { flushRoadmapStore, initRoadmapStore, saveSupplement } from '../lib/roadmap-data';
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

async function page() {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.supplement-add input')).not.toBeNull());
  return view;
}

function addCustom(container: HTMLElement, name: string): void {
  fireEvent.change(container.querySelector('.supplement-add input')!, { target: { value: name } });
  fireEvent.click(container.querySelector('.supplement-custom')!);
}

function row(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.supplement-row')]
    .find(el => el.querySelector('.supplement-name')?.textContent === name);
  expect(found, `current row for ${name}`).toBeDefined();
  return found!;
}

function dose(container: HTMLElement, name: string, value: number, unit: string): void {
  fireEvent.change(row(container, name).querySelector('.supplement-dose')!, { target: { value: String(value) } });
  fireEvent.change(row(container, name).querySelector('.supplement-unit')!, { target: { value: unit } });
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

async function seed(): Promise<void> {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1 }, [['weight', 80]]);
}

describe('US-06: collision-safe custom supplement additions', () => {
  it('keeps β-alanine and alanine with separate doses across save, reload and edit', async () => {
    await seed();
    const view = await page();
    addCustom(view.container, 'β-alanine');
    dose(view.container, 'β-alanine', 3, 'g');
    // The second addition also has to reserve against unsaved, optimistic rows.
    addCustom(view.container, 'alanine');
    dose(view.container, 'alanine', 500, 'mg');
    expect(view.container.querySelectorAll('.supplement-row')).toHaveLength(2);
    expect(row(view.container, 'β-alanine').querySelector<HTMLInputElement>('.supplement-dose')!.value).toBe('3');
    await settle();

    const before = await persisted();
    expect(before.supplements).toHaveLength(2);
    expect(before.supplements).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplementKey: 'custom_alanine', supplementName: 'β-alanine', doseValue: 3, doseUnit: 'g' }),
      expect.objectContaining({ supplementName: 'alanine', doseValue: 500, doseUnit: 'mg' }),
    ]));
    expect(new Set(before.supplements.map(s => s.supplementKey)).size).toBe(2);
    expect(before.supplementHistory.map(s => s.supplementName).sort()).toEqual(['alanine', 'β-alanine']);

    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = await page();
    expect(reloaded.container.querySelectorAll('.supplement-row')).toHaveLength(2);
    dose(reloaded.container, 'alanine', 750, 'mg');
    reloaded.rerender(<HealthTool />);
    await settle();
    const after = await persisted();
    expect(after.supplements).toHaveLength(2);
    for (const old of before.supplements) {
      expect(after.supplements.find(s => s.supplementKey === old.supplementKey)).toMatchObject({
        id: old.id, supplementName: old.supplementName, startedAt: old.startedAt,
        doseValue: old.supplementName === 'alanine' ? 750 : 3, doseUnit: old.doseUnit,
      });
    }
    expect(after.supplementHistory).toHaveLength(3);
    expect(after.supplementHistory.filter(s => !before.supplementHistory.some(old => old.id === s.id)))
      .toEqual([expect.objectContaining({ supplementName: 'alanine', changeType: 'dose_changed' })]);
  });

  // US-06 AC1a: adding the same name updates its row, not a second history series.
  it('reuses the same custom name across repeated add, stop, restart and reload', async () => {
    await seed();
    const view = await page();
    addCustom(view.container, 'Taurine');
    dose(view.container, 'Taurine', 1, 'g');
    await settle();
    const before = await persisted();
    const original = before.supplements[0];
    // An active name is not offered again, as an active preset is not (US-06 AC1a).
    fireEvent.change(view.container.querySelector('.supplement-add input')!, { target: { value: ' taurine ' } });
    expect(view.container.querySelector('.supplement-custom')).toBeNull();
    fireEvent.change(view.container.querySelector('.supplement-add input')!, { target: { value: '' } });
    expect(view.container.querySelectorAll('.supplement-row')).toHaveLength(1);
    expect(row(view.container, 'Taurine').querySelector<HTMLInputElement>('.supplement-dose')!.value).toBe('1');
    dose(view.container, 'Taurine', 2, 'g');
    await settle();
    fireEvent.click(row(view.container, 'Taurine').querySelector('.supplement-remove')!);
    // The restart keeps the stored spelling (US-06 AC1a).
    addCustom(view.container, 'TAURINE');
    dose(view.container, 'Taurine', 3, 'g');
    await settle();
    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = await page();
    expect(reloaded.container.querySelectorAll('.supplement-row')).toHaveLength(1);
    dose(reloaded.container, 'Taurine', 4, 'g');
    await settle();
    const after = await persisted();
    expect(after.supplements).toEqual([expect.objectContaining({
      id: original.id, supplementKey: original.supplementKey, supplementName: 'Taurine', startedAt: original.startedAt,
      status: 'active', doseValue: 4, doseUnit: 'g',
    })]);
    expect(after.supplementHistory).toEqual(expect.arrayContaining(before.supplementHistory));
    expect(new Set(after.supplementHistory.map(s => s.supplementKey))).toEqual(new Set([original.supplementKey]));
    expect(after.supplementHistory.map(s => s.changeType)).toEqual(expect.arrayContaining(['stopped', 'dose_changed']));
    expect(after.supplementHistory.filter(s => s.changeType === 'started')).toHaveLength(2);
  });

  it('keeps noncolliding names on their existing normalized keys', async () => {
    await seed();
    const view = await page();
    addCustom(view.container, 'Taurine');
    dose(view.container, 'Taurine', 1, 'g');
    addCustom(view.container, "Lion's Mane");
    dose(view.container, "Lion's Mane", 500, 'mg');
    await settle();
    expect((await persisted()).supplements).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplementKey: 'custom_taurine', supplementName: 'Taurine', doseValue: 1, doseUnit: 'g' }),
      expect.objectContaining({ supplementKey: 'custom_lion_s_mane', supplementName: "Lion's Mane", doseValue: 500, doseUnit: 'mg' }),
    ]));
    expect((await persisted()).supplements).toHaveLength(2);
  });

  it('skips occupied suffixes while legacy row edits keep their IDs and keys', async () => {
    await seed();
    await saveSupplement('custom_alanine', 'β-alanine', 3, 'g');
    // A naturally normalized name can already own the proposed _2 suffix.
    await saveSupplement('custom_alanine_2', 'alanine 2', 100, 'mg');
    // Even a hidden stopped row loaded from storage must keep its identity.
    await saveSupplement('custom_alanine_3', 'alanine!', 200, 'mg', 'stopped');
    await flushRoadmapStore();
    const before = await persisted();
    const view = await page();
    await waitFor(() => expect(view.container.querySelectorAll('.supplement-row')).toHaveLength(2));
    addCustom(view.container, 'alanine');
    dose(view.container, 'alanine', 500, 'mg');
    dose(view.container, 'β-alanine', 4, 'g');
    await settle();
    const after = await persisted();
    expect(after.supplements).toHaveLength(4);
    expect(after.supplements.find(s => s.supplementKey === 'custom_alanine_4'))
      .toMatchObject({ supplementName: 'alanine', doseValue: 500, doseUnit: 'mg' });
    for (const old of before.supplements) {
      expect(after.supplements.find(s => s.supplementKey === old.supplementKey)).toMatchObject({
        id: old.id, supplementName: old.supplementName, doseUnit: old.doseUnit,
        doseValue: old.supplementName === 'β-alanine' ? 4 : old.doseValue,
        status: old.status, startedAt: old.startedAt,
      });
    }
    expect(after.supplementHistory.filter(s => !before.supplementHistory.some(old => old.id === s.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ supplementKey: 'custom_alanine', changeType: 'dose_changed' }),
        expect.objectContaining({ supplementKey: 'custom_alanine_4', changeType: 'started' }),
      ]));
  });

  it('preserves a stopped custom row when another name collides in the same page', async () => {
    await seed();
    await saveSupplement('custom_alanine', 'β-alanine', 3, 'g');
    await flushRoadmapStore();
    const original = (await persisted()).supplements[0];
    const view = await page();
    await waitFor(() => expect(view.container.querySelectorAll('.supplement-row')).toHaveLength(1));
    fireEvent.click(row(view.container, 'β-alanine').querySelector('.supplement-remove')!);
    addCustom(view.container, 'alanine');
    dose(view.container, 'alanine', 500, 'mg');
    await settle();
    const saved = await persisted();
    expect(saved.supplements).toHaveLength(2);
    expect(saved.supplements.find(s => s.id === original.id)).toMatchObject({
      supplementKey: 'custom_alanine', supplementName: 'β-alanine', doseValue: 3, doseUnit: 'g', status: 'stopped',
    });
    expect(saved.supplements.find(s => s.supplementName === 'alanine')).toMatchObject({ doseValue: 500, status: 'active' });
    expect(view.container.querySelectorAll('.supplement-row')).toHaveLength(1);
  });

  // US-06 AC1a: a remove right after a dose change must not be undone by the pending save.
  it('keeps a remove made within the dose save delay across reload', async () => {
    await seed();
    const view = await page();
    addCustom(view.container, 'Taurine');
    await settle();
    dose(view.container, 'Taurine', 2, 'g');
    fireEvent.click(row(view.container, 'Taurine').querySelector('.supplement-remove')!);
    await settle();
    expect((await persisted()).supplements).toEqual([expect.objectContaining({ supplementKey: 'custom_taurine', status: 'stopped' })]);
    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    const reloaded = await page();
    expect(reloaded.container.querySelectorAll('.supplement-row')).toHaveLength(0);
  });
});

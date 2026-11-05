// @vitest-environment jsdom
/** US-06 AC19: a double click on a featured supplement chip adds only that supplement.
 * The added chip leaves the row at once, so the next chip slides under the pointer and takes the
 * double click's second click. Real InputPanel -> HealthTool -> RoadmapStore -> localStorage path.
 * jsdom has no layout: "the chip under the pointer" is the chip at the same place in the row.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { flushRoadmapStore, saveSupplement } from '../lib/roadmap-data';
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
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1 }, [['weight', 80]]);
  // One saved supplement so the section is on screen, as in the dose tests.
  await saveSupplement('custom_test_supplement', 'Test supplement', null, null);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.supplement-chip')).not.toBeNull());
  return view;
}

const chips = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.supplement-chip')];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await flushRoadmapStore();
  });
}

async function activeKeys(): Promise<string[]> {
  const read = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
  const file = read.body as RoadmapFile;
  return file.supplements.filter(s => s.status === 'active').map(s => s.supplementKey).sort();
}

describe('US-06 AC19: a double click on a featured supplement chip adds only that chip', () => {
  it('the second click of a double click, landing on the chip that slid into place, adds nothing', async () => {
    const view = await page();
    const row = chips(view.container);
    expect(row.map(c => c.textContent)).toEqual([
      '+ Micronutrient base', '+ Creatine', '+ Collagen peptides', '+ Omega-3 (EPA/DHA)', '+ Sleep support',
    ]);
    // A browser double click: click (detail 1), click (detail 2), dblclick, all at one spot.
    fireEvent.click(row[0], { detail: 1 });
    const under = chips(view.container)[0];
    expect(under.textContent).toBe('+ Creatine'); // the next chip is now under the pointer
    fireEvent.click(under, { detail: 2 });
    fireEvent.dblClick(under, { detail: 2 });
    fireEvent.click(under, { detail: 3 }); // a triple click's third click adds nothing either
    await settle();
    expect(await activeKeys()).toEqual(['custom_test_supplement', 'microvitamin']);
    expect(chips(view.container).map(c => c.textContent)).toEqual([
      '+ Creatine', '+ Collagen peptides', '+ Omega-3 (EPA/DHA)', '+ Sleep support',
    ]);
  });

  it('a double click on a chip in the middle of the row adds only that chip', async () => {
    const view = await page();
    fireEvent.click(chips(view.container)[2], { detail: 1 }); // Collagen peptides
    fireEvent.click(chips(view.container)[2], { detail: 2 }); // now Omega-3
    await settle();
    expect(await activeKeys()).toEqual(['collagen', 'custom_test_supplement']);
  });

  it('separate single clicks and keyboard presses still add one chip each', async () => {
    const view = await page();
    fireEvent.click(chips(view.container)[0], { detail: 1 });
    await settle();
    fireEvent.click(chips(view.container)[0], { detail: 1 }); // a later, deliberate click
    await settle();
    fireEvent.click(chips(view.container)[0], { detail: 0 }); // Enter or Space on a focused chip
    await settle();
    expect(await activeKeys()).toEqual(['collagen', 'creatine', 'custom_test_supplement', 'microvitamin']);
    const read = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
    expect((read.body as RoadmapFile).supplements.find(s => s.supplementKey === 'creatine'))
      .toMatchObject({ doseValue: 5, doseUnit: 'g' });
  });
  it('a chip with no default dose (Omega-3) adds the supplement with its unit and no dose', async () => {
    const view = await page();
    fireEvent.click(chips(view.container)[3], { detail: 1 }); // Omega-3 (EPA/DHA)
    await settle();
    const read = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
    const omega = (read.body as RoadmapFile).supplements.find(s => s.supplementKey === 'omega3');
    expect(omega).toMatchObject({ status: 'active', doseUnit: 'mg' });
    expect(omega!.doseValue ?? null).toBeNull();
  });
});

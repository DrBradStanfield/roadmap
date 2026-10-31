// @vitest-environment jsdom
/**
 * US-07 AC7 (Brad 2026-10-27): the widget's plan, tiles and chat read the
 * lab's printed eGFR when it is newer than the creatinine, or from its day.
 * The whole widget renders over a real RoadmapStore on this browser's
 * localStorage; the form is a stub that hands back HealthTool's handlers, so
 * a test can lend a dated draft value as the blood-test matrix does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { buildChatContextJson, calculateEGFR, type ChatContextPayload, type HealthResults } from '@roadmap/health-core';
import { useHealthToolLifecycle } from '../testing/health-tool-harness';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, bulkSaveLabValues, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seen = vi.hoisted(() => ({ panel: null as null | Record<string, any>, results: null as HealthResults | null, chat: null as null | (() => ChatContextPayload | null) }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: ({ guestInputs }: { guestInputs: () => ChatContextPayload | null }) => { seen.chat = guestInputs; return null; } }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));
vi.mock('./InputPanel', () => ({ InputPanel: (props: Record<string, unknown>) => { seen.panel = props; return null; } }));
vi.mock('./ResultsPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ResultsPanel')>();
  return { ResultsPanel: (props: { results: HealthResults | null }) => { seen.results = props.results; return <real.ResultsPanel {...(props as Parameters<typeof real.ResultsPanel>[0])} />; } };
});

import { HealthTool } from './HealthTool';

const EGFR_UNIT = 'mL/min/1.73m²';

async function seed(creatinine: Array<[value: number, day: string]>, lab: [value: number, day: string]) {
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'female', heightCm: 165, birthYear: 1950, birthMonth: 1 }, {});
  await addMeasurement('weight', 70, lab[1]);
  for (const [value, day] of creatinine) await addMeasurement('creatinine', value, day);
  await bulkSaveLabValues([{ metricName: 'eGFR', value: lab[0], unit: EGFR_UNIT, recordedAt: `${lab[1]}T00:00:00.000Z` }]);
  await flushRoadmapStore();
}

const eGFRTile = (container: HTMLElement) => Array.from(container.querySelectorAll('.stat-card'))
  .find((c) => c.querySelector('.stat-label')?.textContent === 'eGFR')?.querySelector('.stat-value')?.textContent;
const chatEGFR = () => JSON.parse(buildChatContextJson(seen.chat!()!)!).derivedValues.eGFR;

useHealthToolLifecycle();
beforeEach(() => { seen.panel = null; seen.results = null; seen.chat = null; });

describe('US-07 AC7: the widget reads the lab eGFR', () => {
  it('US-07 AC7: a misread creatinine (15 µmol/L) saved on the lab eGFR\'s day: tile 40, protein 1.0 g/kg, no high-potassium card, chat eGFR 40', async () => {
    await seed([[15, '2026-09-01']], [40, '2026-09-01']);
    const view = render(<HealthTool />);
    await waitFor(() => expect(seen.results?.eGFR).toBe(40));
    const results = seen.results!;
    expect(eGFRTile(view.container)).toContain('40');
    expect(results.proteinTarget).toBe(Math.round(results.idealBodyWeight! * 1.0));
    expect(results.suggestions.map((s) => s.id)).not.toContain('high-potassium');
    await waitFor(() => expect(seen.chat).toBeTruthy());
    expect(chatEGFR()).toBe(40);
  });

  it('US-07 AC7: a draft creatinine counts on the day it is dated, not today', async () => {
    // Saved creatinine before the lab eGFR; a draft dated between them; then one dated after.
    await seed([[80, '2026-06-01']], [40, '2026-08-01']);
    render(<HealthTool />);
    await waitFor(() => expect(seen.results?.eGFR).toBe(40));

    act(() => seen.panel!.onDraftValue('creatinine', 80, '2026-07-01'));
    await waitFor(() => expect(seen.results?.eGFR).toBe(40));

    act(() => seen.panel!.onDraftValue('creatinine', 80, '2026-08-15'));
    const age = seen.results!.age!;
    await waitFor(() => expect(seen.results?.eGFR).toBe(Math.round(calculateEGFR(80, age, 'female'))));
    expect(seen.results?.eGFRFromLab).toBeUndefined();
  });
});

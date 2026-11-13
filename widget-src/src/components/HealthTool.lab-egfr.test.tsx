// @vitest-environment jsdom
/**
 * US-07 AC7 (Brad 2026-10-27): the widget's plan, tiles and chat read the
 * lab's printed eGFR when it is newer than the creatinine, or from its day.
 * The whole widget renders over a real RoadmapStore on this browser's
 * localStorage; the form is a stub that hands back HealthTool's handlers,
 * or the real form when a test types into its blood-test grid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';
import { buildChatContextJson, type ChatContextPayload } from '@roadmap/health-core/chat-context';
import { calculateEGFR } from '@roadmap/health-core/calculations';
import type { HealthResults } from '@roadmap/health-core/types';
import { useHealthToolLifecycle } from '../testing/health-tool-harness';
import { pickDraftDate, typeInto } from '../testing/matrix-gestures';
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
const seen = vi.hoisted(() => ({ panel: null as null | Record<string, any>, results: null as HealthResults | null, tiles: [] as Array<{ label: string; value: string }>, chat: null as null | (() => ChatContextPayload | null), realPanel: false }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: ({ guestInputs }: { guestInputs: () => ChatContextPayload | null }) => { seen.chat = guestInputs; return null; } }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));
vi.mock('./InputPanel', async (importOriginal) => {
  const { InputPanel: Real } = await importOriginal<typeof import('./InputPanel')>();
  return { InputPanel: (props: Parameters<typeof Real>[0]) => { seen.panel = props; return seen.realPanel ? <Real {...props}/> : null; } };
});
vi.mock('./ResultsPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ResultsPanel')>();
  // The plan My health draws (US-62 phase 5): what usePlanView is given.
  return { ...real, usePlanView: (options: Parameters<typeof real.usePlanView>[0]) => { seen.results = options.results; seen.tiles = options.tiles; return real.usePlanView(options); } };
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

// The eGFR tile the plan hands My health (on the creatinine page since US-62 AC26).
const eGFRTile = (_container: HTMLElement) => seen.tiles
  ?.find((t) => t.label === 'eGFR')?.value;
const chatEGFR = () => JSON.parse(buildChatContextJson(seen.chat!()!)!).derivedValues.eGFR;

useHealthToolLifecycle();
beforeEach(() => { seen.panel = null; seen.results = null; seen.chat = null; seen.realPanel = false; });

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

  it('US-07 AC7: a creatinine typed in the grid moves the eGFR only once saved, dated by its saved day', async () => {
    // Saved creatinine before the lab eGFR; one typed and dated after it.
    await seed([[80, '2026-06-01']], [40, '2026-08-01']);
    seen.realPanel = true;
    const view = render(<HealthTool />);
    await waitFor(() => expect(seen.results?.eGFR).toBe(40));
    const matrix = () => view.container.querySelector('.bt-timeline-title')!.closest('.bt-timeline') as HTMLElement;
    const cell = () => [...matrix().querySelectorAll('.bt-row')]
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Creatinine')!.querySelector('.bt-cell-draft input') as HTMLInputElement;
    await waitFor(() => expect(matrix()).toBeTruthy());
    pickDraftDate(matrix(), '2026-08-15');
    typeInto(cell(), '80');
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(seen.results?.eGFR).toBe(40); // typed, not saved: the lab's eGFR still stands
    expect(seen.results?.eGFRFromLab).toBe(true);

    fireEvent.keyDown(cell(), { key: 'Enter' }); // saved on 15 Aug, after the lab's day
    const age = seen.results!.age!;
    await waitFor(() => expect(seen.results?.eGFR).toBe(Math.round(calculateEGFR(80, age, 'female'))));
    expect(seen.results?.eGFRFromLab).toBeUndefined();
  });
});

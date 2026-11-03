// @vitest-environment jsdom
/**
 * US-06 AC14 on the web: the plan HealthTool draws reads the saved PSA
 * measurement. The web computes its plan itself (calculateHealthResults over
 * the form's inputs and screenings), not through computePlan, so it needs the
 * same rule as the iPhone and get_plan. A man who will screen, with a saved
 * PSA of 6.5 ng/mL (as a lab upload or the assistant files it), sees "Elevated
 * PSA" and the PSA-due card. Control: the old screening answers still work.
 * The whole HealthTool renders over the real RoadmapStore on jsdom's
 * localStorage; synthetic data only.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { buildChatContextJson, localDay } from '@roadmap/health-core';
import { loadGuestInputs } from '../lib/storage';
import { addMeasurement, flushRoadmapStore, saveScreening } from '../lib/roadmap-data';
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

/** A man born 1960, height on record, one saved HbA1c, who said he will have PSA screening. */
async function plan(answers: Array<[string, string]>, psa?: [number, string], ...more: Array<[number, string]>) {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1, unitSystem: 'si' }, [['hba1c', 40]]);
  await saveScreening('prostate_discussion', 'will_screen');
  for (const [k, v] of answers) await saveScreening(k, v);
  for (const [value, day] of psa ? [psa, ...more] : []) expect((await addMeasurement('psa', value, day)).status).toBe('inserted');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.suggestion-title')).not.toBeNull());
  return view;
}

// Dated today, so the card reads "up to date" whatever day the suite runs.
const TODAY = localDay(new Date());
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NEXT_DUE = `Next PSA test due ${MONTHS[Number(TODAY.slice(5, 7)) - 1]} ${Number(TODAY.slice(0, 4)) + 1}.`;

const titles = (root: HTMLElement) => [...root.querySelectorAll('.suggestion-title')].map(t => t.textContent);

describe('the web plan reads the saved PSA measurement (US-06 AC14)', () => {
  it('a saved PSA of 6.5 shows "Elevated PSA", and no "up to date" beside it (US-06 AC17, Brad 2026-11-03)', async () => {
    const view = await plan([], [6.5, TODAY]);
    await waitFor(() => expect(titles(view.container)).toContain('Elevated PSA'));
    expect(titles(view.container)).not.toContain('PSA test up to date');
    expect(view.container.textContent).toContain('Your PSA of 6.5 ng/mL');
    expect(view.container.textContent).not.toContain(NEXT_DUE);
    view.unmount();
  });

  it('a saved PSA of 4.04 prints 4.04 on the card (US-06 AC18, Brad 2026-11-03)', async () => {
    const view = await plan([], [4.04, TODAY]);
    await waitFor(() => expect(titles(view.container)).toContain('Elevated PSA'));
    expect(view.container.textContent).toContain('Your PSA of 4.04 ng/mL');
    view.unmount();
  });

  it('a saved PSA of 2.1 shows the PSA-due card and no "Elevated PSA"', async () => {
    const view = await plan([], [2.1, TODAY]);
    await waitFor(() => expect(titles(view.container)).toContain('PSA test up to date'));
    expect(titles(view.container)).not.toContain('Elevated PSA');
    expect(view.container.textContent).toContain(NEXT_DUE);
    view.unmount();
  });

  it('control: the old prostate_psa_value / prostate_last_date answers still drive the cards', async () => {
    const view = await plan([['prostate_psa_value', '6.5'], ['prostate_last_date', '2025-01']]);
    await waitFor(() => expect(titles(view.container)).toContain('Elevated PSA'));
    expect(titles(view.container)).toContain('PSA test overdue');
    view.unmount();
  });

  it('a newer PSA dated after today never hides an older 6.5: the web plan reads the newest usable one', async () => {
    const view = await plan([], [6.5, TODAY], [3.0, '2099-01-01']);
    await waitFor(() => expect(titles(view.container)).toContain('Elevated PSA'));
    expect(view.container.textContent).toContain('Your PSA of 6.5 ng/mL');
    view.unmount();
  });

  it('the blog and embed chats (the mirror) read the same usable PSA: a newer one dated after today never hides the 6.5 (Codex re-check R1)', async () => {
    const view = await plan([], [6.5, TODAY], [3.0, '2099-01-01']);
    await waitFor(() => expect(titles(view.container)).toContain('Elevated PSA'));
    const context = JSON.parse(buildChatContextJson(loadGuestInputs())!);
    expect(context.currentSuggestions.map((s: { id: string }) => s.id)).toContain('screening-prostate-elevated');
    // The snapshot the model reads names the same PSA as the card (Codex re-check R1).
    expect(context.latestValues.psa).toBe('6.5');
    view.unmount();
  });
});


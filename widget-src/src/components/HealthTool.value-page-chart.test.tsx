// @vitest-environment jsdom
// US-62 AC10c through the whole widget: opening Settings renders HealthTool
// again with the record unchanged, and the open value page keeps its chart. The chart library is a stand-in that counts charts made. Synthetic values.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { openSettings, settingsShown } from '../testing/settings';

const chart = vi.hoisted(() => ({ made: 0, destroyed: 0 }));
vi.mock('chart.js', () => ({
  Chart: class {
    static register() {}
    options: unknown;
    constructor(_canvas: unknown, config: { options: unknown }) { chart.made++; this.options = config.options; }
    destroy() { chart.destroyed++; }
    update() {}
  },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

describe('US-62 AC10c: a widget render that changes nothing keeps the value page chart', () => {
  it('opening Settings leaves the LDL page chart as it was drawn', async () => {
    await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1, unitSystem: 'si' }, [['ldl', 3]]);
    const view = render(<HealthTool/>);
    const ldlRow = await waitFor(() => {
      const r = [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === 'LDL Cholesterol');
      expect(r).toBeDefined();
      return r!;
    });
    fireEvent.click(ldlRow);
    await waitFor(() => expect(chart.made).toBe(1), { timeout: 10_000 });
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(chart.made).toBe(1);
    openSettings();
    expect(settingsShown()).toBe(true);
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(chart.made).toBe(1);
    expect(chart.destroyed).toBe(0);
    expect(view.container.querySelector('.mh-page-host .md-page')).not.toBeNull();
  });
});

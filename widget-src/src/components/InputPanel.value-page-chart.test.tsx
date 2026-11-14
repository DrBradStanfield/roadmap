// @vitest-environment jsdom
/**
 * US-62 AC10c (US-06 AC4a on the value page): a render that does not re-read
 * the record, such as opening Settings, no longer draws the value page's chart
 * again. HealthTool hands InputPanel a fresh props object on every render, and
 * InputPanel built the page's history as a new array each time, so such a
 * render destroyed the chart and drew it again with its draw-in animation.
 * A save, a remote change or the upload window re-reads the record, sets new
 * lists and still draws it again; these tests do not cover those.
 * The chart library is a stand-in that counts charts made. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';

const chart = vi.hoisted(() => ({ made: [] as { data: { datasets: { data: unknown[] }[] } }[], destroyed: 0 }));
vi.mock('chart.js', () => ({
  Chart: class {
    static register() {}
    options: unknown;
    constructor(_canvas: unknown, config: { options: unknown; data: { datasets: { data: unknown[] }[] } }) { chart.made.push(config); this.options = config.options; }
    destroy() { chart.destroyed++; }
    update() {}
  },
  LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {},
}));
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABConversion: vi.fn(), trackProductEvent: vi.fn(),
}));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));

import { InputPanel } from './InputPanel';
import { MY_HEALTH_PROPS } from '../testing/my-health-props';

const row = (id: string, metricType: string, value: number, day: string) =>
  ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, source: 'manual' }) as ApiMeasurement;
const LDL = [row('l2', 'ldl', 3.1, '2026-07-01'), row('l1', 'ldl', 2.8, '2026-06-01')];
const WEIGHT = [row('w1', 'weight', 80, '2026-06-01')];
const inputs = { sex: 'male' as const, heightCm: 180, weightKg: 80, birthYear: 1980, birthMonth: 1 };

/** InputPanel's props as HealthTool builds them: a fresh object, with fresh callbacks, every render. */
const panelProps = (bloodTestHistory: ApiMeasurement[], vitalsHistory: ApiMeasurement[], labValues: unknown[] = NO_LABS) => ({
  ...MY_HEALTH_PROPS,
  inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si' as const,
  unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory, vitalsHistory,
  labValues, onSaveBloodTestBatch: vi.fn(async () => new Map()), medications: [],
  onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
  onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
  hasApiResponse: true, onboarding: { stage: 3 as const, reached: 3 as const, fullForm: true, aboutYouLow: false }, planBasis: {}, grading: {},
}) as unknown as Parameters<typeof InputPanel>[0];
const NO_LABS: unknown[] = [];

const settled = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });

async function openPage(view: RenderResult, label: string, points: number) {
  const row = await waitFor(() => {
    const r = [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === label);
    expect(r).toBeDefined();
    return r!;
  });
  fireEvent.click(row);
  await waitFor(() => expect(chart.made).toHaveLength(1), { timeout: 10_000 });
  expect(chart.made[0].data.datasets[0].data).toHaveLength(points);
}
const openLdlPage = (view: RenderResult) => openPage(view, 'LDL Cholesterol', 2);

afterEach(() => { cleanup(); chart.made.length = 0; chart.destroyed = 0; });

describe('US-62 AC10c: the value page chart is drawn again only when what it shows changes', () => {
  it('a parent render with the same record keeps the chart: none destroyed, none made', async () => {
    const view = render(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await openLdlPage(view);
    view.rerender(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    view.rerender(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await settled();
    expect(chart.made).toHaveLength(1);
    expect(chart.destroyed).toBe(0);
  });

  it('a new blood test value draws the chart again, with the new point', async () => {
    const view = render(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await openLdlPage(view);
    view.rerender(<InputPanel {...panelProps([row('l3', 'ldl', 2.5, '2026-08-01'), ...LDL], WEIGHT)} />);
    await waitFor(() => expect(chart.made).toHaveLength(2));
    expect(chart.made[1].data.datasets[0].data).toHaveLength(3);
    expect(chart.destroyed).toBe(1);
  });

  it('a re-read that brings a new vitals list draws it again, as the page reads one merged history', async () => {
    const view = render(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await openLdlPage(view);
    view.rerender(<InputPanel {...panelProps(LDL, [...WEIGHT])} />);
    await waitFor(() => expect(chart.made).toHaveLength(2));
    expect(chart.made[1].data.datasets[0].data).toHaveLength(2);
  });

  it('the weight page reads the vitals list and keeps its chart the same way', async () => {
    const view = render(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await openPage(view, 'Weight', 1);
    view.rerender(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await settled();
    expect(chart.made).toHaveLength(1);
  });

  it('a new lab list draws it again, as before', async () => {
    const view = render(<InputPanel {...panelProps(LDL, WEIGHT)} />);
    await openLdlPage(view);
    view.rerender(<InputPanel {...panelProps(LDL, WEIGHT, [])} />);
    await waitFor(() => expect(chart.made).toHaveLength(2));
  });
});

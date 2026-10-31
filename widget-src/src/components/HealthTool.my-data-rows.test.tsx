// @vitest-environment jsdom
/**
 * US-62 AC8-AC12, the phone's My data as the person sees the whole widget:
 * one row per value ("target · date", the trend, "81 (74)" over the unit),
 * each opening its value page (chart, history, Add, Correct); the grids one
 * tap away as "All results as a table"; About you low once sex and height are
 * in. Desktop keeps the grids, with the same text (rowTarget is their source too).
 * The saves are read back from the record file itself, so the FHIR rules
 * (never mutate; a correction appends with correctsId and flips the old row)
 * are checked where they live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, bulkSaveLabValues, correctValue, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

vi.mock('chart.js', () => {
  class Chart { static register() {} destroy() {} update() {} }
  return { Chart, LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {} };
});
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
import { HealthTool } from './HealthTool';
import { trackProductEvent } from '../lib/server-api';

const stops: Array<() => void> = [];
let phone = true;

beforeEach(async () => {
  phone = true;
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q.includes('max-width') ? phone : !phone; }, media: q,
    addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  // jsdom keeps one history for the file: let a pending back land, then start the next test on a plain entry.
  await new Promise(r => setTimeout(r, 20));
  history.replaceState(null, '');
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** A man of 51, 178 cm: LDL on two days, HbA1c on one, weight and a pressure on two, sodium with its printed range, vitamin D without one. */
async function seed(profile: Record<string, unknown> = { sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5 }) {
  await saveChangedMeasurements({ ...profile, unitSystem: 'si' }, {});
  for (const [metric, value, day] of [
    ['ldl', 2.9, '2026-04-02'], ['ldl', 3.4, '2026-10-12'], ['hba1c', 36, '2026-10-12'],
    ['weight', 84, '2026-09-20'], ['weight', 81, '2026-10-20'],
    ['systolic_bp', 132, '2026-09-20'], ['diastolic_bp', 84, '2026-09-20'],
    ['systolic_bp', 126, '2026-10-20'], ['diastolic_bp', 80, '2026-10-20'],
  ] as const) await addMeasurement(metric, value, `${day}T00:00:00.000Z`);
  await bulkSaveLabValues([
    { metricName: 'sodium', value: 139, unit: 'mmol/L', referenceLow: 135, referenceHigh: 145, recordedAt: '2026-10-12T00:00:00.000Z', source: 'manual' },
    { metricName: 'vitamin_d', value: 72, unit: 'nmol/L', recordedAt: '2026-10-12T00:00:00.000Z', source: 'manual' },
  ]);
  await flushRoadmapStore();
}

/** The record's own rows, as stored. */
function fileRows(metric: string) {
  const file = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
  return (file.measurements as Array<{ id: string; metricType: string; value: number; recordedAt: string; status: string; correctsId: string | null }>)
    .filter(r => r.metricType === metric);
}

async function renderTool() {
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector(phone ? '.md-row' : '.bt-timeline-title')).not.toBeNull());
  return view;
}
const row = (view: ReturnType<typeof render>, name: string) =>
  [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.querySelector('.md-row-label')?.textContent === name)!;

describe('US-62 AC8: one row per value on a phone', () => {
  it('name over "target · date"; the latest value with the previous in brackets over its unit; heard as "3.4, previous 2.9"', async () => {
    await seed();
    const view = await renderTool();
    const ldl = row(view, 'LDL Cholesterol');
    expect(ldl.querySelector('.md-row-meta')!.textContent).toBe('Optimal <1.4 · Oct 2026');
    expect(ldl.querySelector('.md-row-value')!.textContent).toBe('3.4 (2.9)');
    expect(ldl.querySelector('.md-row-value')!.getAttribute('aria-hidden')).toBe('true');
    expect(ldl.querySelector('.hr-sr-only')!.textContent).toBe('3.4, above optimal, previous 2.9');
    expect(ldl.querySelector('.md-row-unit')!.textContent).toBe('mmol/L');
    expect(ldl.querySelector('svg.md-row-trend path')).not.toBeNull();
    // Graded as the grid grades it, in a class the breadcrumb scrub drops.
    expect(ldl.querySelector('.md-row-latest')!.className).toContain('md-status-warn');

    const bp = row(view, 'Blood Pressure');
    expect(bp.querySelector('.md-row-value')!.textContent).toBe('126/80 (132/84)');
    expect(bp.querySelector('.md-row-meta')!.textContent).toBe('Target <120/80 · Oct 2026');
    expect(row(view, 'Weight').querySelector('.md-row-meta')!.textContent).toMatch(/^Target \d+\.\d · Oct 2026$/);
    expect(row(view, 'Sodium').querySelector('.md-row-meta')!.textContent).toBe('Ref 135–145 · Oct 2026');
  });

  it('a first result shows the value alone; a test with no target shows the date alone; a test with no value says Add', async () => {
    await seed();
    const view = await renderTool();
    const hba1c = row(view, 'HbA1c');
    expect(hba1c.querySelector('.md-row-value')!.textContent).toBe('36');
    expect(hba1c.querySelector('.hr-sr-only')!.textContent).toBe('36, in range');
    expect(hba1c.querySelector('svg.md-row-trend')).toBeNull();
    expect(row(view, 'Vitamin D (25-OH)').querySelector('.md-row-meta')!.textContent).toBe('Oct 2026');
    const apob = row(view, 'ApoB');
    expect(apob.querySelector('.md-row-add')!.textContent).toBe('Add');
    expect(apob.querySelector('.md-row-meta')!.textContent).toBe('Optimal <0.50');
  });

  it('a known minor: no adult targets on the rows, the waist target stays (US-07 AC6)', async () => {
    const year = new Date().getFullYear() - 12;
    await seed({ sex: 'male', heightCm: 150, birthYear: year, birthMonth: 1 });
    await addMeasurement('waist', 70, '2026-10-20T00:00:00.000Z');
    await flushRoadmapStore();
    const view = await renderTool();
    expect(row(view, 'LDL Cholesterol').querySelector('.md-row-meta')!.textContent).toBe('Oct 2026');
    expect(row(view, 'Weight').querySelector('.md-row-meta')!.textContent).toBe('Oct 2026');
    expect(row(view, 'Blood Pressure').querySelector('.md-row-meta')!.textContent).toBe('Oct 2026');
    expect(row(view, 'Waist').querySelector('.md-row-meta')!.textContent).toBe('Target <75 · Oct 2026');
  });
});

describe('US-62 AC10: the value page', () => {
  it('a tap opens it: the target, the chart, the history newest first; Back returns to the rows', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect(within(page).getByRole('heading', { name: 'LDL Cholesterol' })).toBeTruthy();
    expect(page.querySelector('.md-page-target')!.textContent).toBe('Optimal: <1.4 mmol/L');
    expect(view.container.querySelector('.health-input-panel')!.className).toContain('md-page-open');
    expect([...page.querySelectorAll('.md-history-row')].map(r => r.textContent)).toEqual([
      expect.stringContaining('3.4'), expect.stringContaining('2.9'),
    ]);
    await waitFor(() => expect(page.querySelector('canvas')).not.toBeNull());
    fireEvent.click(within(page).getByRole('button', { name: '‹ My data' }));
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
    expect(view.container.querySelector('.health-input-panel')!.className).not.toContain('md-page-open');
  });

  it('Add on a new day appends one active row, in the unit typed', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    fireEvent.change(page.querySelector('input[type="date"]')!, { target: { value: '2026-10-30' } });
    fireEvent.change(within(page).getByLabelText(/Value/), { target: { value: '2.2' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fileRows('ldl')).toHaveLength(3));
    await flushRoadmapStore();
    const added = fileRows('ldl').find(r => r.recordedAt.startsWith('2026-10-30'))!;
    expect(added).toMatchObject({ value: 2.2, status: 'active', correctsId: null });
    expect(fileRows('ldl').filter(r => r.status === 'active')).toHaveLength(3);
    await waitFor(() => expect(row(view, 'LDL Cholesterol').querySelector('.md-row-value')!.textContent).toBe('2.2 (3.4)'));
    // No health value in any event.
    for (const [, meta] of vi.mocked(trackProductEvent).mock.calls) expect(JSON.stringify(meta ?? {})).not.toMatch(/2\.2|3\.4/);
  });

  it('Add on a day that holds a value corrects it: the old row is flipped, a new row names it, one active row that day', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    fireEvent.change(page.querySelector('input[type="date"]')!, { target: { value: '2026-10-12' } });
    expect(page.querySelector('.md-add-note')!.textContent).toBe('This day has 3.4 mmol/L already. Saving corrects it.');
    fireEvent.change(within(page).getByLabelText(/Value/), { target: { value: '3.1' } });
    const old = fileRows('ldl').find(r => r.recordedAt.startsWith('2026-10-12'))!;
    fireEvent.click(within(page).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(fileRows('ldl')).toHaveLength(3));
    const day = fileRows('ldl').filter(r => r.recordedAt.startsWith('2026-10-12'));
    expect(day.find(r => r.id === old.id)).toMatchObject({ value: 3.4, status: 'entered-in-error' });
    expect(day.find(r => r.id !== old.id)).toMatchObject({ value: 3.1, status: 'active', correctsId: old.id });
  });

  it('a blood pressure on a held day corrects both halves; one changed meanwhile on another device is refused, nothing written', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Blood Pressure'));
    let page = view.container.querySelector<HTMLElement>('.md-page')!;
    fireEvent.click(within(page).getAllByRole('button', { name: /Correct the reading/ })[0]);
    page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect((page.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-10-20');
    expect((within(page).getByLabelText('Systolic (top number)') as HTMLInputElement).value).toBe('126');

    // Another writer replaces the systolic of that day before Save.
    const sys = fileRows('systolic_bp').find(r => r.recordedAt.startsWith('2026-10-20'))!;
    expect(await correctValue(sys.id, 128)).toBe('ok');
    await flushRoadmapStore();
    const before = JSON.stringify([fileRows('systolic_bp'), fileRows('diastolic_bp')]);
    fireEvent.change(within(page).getByLabelText('Diastolic (bottom number)'), { target: { value: '78' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(within(page).getByRole('alert').textContent).toBe('This value changed on another device, so your edit was not saved.'));
    await flushRoadmapStore();
    expect(JSON.stringify([fileRows('systolic_bp'), fileRows('diastolic_bp')])).toBe(before);
  });

  it('a reading the wrong way up is refused before it is sent (US-02 AC8)', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Blood Pressure'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    fireEvent.change(within(page).getByLabelText('Systolic (top number)'), { target: { value: '80' } });
    fireEvent.change(within(page).getByLabelText('Diastolic (bottom number)'), { target: { value: '90' } });
    const rows = fileRows('systolic_bp').length;
    fireEvent.click(within(page).getByRole('button', { name: 'Add' }));
    expect(within(page).getByRole('alert').textContent).toMatch(/top number/);
    expect(fileRows('systolic_bp')).toHaveLength(rows);
  });

  it('Correct in the history is the grids\' saved-value editor: a FHIR correction', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Weight'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    const old = fileRows('weight').find(r => r.recordedAt.startsWith('2026-10-20'))!;
    fireEvent.click(page.querySelector('.md-history-row .bt-cell-clickable')!);
    const input = page.querySelector<HTMLInputElement>('.md-history-row input')!;
    fireEvent.change(input, { target: { value: '80.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fileRows('weight').find(r => r.correctsId === old.id)).toMatchObject({ value: 80.5, status: 'active' }));
    expect(fileRows('weight').find(r => r.id === old.id)!.status).toBe('entered-in-error');
  });

  it('a lab test\'s page adds through the grid\'s own form, the test fixed; its day rule offers Replace', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Sodium'));
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect(page.querySelector('.md-page-target')!.textContent).toBe('Ref: 135–145');
    fireEvent.click(within(page).getByRole('button', { name: '+ Add a value' }));
    expect(within(page).queryByLabelText('Test')).toBeNull();
    fireEvent.change(within(page).getByLabelText('Value'), { target: { value: '141' } });
    fireEvent.change(within(page).getByLabelText('Date'), { target: { value: '2026-10-12' } });
    fireEvent.click(within(page).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(page.textContent).toContain('That test already has 139 mmol/L for that date.'));
    expect(within(page).getByRole('button', { name: /^Replace 139 mmol\/L with 141$/ })).toBeTruthy();
  });
});

describe('US-62 AC11: All results as a table', () => {
  it('the grids stay mounted but hidden under the rows; the button shows them, Show as rows hides them', async () => {
    await seed();
    const view = await renderTool();
    const tables = () => [...view.container.querySelectorAll<HTMLElement>('.md-table')];
    expect(tables().length).toBe(2); // vitals and blood tests
    expect(tables().every(t => t.hidden)).toBe(true);
    // Each card the table reveals has its own way back (a chat edit can reveal the vitals alone).
    expect(tables().every(t => within(t).queryByRole('button', { name: '‹ Show as rows', hidden: true }))).toBe(true);
    expect(view.container.querySelector('.md-table .bt-timeline')).not.toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'All results as a table' }));
    expect(tables().every(t => !t.hidden)).toBe(true);
    expect(view.container.querySelector('.md-row')).toBeNull();
    // Every result on every date: the seeded LDL days are both columns.
    expect(view.container.querySelectorAll('.md-table .bt-header-row').length).toBeGreaterThan(0);
    expect(view.getByText('+ Add a blood test')).toBeTruthy();
    fireEvent.click(within(tables()[1]).getByRole('button', { name: '‹ Show as rows' }));
    expect(tables().every(t => t.hidden)).toBe(true);
    expect(row(view, 'LDL Cholesterol')).toBeTruthy();
  });
});

describe('US-62 AC12: About you low on a phone', () => {
  const sectionOrder = (view: ReturnType<typeof render>) =>
    [...view.container.querySelectorAll('.health-input-panel h3')].map(h => h.textContent!.replace('▸', '').trim())
      .filter(t => ['Vitals', 'Blood tests', 'Supplements', 'About you', 'Starting Info'].includes(t));

  it('with sex and height in, About you follows the iPhone: after the sections, not first', async () => {
    await seed();
    const view = await renderTool();
    expect(sectionOrder(view)).toEqual(['Vitals', 'Blood tests', 'Supplements', 'About you']);
  });

  it('while sex or height is missing, it stays first, as Starting Info, so a new user can start', async () => {
    await seed({ birthYear: 1975, birthMonth: 5 });
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.health-section-title')).not.toBeNull());
    expect(sectionOrder(view)[0]).toBe('Starting Info');
    expect(sectionOrder(view)).not.toContain('About you');
  });
});

describe('US-62 AC9: desktop keeps the grids, with the same text', () => {
  it('no rows; the grids\' hints and targets read exactly as before rowTarget', async () => {
    phone = false;
    await seed();
    // A first visit fills the device's mirror; the second opens the vitals grid, as a returning visit does.
    await renderTool();
    cleanup();
    const view = await renderTool();
    await waitFor(() => expect(view.container.querySelector('.bt-row[data-metric] ~ .bt-row, .bt-timeline .bt-ref-label')).not.toBeNull());
    expect(view.container.querySelector('.md-row')).toBeNull();
    expect(view.container.querySelector('.md-table')).toBeNull();
    const refs = (selector: string) => [...view.container.querySelectorAll(`${selector} .bt-ref-label`)].map(e => e.textContent);
    expect(refs('.bt-timeline:not(.alr-matrix)').filter(t => t !== 'Units vary between reports')).toEqual(expect.arrayContaining([
      'Normal: <39 mmol/mol', 'Normal: 60–110 µmol/L', 'Optimal: <0.50 g/L', 'Optimal: <1.4 mmol/L',
      'Optimal: <3.5 mmol/L', 'Optimal: >1.0 mmol/L', 'Normal: <1.7 mmol/L', 'Normal: <75 nmol/L',
      'Target: <120/80 mmHg', 'Target: <89 cm',
    ]));
    expect(refs('.bt-timeline:not(.alr-matrix)').some(t => /^Target: \d+\.\d kg$/.test(t!))).toBe(true);
  });
});


/** Another writer's row lands in the store and the page re-reads it, as a sync or the connector does. */
async function remoteWrite(write: () => Promise<unknown>) {
  await write();
  await flushRoadmapStore();
  window.dispatchEvent(new Event('hr:remote-changed'));
}
const page = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>('.md-page')!;

describe('US-62 AC10 review fixes: what Add expects is frozen when entry begins (US-03 AC8)', () => {
  it('an empty day another device fills while a value is typed: refused, nothing written, its value untouched', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(page(view).querySelector('input[type="date"]')!, { target: { value: '2026-10-30' } });
    fireEvent.change(within(page(view)).getByLabelText(/Value/), { target: { value: '2.2' } });
    await remoteWrite(() => addMeasurement('ldl', 5.0, '2026-10-30T00:00:00.000Z'));
    await waitFor(() => expect(page(view).querySelector('.md-history')!.textContent).toContain('5.0'));
    fireEvent.click(within(page(view)).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(page(view)).getByRole('alert').textContent).toBe('This value changed on another device, so your edit was not saved.'));
    await flushRoadmapStore();
    expect(fileRows('ldl').filter(r => r.recordedAt.startsWith('2026-10-30')).map(r => [r.value, r.status, r.correctsId]))
      .toEqual([[5.0, 'active', null]]);
  });

  it('a blood pressure on an empty day, its systolic filled elsewhere while typed: refused, nothing written', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Blood Pressure'));
    fireEvent.change(page(view).querySelector('input[type="date"]')!, { target: { value: '2026-10-29' } });
    fireEvent.change(within(page(view)).getByLabelText('Systolic (top number)'), { target: { value: '124' } });
    fireEvent.change(within(page(view)).getByLabelText('Diastolic (bottom number)'), { target: { value: '78' } });
    await remoteWrite(() => addMeasurement('systolic_bp', 140, '2026-10-29T00:00:00.000Z'));
    await waitFor(() => expect(fileRows('systolic_bp').some(r => r.recordedAt.startsWith('2026-10-29'))).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    fireEvent.click(page(view).querySelector('.md-add-save')!);
    await waitFor(() => expect(within(page(view)).getByRole('alert').textContent).toMatch(/changed on another device/));
    await flushRoadmapStore();
    expect(fileRows('systolic_bp').filter(r => r.recordedAt.startsWith('2026-10-29')).map(r => [r.value, r.status])).toEqual([[140, 'active']]);
    expect(fileRows('diastolic_bp').filter(r => r.recordedAt.startsWith('2026-10-29'))).toEqual([]);
  });

  it('the same number again on a held day writes nothing and says "No change."', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(page(view).querySelector('input[type="date"]')!, { target: { value: '2026-10-12' } });
    fireEvent.change(within(page(view)).getByLabelText(/Value/), { target: { value: '3.40' } });
    const before = JSON.stringify(fileRows('ldl'));
    fireEvent.click(within(page(view)).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(page(view).querySelector('.md-page-messages')!.textContent).toBe('No change.'));
    await flushRoadmapStore();
    expect(JSON.stringify(fileRows('ldl'))).toBe(before);
  });
});

describe('US-62 AC10 review fixes: unit and erase', () => {
  it('Lp(a)\'s unit changing under typed text clears it and says so; nothing saves in the new unit (US-05 AC2)', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'Lp(a)'));
    fireEvent.change(within(page(view)).getByLabelText(/Value/), { target: { value: '50' } });
    // The unit chosen elsewhere: the grid's control, which writes the record's choice.
    const control = [...view.container.querySelectorAll<HTMLButtonElement>('.md-table button')].find(b => b.textContent === 'mg/dL')!;
    fireEvent.click(control);
    await waitFor(() => expect(within(page(view)).getByRole('alert').textContent).toBe('The unit changed, so your value was not saved. Type it again in the new unit.'));
    expect((within(page(view)).getByLabelText(/Value/) as HTMLInputElement).value).toBe('');
    expect(fileRows('lpa')).toHaveLength(0);
  });

  it('an erase while a value page holds typed text closes the page and drops it', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(within(page(view)).getByLabelText(/Value/), { target: { value: '2.2' } });
    act(() => { window.dispatchEvent(new Event('hr:drafts-cleared')); });
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
    expect(fileRows('ldl').some(r => r.value === 2.2)).toBe(false);
  });
});

describe('US-62 AC10 review fixes: the back gesture', () => {
  it('a page is a history entry: back closes it, and "‹ My data" goes back', async () => {
    await seed();
    const view = await renderTool();
    const push = vi.spyOn(history, 'pushState');
    fireEvent.click(row(view, 'LDL Cholesterol'));
    expect(history.state?.hrValuePage).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][2]).toBeUndefined(); // no URL change for analytics to see
    act(() => { history.back(); });
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
    fireEvent.click(row(view, 'HbA1c'));
    fireEvent.click(within(page(view)).getByRole('button', { name: '‹ My data' }));
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
    expect(history.state?.hrValuePage).toBeFalsy();
  });

  it('typed input is never dropped silently: declining stays on the page, accepting leaves', async () => {
    await seed();
    const view = await renderTool();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(row(view, 'LDL Cholesterol'));
    fireEvent.change(within(page(view)).getByLabelText(/Value/), { target: { value: '2.2' } });
    act(() => { history.back(); });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('Leave without saving the value you typed?'));
    expect((within(page(view)).getByLabelText(/Value/) as HTMLInputElement).value).toBe('2.2');
    await waitFor(() => expect(history.state?.hrValuePage).toBe(true));
    confirm.mockReturnValue(true);
    fireEvent.click(within(page(view)).getByRole('button', { name: '‹ My data' }));
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
  });
});

describe('US-62 AC11 review fix: unsaved grid values under the rows', () => {
  it('a value typed in the hidden grid shows a cue on its card that opens the table', async () => {
    await seed();
    const view = await renderTool();
    fireEvent.click(view.getByRole('button', { name: 'All results as a table' }));
    const draft = view.container.querySelector<HTMLInputElement>('.md-table .bt-timeline:not(.alr-matrix) .bt-row[data-metric="ldl"] input')!;
    fireEvent.focus(draft);
    fireEvent.change(draft, { target: { value: '2.6' } });
    fireEvent.click(within(view.container.querySelectorAll<HTMLElement>('.md-table')[1]).getByRole('button', { name: '‹ Show as rows' }));
    const cue = await waitFor(() => view.getByRole('button', { name: 'Unsaved values: review' }));
    fireEvent.click(cue);
    expect([...view.container.querySelectorAll<HTMLElement>('.md-table')].every(t => !t.hidden)).toBe(true);
  });
});

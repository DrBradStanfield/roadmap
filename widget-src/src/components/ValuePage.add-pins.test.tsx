// @vitest-environment jsdom
// The value page's Add form (US-62 AC10, US-03 AC2a, US-05 AC2): what the person sees
// while a save runs, after it is refused, after it throws, and after the form is gone.
// Pins written before the form's modes became one named state (lib/value-add-machine).
// P1-P5 render the page alone, its save held by the test; P6 renders the whole widget
// over a real RoadmapStore, since the leave question lives in useValuePage.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import { localDay } from '@roadmap/health-core/merge';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import { RoadmapStore } from '../storage/roadmap-store';
import type { Refused, SaveTask } from '../lib/matrix-save';
import { SAVE_ERRORS } from '../lib/value-cell-state';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
// The chart is not under test: a stand-in, so no chart library loads.
vi.mock('./HistoryPanel', () => ({ TimeSeriesChart: () => null, MixedUnitsNote: () => null }));

import { ValuePage } from './ValuePage';
import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

const UNIT_CHANGED = 'The unit changed, so your value was not saved. Type it again in the new unit.';
const today = () => localDay(new Date());
const settled = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });

/** A promise the test resolves. */
function held<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { open = resolve; });
  return { promise, open };
}

type Save = (tasks: SaveTask[], erase?: string) => Promise<Refused>;

/** The page alone, for a core value, its save the test's own. */
function valuePage(onSave: Save, { metric = 'waist', history = [] as ApiMeasurement[], unit = 'si' as CellUnit } = {}) {
  const props = (h: ApiMeasurement[], u: CellUnit) => ({
    tiles: [], onOpen: () => {}, subject: { kind: 'core' as const, metric: metric as 'waist' }, history: h, labValues: [],
    ctx: { grading: { sex: 'male' as const }, plan: null, unitOf: () => u }, onSave, onClose: () => {}, dirtyRef: { current: false },
  });
  const view = render(<ValuePage {...props(history, unit)}/>);
  const rerender = (h: ApiMeasurement[], u: CellUnit = unit) => view.rerender(<ValuePage {...props(h, u)}/>);
  const said = () => view.container.querySelector('.md-page-messages')!.textContent!.trim();
  const value = () => screen.getByRole('textbox') as HTMLInputElement;
  const button = () => view.container.querySelector('.md-add-save') as HTMLButtonElement;
  const form = () => view.container.querySelector('form.md-add') as HTMLFormElement;
  const alert = () => screen.queryByRole('alert')?.textContent ?? null;
  return { view, rerender, said, value, button, form, alert };
}
const waistRow = (id: string, value: number): ApiMeasurement =>
  ({ id, metricType: 'waist', value, recordedAt: `${today()}T00:00:00.000Z`, createdAt: `${today()}T00:00:00.000Z`, status: 'active' });

describe('US-03 AC2a: the Add form while its save runs (P1)', () => {
  it('Add stays disabled, its label unchanged, until the save lands; a submit meanwhile sends nothing', async () => {
    const save = held<Refused>();
    const onSave = vi.fn<Save>(() => save.promise);
    const page = valuePage(onSave);
    fireEvent.change(page.value(), { target: { value: '90' } });
    await act(async () => { fireEvent.submit(page.form()); });
    expect(page.button().disabled).toBe(true);
    expect(page.button().textContent).toBe('Add');
    await act(async () => { fireEvent.submit(page.form()); });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { save.open(new Map()); });
    await settled();
    expect(page.button().disabled).toBe(false);
    expect(page.said()).toBe('Added.');
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('US-03 AC8, US-62 AC10: a refusal, then a retry (P2, P3)', () => {
  it('changed: the alert says so and the note names the new row; the alert clears as the retry is sent, which corrects that row once', async () => {
    const retry = held<Refused>();
    const onSave = vi.fn<Save>()
      .mockResolvedValueOnce(new Map([[`${today()}|waist`, 'changed']]))
      .mockImplementationOnce(() => retry.promise);
    const page = valuePage(onSave);
    fireEvent.change(page.value(), { target: { value: '91' } });
    // Another device writes the day while the value is typed.
    page.rerender([waistRow('other-device', 95)]);
    await act(async () => { fireEvent.submit(page.form()); });
    await settled();
    expect(onSave.mock.calls[0][0][0].expected).toEqual({ waist: null });
    expect(page.alert()).toBe(SAVE_ERRORS.changed);
    expect(page.view.container.querySelector('.md-add-note')!.textContent).toMatch(/^This day has 95.* already\. Saving corrects it\.$/);
    expect(page.button().textContent).toBe('Save correction');
    expect(page.value().value).toBe('91');
    await act(async () => { fireEvent.submit(page.form()); });
    expect(page.alert()).toBeNull();
    expect(onSave.mock.calls[1][0][0].expected).toEqual({ waist: 'other-device' });
    await act(async () => { retry.open(new Map()); });
    await settled();
    expect(page.said()).toBe('Corrected.');
    expect(page.alert()).toBeNull();
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['error', SAVE_ERRORS.error],
    ['invalid', SAVE_ERRORS.invalid],
    [{ refused: 'The engine says no.' }, 'The engine says no.'],
  ] as const)('refused (%j): the alert says why, the text stays, the retry expects the same row', async (why, words) => {
    const onSave = vi.fn<Save>()
      .mockResolvedValueOnce(new Map([[`${today()}|waist`, why]]))
      .mockResolvedValueOnce(new Map());
    const page = valuePage(onSave, { history: [waistRow('saved', 90)] });
    fireEvent.change(page.value(), { target: { value: '92' } });
    await act(async () => { fireEvent.submit(page.form()); });
    await settled();
    expect(page.alert()).toBe(words);
    expect(page.value().value).toBe('92');
    expect(page.said()).toBe('');
    await act(async () => { fireEvent.submit(page.form()); });
    await settled();
    expect(onSave.mock.calls.map((c) => c[0][0].expected)).toEqual([{ waist: 'saved' }, { waist: 'saved' }]);
    expect(page.said()).toBe('Corrected.');
  });
});

describe('US-03 AC2a, lead H128: a save that throws (P5)', () => {
  it('shows no alert line: nothing is said, as today', async () => {
    const caught: unknown[] = [];
    const before = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const mine = (e: unknown) => { caught.push(e); };
    process.on('unhandledRejection', mine);
    try {
      const onSave = vi.fn<Save>(() => { throw new Error('test sync throw'); });
      const page = valuePage(onSave);
      fireEvent.change(page.value(), { target: { value: '90' } });
      await act(async () => { fireEvent.submit(page.form()); });
      await settled();
      expect(caught).toHaveLength(1);
      expect(page.alert()).toBeNull();
      expect(page.said()).toBe('');
      expect(page.value().value).toBe('90');
    } finally {
      process.off('unhandledRejection', mine);
      for (const l of before) process.on('unhandledRejection', l);
    }
  });
});

describe('US-62 AC10: an old page\'s save never clears the next page\'s unsaved mark (P6)', () => {
  const rowNamed = (view: RenderResult, name: string) => waitFor(() => {
    const r = [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find((b) => b.querySelector('.md-row-label')?.textContent === name);
    expect(r).toBeDefined();
    return r!;
  });
  const openPage = () => document.querySelector<HTMLElement>('.mh-page-host .md-page');

  it('type, Add (held), leave, open another page and type; the old save lands; Back still asks first', async () => {
    await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1, unitSystem: 'si' }, [['hba1c', 38], ['ldl', 3]]);
    const view = render(<HealthTool/>);
    const write = held<void>();
    const original = RoadmapStore.prototype.addMeasurement;
    const inserts = vi.spyOn(RoadmapStore.prototype, 'addMeasurement').mockImplementationOnce(async function (this: RoadmapStore, ...args) {
      await write.promise;
      return original.apply(this, args);
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    fireEvent.click(await rowNamed(view, 'HbA1c'));
    fireEvent.change(within(openPage()!).getByLabelText(/Value/), { target: { value: '40' } });
    await act(async () => { fireEvent.submit(openPage()!.querySelector('form.md-add')!); });
    // The text is still there while the save runs, so leaving asks; the person says yes.
    fireEvent.click(within(openPage()!).getByRole('button', { name: '‹ Back' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(openPage()).toBeNull());

    fireEvent.click(await rowNamed(view, 'LDL Cholesterol'));
    fireEvent.change(within(openPage()!).getByLabelText(/Value/), { target: { value: '2.5' } });
    await act(async () => { write.open(); });
    await settled();
    // The old page's save landed: its ok path ran after the page was gone.
    expect(inserts.mock.calls.map((c) => [c[0], c[1]])).toEqual([['hba1c', 40]]);
    await expect(inserts.mock.results[0].value).resolves.toMatchObject({ status: 'inserted' });

    confirm.mockReturnValue(false);
    fireEvent.click(within(openPage()!).getByRole('button', { name: '‹ Back' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith('Leave without saving the value you typed?');
    expect((within(openPage()!).getByLabelText(/Value/) as HTMLInputElement).value).toBe('2.5');
  });
});

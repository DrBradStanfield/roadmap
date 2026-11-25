// @vitest-environment jsdom
/**
 * US-03 AC10 (lead H302): a blood pressure's Correct on its value page. Once the
 * correction saves, the focus is on that day's Correct button, which still stands
 * where the person pressed it, though the record replaced the reading's rows. A
 * refused save leaves the focus on the field the person was in.
 *
 * jsdom moves the focus to the body when the focused element leaves the page, as a
 * browser does; it does not blur a field or button that becomes disabled.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { Refused, SaveTask } from '../lib/matrix-save';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart is not under test: a stand-in, so no chart library loads.
vi.mock('./HistoryPanel', () => ({ TimeSeriesChart: () => null, MixedUnitsNote: () => null }));

import { ValuePage } from './ValuePage';

type Save = (tasks: SaveTask[], erase?: string) => Promise<Refused>;
const settled = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });

const row = (id: string, metricType: 'systolic_bp' | 'diastolic_bp', value: number, day: string): ApiMeasurement =>
  ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, status: 'active' });
const DAYS = ['2026-08-02', '2026-08-01'];
const before = [row('s2', 'systolic_bp', 128, DAYS[0]), row('d2', 'diastolic_bp', 82, DAYS[0]),
  row('s1', 'systolic_bp', 135, DAYS[1]), row('d1', 'diastolic_bp', 85, DAYS[1])];
// The correction appends new rows and flips the old ones (FHIR): the reading's ids change.
const after = [...before.filter(r => !r.id.endsWith('1')), row('s1b', 'systolic_bp', 125, DAYS[1]), row('d1b', 'diastolic_bp', 80, DAYS[1])];

function bpPage(onSave: Save) {
  const props = (history: ApiMeasurement[]) => ({
    tiles: [], onOpen: () => {}, subject: { kind: 'bp' as const }, history, labValues: [],
    ctx: { grading: { sex: 'male' as const }, plan: null, unitOf: () => 'si' as const }, onSave, onClose: () => {}, dirtyRef: { current: false },
  });
  const view = render(<ValuePage {...props(before)}/>);
  const corrects = () => [...view.container.querySelectorAll('.md-history-correct')] as HTMLButtonElement[];
  const form = () => view.container.querySelector('form.md-add') as HTMLFormElement;
  const systolic = () => form().querySelector('input[aria-label="Systolic (top number)"]') as HTMLInputElement;
  const diastolic = () => form().querySelector('input[aria-label="Diastolic (bottom number)"]') as HTMLInputElement;
  return { view, corrects, form, systolic, diastolic, reread: () => view.rerender(<ValuePage {...props(after)}/>) };
}

/** Correct on the older day, a new reading typed, Enter in the diastolic. */
async function correctOlderDay(onSave: Save) {
  const p = bpPage(onSave);
  const older = p.corrects()[1];
  older.focus();
  fireEvent.click(older);
  expect(document.activeElement).toBe(p.systolic());
  fireEvent.change(p.systolic(), { target: { value: '125' } });
  fireEvent.change(p.diastolic(), { target: { value: '80' } });
  p.diastolic().focus();
  await act(async () => { fireEvent.submit(p.form()); });
  return p;
}

describe('US-03 AC10 (H302): the focus after a blood pressure\'s Correct saves on its value page', () => {
  it('an ok save puts the focus on that day\'s Correct button, before and after the record is read again', async () => {
    const onSave = vi.fn<Save>(async () => new Map());
    const p = await correctOlderDay(onSave);
    await settled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0].date).toBe(DAYS[1]);
    expect(document.activeElement).toBe(p.corrects()[1]);
    // The record read again: the day's rows are new, its Correct button is the same one.
    const button = p.corrects()[1];
    await act(async () => { p.reread(); });
    expect(document.activeElement).toBe(button);
    expect(p.corrects()[1]).toBe(button);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('with that day no longer on the page as the save lands, the focus goes to the page\'s title', async () => {
    const onSave = vi.fn<Save>(async () => new Map());
    const p = bpPage(onSave);
    fireEvent.click(p.corrects()[1]);
    fireEvent.change(p.systolic(), { target: { value: '125' } });
    fireEvent.change(p.diastolic(), { target: { value: '80' } });
    // The record read again without that day (an erase elsewhere) while the form was open.
    p.view.rerender(<ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'bp' }} history={before.slice(0, 2)} labValues={[]}
      ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={onSave} onClose={() => {}} dirtyRef={{ current: false }}/>);
    expect(p.corrects()).toHaveLength(1);
    await act(async () => { fireEvent.submit(p.form()); });
    await settled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(p.view.container.querySelector('h3.md-page-title'));
  });

  it('a refused save leaves the focus on the field the person was in', async () => {
    const onSave = vi.fn<Save>(async () => new Map([[`${DAYS[1]}|systolic_bp`, 'changed']]) as Refused);
    const p = await correctOlderDay(onSave);
    await settled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(p.diastolic());
    expect(p.diastolic().value).toBe('80');
  });
});

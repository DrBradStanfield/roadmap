// @vitest-environment jsdom
/**
 * US-03 AC2b (H301, owner ruling 2026-11-25, remedy b): while the value page's Add save runs,
 * its Date and Value fields are read-only, not disabled, so the focus and a phone's keyboard
 * stay, and nothing typed meanwhile is wiped when the save lands. Once the save lands, ok or
 * not, the fields take typing again.
 *
 * jsdom does not refuse text into a read-only field as a browser does, and fireEvent.change
 * would reach React's onChange regardless. `typeLikeABrowser` does what the browser does:
 * no text goes into a read-only or disabled field.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { Refused, SaveTask } from '../lib/matrix-save';
import { localDay } from '@roadmap/health-core/merge';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart is not under test: a stand-in, so no chart library loads.
vi.mock('./HistoryPanel', () => ({ TimeSeriesChart: () => null, MixedUnitsNote: () => null }));

import { ValuePage } from './ValuePage';

type Save = (tasks: SaveTask[], erase?: string) => Promise<Refused>;
const today = () => localDay(new Date());
const settled = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });

function held<T>() {
  let open!: (value: T) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

function typeLikeABrowser(input: HTMLInputElement, value: string) {
  if (input.readOnly || input.disabled) return;
  fireEvent.change(input, { target: { value } });
}

function page(onSave: Save, subject: { kind: 'core'; metric: 'waist' } | { kind: 'bp' }) {
  const view = render(<ValuePage tiles={[]} onOpen={() => {}} subject={subject} history={[] as ApiMeasurement[]} labValues={[]}
    ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={onSave} onClose={() => {}} dirtyRef={{ current: false }}/>);
  const form = view.container.querySelector('form.md-add') as HTMLFormElement;
  const date = form.querySelector('input[type="date"]') as HTMLInputElement;
  const values = [...form.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
  return { form, date, values, fields: [date, ...values] };
}

describe('US-03 AC2b (H301): the Add form\'s fields while its save runs', () => {
  it('a value typed during a held save does not go in, the save sends what was pressed, and the fields clear and take typing once it lands', async () => {
    const save = held<Refused>();
    const onSave = vi.fn<Save>(() => save.promise);
    const p = page(onSave, { kind: 'core', metric: 'waist' });
    typeLikeABrowser(p.values[0], '90');
    await act(async () => { fireEvent.submit(p.form); });
    p.values[0].focus();
    for (const f of p.fields) {
      expect(f.readOnly).toBe(true);
      expect(f.disabled).toBe(false); // the focus and the keyboard stay
    }
    expect(document.activeElement).toBe(p.values[0]);
    typeLikeABrowser(p.values[0], '905');
    typeLikeABrowser(p.date, '2026-01-02');
    expect(p.values[0].value).toBe('90');
    expect(p.date.value).toBe(today());
    await act(async () => { save.open(new Map()); });
    await settled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0].values).toEqual({ waist: 90 });
    for (const f of p.fields) expect(f.readOnly).toBe(false);
    expect(p.values[0].value).toBe('');
    typeLikeABrowser(p.values[0], '88');
    expect(p.values[0].value).toBe('88');
  });

  it('a blood pressure\'s two numbers are read-only during a held save too', async () => {
    const save = held<Refused>();
    const p = page(vi.fn<Save>(() => save.promise), { kind: 'bp' });
    typeLikeABrowser(p.values[0], '126');
    typeLikeABrowser(p.values[1], '80');
    await act(async () => { fireEvent.submit(p.form); });
    for (const f of p.fields) expect(f.readOnly).toBe(true);
    typeLikeABrowser(p.values[1], '85');
    expect(p.values.map(v => v.value)).toEqual(['126', '80']);
    await act(async () => { save.open(new Map()); });
    await settled();
    for (const f of p.fields) expect(f.readOnly).toBe(false);
  });

  it('after a refused save the fields keep the text and take typing again', async () => {
    const save = held<Refused>();
    const p = page(vi.fn<Save>(() => save.promise), { kind: 'core', metric: 'waist' });
    typeLikeABrowser(p.values[0], '90');
    await act(async () => { fireEvent.submit(p.form); });
    expect(p.values[0].readOnly).toBe(true);
    await act(async () => { save.open(new Map([[`${today()}|waist`, 'error']])); });
    await settled();
    for (const f of p.fields) expect(f.readOnly).toBe(false);
    expect(p.values[0].value).toBe('90');
    typeLikeABrowser(p.values[0], '91');
    expect(p.values[0].value).toBe('91');
  });

  it('after a save that throws the fields take typing again', async () => {
    const caught: unknown[] = [];
    const before = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const mine = (e: unknown) => { caught.push(e); };
    process.on('unhandledRejection', mine);
    try {
      const save = held<Refused>();
      const p = page(vi.fn<Save>(() => save.promise), { kind: 'core', metric: 'waist' });
      typeLikeABrowser(p.values[0], '90');
      await act(async () => { fireEvent.submit(p.form); });
      expect(p.values[0].readOnly).toBe(true);
      await act(async () => { save.fail(new Error('test write failed')); });
      await settled();
      expect(caught).toHaveLength(1);
      for (const f of p.fields) expect(f.readOnly).toBe(false);
      expect(p.values[0].value).toBe('90');
    } finally {
      process.off('unhandledRejection', mine);
      for (const l of before) process.on('unhandledRejection', l);
    }
  });
});

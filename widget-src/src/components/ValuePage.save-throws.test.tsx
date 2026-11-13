// @vitest-environment jsdom
// US-03 AC2a: a save that throws before it returns its promise (a synchronous
// throw from onSave) still hands the Add button back, and frees the claim, so
// the next Add saves. What the page says then is not settled (lead H128).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ValuePage } from './ValuePage';

vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => '' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
// The chart is not under test: a stand-in, so no chart library loads.
vi.mock('./HistoryPanel', () => ({ TimeSeriesChart: () => null, MixedUnitsNote: () => null }));

afterEach(cleanup);

describe('US-03 AC2a: a synchronous throw from the save', () => {
  it('Add comes back enabled, and the next Add saves', async () => {
    // The throw escapes the submit as an unhandled rejection, as on main: caught here (PlanPdf.print.test.tsx).
    const caught: unknown[] = [];
    const before = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const mine = (e: unknown) => { caught.push(e); };
    process.on('unhandledRejection', mine);
    try {
      const onSave = vi.fn()
        .mockImplementationOnce(() => { throw new Error('test sync throw'); })
        .mockImplementation(async () => new Map());
      render(<ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'waist' }} history={[]} labValues={[]}
        ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={onSave} onClose={() => {}} dirtyRef={{ current: false }}/>);
      const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '90' } });
      await act(async () => { fireEvent.click(add); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(caught).toHaveLength(1);
      expect(add.disabled).toBe(false);
      await act(async () => { fireEvent.click(add); });
      expect(onSave).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', mine);
      for (const l of before) process.on('unhandledRejection', l);
    }
  });

  it('a throw before the save (the weight answer) also gives Add back, and the next Add saves', async () => {
    const caught: unknown[] = [];
    const before = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const mine = (e: unknown) => { caught.push(e); };
    process.on('unhandledRejection', mine);
    try {
      const onSave = vi.fn(async () => new Map());
      const onWeightAnswered = vi.fn().mockImplementationOnce(() => { throw new Error('test answer failed'); });
      render(<ValuePage tiles={[]} onOpen={() => {}} subject={{ kind: 'core', metric: 'weight' }} history={[]} labValues={[]}
        ctx={{ grading: { sex: 'male' }, plan: null, unitOf: () => 'si' }} onSave={onSave} onClose={() => {}} dirtyRef={{ current: false }}
        onWeightAnswered={onWeightAnswered}/>);
      const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '84' } });
      await act(async () => { fireEvent.click(add); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(onWeightAnswered).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
      expect(caught).toHaveLength(1);
      expect(add.disabled).toBe(false);
      await act(async () => { fireEvent.click(add); });
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', mine);
      for (const l of before) process.on('unhandledRejection', l);
    }
  });
});

// @vitest-environment jsdom
/**
 * useHeldUnits (US-34 AC7, US-04 AC1): the record's unit system, held while a
 * field has the focus. What the person sees is the system shown on the page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useHeldUnits } from './useHeldUnits';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';

let hook: ReturnType<typeof useHeldUnits> & { choose: (system: string) => void };

/** A page with one field, showing its unit system; `choose` is the person's own switch here. */
function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState('si');
  const apply = (system: unknown) => { if (system === 'si' || system === 'conventional') setShown(system); };
  hook = { ...useHeldUnits(apply, shown, rootRef), choose: setShown };
  return <div ref={rootRef}><input aria-label="Weight" /><output>{shown}</output></div>;
}
const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });

afterEach(() => { cleanup(); localStorage.clear(); });

describe('US-34 AC7: the person\'s own unit switch outranks a held one from another device', () => {
  it('US-34 AC7: a remote switch held while typing, then the person switches here and back: after the field is left, their own last choice shows', async () => {
    const view = render(<Page />);
    const field = view.getByRole('textbox', { name: 'Weight' });
    act(() => field.focus());
    act(() => hook.offerUnits('conventional')); // another device's switch, held
    expect(view.container.querySelector('output')?.textContent).toBe('si');
    act(() => hook.choose('conventional')); // the person's own switch here
    act(() => hook.choose('si')); // and back
    act(() => field.blur());
    await nextFrame();
    expect(view.container.querySelector('output')?.textContent).toBe('si');
  });

  it('US-34 AC7: with nothing else changed, the held switch applies once the field is left', async () => {
    const view = render(<Page />);
    const field = view.getByRole('textbox', { name: 'Weight' });
    act(() => field.focus());
    act(() => hook.offerUnits('conventional'));
    expect(view.container.querySelector('output')?.textContent).toBe('si');
    act(() => field.blur());
    await nextFrame();
    expect(view.container.querySelector('output')?.textContent).toBe('conventional');
  });
});

describe('US-04 AC1: a matrix draft kept on the device holds the units, whatever a matrix reports (PR 1135 B1)', () => {
  it('US-04 AC1: a kept LDL draft holds a remote switch with no field focused; the draft gone, the switch applies', () => {
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: {} }));
    const view = render(<Page />);
    act(() => hook.offerUnits('conventional'));
    act(() => hook.onMatrixHolds('blood', false)); // no matrix on the page reports a draft: the kept one still holds
    expect(view.container.querySelector('output')?.textContent).toBe('si');
    localStorage.removeItem(BT_TIMELINE_DRAFT_KEY); // the draft committed
    act(() => hook.onMatrixHolds('blood', false));
    expect(view.container.querySelector('output')?.textContent).toBe('conventional');
  });
});

describe('US-04 AC1: a draft this page holds keeps the units held, whatever is kept on the device (PR 1135 Codex R2)', () => {
  it('US-04 AC1: a matrix reporting a draft holds a remote switch with nothing kept and no field focused; its draft emptied, the switch applies', () => {
    const view = render(<Page />);
    act(() => hook.onMatrixHolds('vitals', true));
    act(() => hook.offerUnits('conventional'));
    expect(view.container.querySelector('output')?.textContent).toBe('si');
    act(() => hook.onMatrixHolds('vitals', false));
    expect(view.container.querySelector('output')?.textContent).toBe('conventional');
  });
});

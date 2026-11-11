// @vitest-environment jsdom
/**
 * useUnits (US-05, US-34 AC7, AC7a, US-04 AC1): the units the page shows, the
 * record's held while a field has the focus, and this device's starting units.
 * What the person sees is the system shown on the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useUnits } from './useUnits';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('US-34 AC7: the units this device started with outlast the record\'s', () => {
  // Adversary R4 on PR 1147: a matrix draft cell kept with no unit was typed in them.
  it('this device in SI, LDL in mg/dL: after the record brings US units, LDL started in mg/dL and HDL in SI', () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    localStorage.setItem('health_roadmap_unit_overrides', JSON.stringify({ ldlC: 'conventional' }));
    const { result } = renderHook(() => useUnits(() => {}, { current: null }));
    act(() => result.current.record.shown('conventional'));
    expect(result.current.unitSystem).toBe('conventional');
    expect(localStorage.getItem('health_roadmap_unit_system')).toBe('conventional');
    expect(result.current.startUnitOf('hdlC')).toBe('si');
    expect(result.current.startUnitOf('ldlC')).toBe('conventional');
  });
});

let hook: ReturnType<typeof useUnits>;
/** A page with one field and the Units pill, showing its unit system. */
function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  hook = useUnits(() => {}, rootRef);
  return (
    <div ref={rootRef}>
      <input aria-label="Weight"/>
      <button type="button" data-unit-control="all">Units</button>
      <output>{hook.unitSystem}</output>
    </div>
  );
}
const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
/** A page in SI, the field focused, and another device's US units held. */
function held() {
  localStorage.setItem('health_roadmap_unit_system', 'si');
  const view = render(<Page/>);
  const field = view.getByRole('textbox', { name: 'Weight' });
  const pill = view.getByRole('button', { name: 'Units' });
  const shown = () => view.container.querySelector('output')?.textContent;
  act(() => field.focus());
  act(() => hook.record.offered('conventional'));
  expect(shown()).toBe('si');
  return { view, field, pill, shown };
}

describe('US-34 AC7: the person\'s own unit switch outranks a held one from another device', () => {
  it('US-34 AC7: a remote switch held while typing, then the person switches here and back: after the field is left, their own last choice shows', async () => {
    const { field, pill, shown } = held();
    fireEvent.click(pill); // the person's own switch here
    fireEvent.click(pill); // and back
    act(() => field.blur());
    await nextFrame();
    expect(shown()).toBe('si');
  });

  it('US-34 AC7: with nothing else changed, the held switch applies once the field is left', async () => {
    const { field, shown } = held();
    act(() => field.blur());
    await nextFrame();
    expect(shown()).toBe('conventional');
  });
});

// The matrix drafts carry the unit each cell was typed in (useMatrixDraft),
// so they keep their quantity across a switch and hold nothing (PR 1135's
// draft holds, removed; the saved value is pinned in
// HealthTool.record-read-pins.test.tsx).
describe('US-04 AC1: a kept matrix draft holds no unit switch: only a focused field does', () => {
  it('US-04 AC1: a kept LDL draft and no field focused: a remote switch applies at once', () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: { 'new|ldl': { unit: 'si' } } }));
    const view = render(<Page/>);
    act(() => hook.record.offered('conventional'));
    expect(view.container.querySelector('output')?.textContent).toBe('conventional');
  });
});

describe('US-34 AC7a (H9): the observer that watches for a focused field unmounting lives only while units are held', () => {
  /** MutationObserver, counting the observers still connected. */
  function countObservers() {
    const live = { count: 0 };
    const Real = MutationObserver;
    vi.stubGlobal('MutationObserver', class extends Real {
      on = false;
      observe(target: Node, options?: MutationObserverInit) { if (!this.on) live.count++; this.on = true; super.observe(target, options); }
      disconnect() { if (this.on) live.count--; this.on = false; super.disconnect(); }
    });
    return live;
  }

  it.each([
    ['left: the field blurred', async ({ field }: ReturnType<typeof held>) => { act(() => field.blur()); await nextFrame(); }, 'conventional'],
    ['clicked: the Units pill', async ({ pill }: ReturnType<typeof held>) => { fireEvent.click(pill); }, 'conventional'],
    ['shown: another erase\'s record', async () => { act(() => hook.record.shown('si')); }, 'si'],
    ['erased: this tab\'s erase', async () => { act(() => hook.record.erased()); }, 'si'],
  ] as const)('leaving holding by %s leaves no observer', async (_route, leave, after) => {
    const live = countObservers();
    const page = held();
    expect(live.count).toBe(1);
    await leave(page);
    expect(page.shown()).toBe(after);
    expect(live.count).toBe(0);
  });

  it('the focused field unmounts while units are held: they apply, and the observer goes', async () => {
    const live = countObservers();
    const { field, shown } = held();
    act(() => field.remove());
    await act(async () => { await Promise.resolve(); }); // the observer's callback is a microtask
    expect(shown()).toBe('conventional');
    expect(live.count).toBe(0);
  });
});

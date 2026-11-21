// @vitest-environment jsdom
/**
 * US-05 AC2, US-34 AC7a: `setFieldUnit(field, to)` sets a field's own unit to the one named, for the upload list's
 * unit chip (mount note (a)). It never flips: setting the unit a field already shows leaves it there. A unit equal to
 * the system shown follows the system again, except while the record's units are held: the chip's unit is kept as an
 * override and stands through the held apply. What the caller sees: the field's unit and the stored override.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import type { UnitSystem } from '@roadmap/health-core/units';
import { useUnits } from './useUnits';

afterEach(() => { cleanup(); localStorage.clear(); });

let hook: ReturnType<typeof useUnits>;
function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  hook = useUnits(() => {}, rootRef);
  return <div ref={rootRef}><input aria-label="LDL" /></div>;
}
const stored = () => JSON.parse(localStorage.getItem('health_roadmap_unit_overrides') ?? '{}') as Record<string, UnitSystem>;
const nextFrame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });

/** A page in SI; `held`: the field focused and another device's US units held (US-34 AC7a). */
function page(start: Record<string, UnitSystem>, held: boolean) {
  localStorage.setItem('health_roadmap_unit_system', 'si');
  localStorage.setItem('health_roadmap_unit_overrides', JSON.stringify(start));
  const view = render(<Page />);
  if (held) {
    act(() => (view.getByRole('textbox', { name: 'LDL' }) as HTMLInputElement).focus());
    act(() => hook.record.offered('conventional'));
    expect(hook.unitSystem).toBe('si');
  }
  return view;
}

describe('US-05 AC2, US-34 AC7a: setFieldUnit sets the named unit, never flips', () => {
  it.each([
    // [case, starting override, held, unit set, the turn returned, the override after]
    ['US unit on a field following SI', {}, false, 'conventional', { from: 'si', to: 'conventional' }, 'conventional'],
    ['US unit on a field already in US: it stays US (a toggle would flip it back)', { ldlC: 'conventional' }, false, 'conventional', { from: 'conventional', to: 'conventional' }, 'conventional'],
    ['SI on a field in US: it follows the system again', { ldlC: 'conventional' }, false, 'si', { from: 'conventional', to: 'si' }, undefined],
    ['SI on a field following SI: nothing to keep', {}, false, 'si', { from: 'si', to: 'si' }, undefined],
    ['held: SI, the system shown, is kept as the field\'s own', {}, true, 'si', { from: 'si', to: 'si' }, 'si'],
    ['held: US is kept as the field\'s own', {}, true, 'conventional', { from: 'si', to: 'conventional' }, 'conventional'],
  ] as const)('%s', (_case, start, held, to, turn, after) => {
    page({ ...start }, held);
    let got: unknown;
    act(() => { got = hook.setFieldUnit('ldlC', to); });
    expect(got).toEqual(turn);
    expect(hook.unitOverrides.ldlC).toBe(after);
    expect(stored().ldlC).toBe(after);
  });

  it('US-34 AC7a: the unit set while the record\'s units are held stands through the held apply', async () => {
    const view = page({}, true);
    act(() => { hook.setFieldUnit('ldlC', 'si'); });
    act(() => (view.getByRole('textbox', { name: 'LDL' }) as HTMLInputElement).blur());
    await nextFrame();
    expect(hook.unitSystem).toBe('conventional');
    expect(hook.unitOverrides.ldlC).toBe('si');
  });

  it('US-05 AC2: two fields set in one tick both keep their unit', () => {
    page({}, false);
    act(() => { hook.setFieldUnit('ldlC', 'conventional'); hook.setFieldUnit('hdlC', 'conventional'); });
    expect(hook.unitOverrides).toEqual({ ldlC: 'conventional', hdlC: 'conventional' });
    expect(stored()).toEqual({ ldlC: 'conventional', hdlC: 'conventional' });
  });

  it('US-05 AC2: one field set twice in one tick: the second call sees the first', () => {
    page({}, false);
    let turns: unknown[] = [];
    act(() => { turns = [hook.setFieldUnit('ldlC', 'conventional'), hook.setFieldUnit('ldlC', 'si')]; });
    expect(turns).toEqual([{ from: 'si', to: 'conventional' }, { from: 'conventional', to: 'si' }]);
    expect(hook.unitOverrides.ldlC).toBeUndefined();
  });

  it('US-05 AC2: the toggle still flips, through the same setter', () => {
    page({}, false);
    act(() => { hook.handleToggleFieldUnit('ldlC'); });
    expect(hook.unitOverrides.ldlC).toBe('conventional');
    act(() => { hook.handleToggleFieldUnit('ldlC'); });
    expect(hook.unitOverrides.ldlC).toBeUndefined();
  });
});

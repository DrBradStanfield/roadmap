// @vitest-environment jsdom
/**
 * useUnits' `startUnitOf` (US-34 AC7, adversary R4 on PR 1147): this device's
 * units as the page started, before the record's applied. A matrix draft
 * cell kept with no unit was typed in them, and the record's units overwrite
 * this device's preference as they apply.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useUnits } from './useUnits';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('US-34 AC7: the units this device started with outlast the record\'s', () => {
  it('this device in SI, LDL in mg/dL: after the record brings US units, LDL started in mg/dL and HDL in SI', () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    localStorage.setItem('health_roadmap_unit_overrides', JSON.stringify({ ldlC: 'conventional' }));
    const { result } = renderHook(() => useUnits(() => {}, { current: null }));
    act(() => result.current.showUnits('conventional'));
    expect(result.current.unitSystem).toBe('conventional');
    expect(localStorage.getItem('health_roadmap_unit_system')).toBe('conventional');
    expect(result.current.startUnitOf('hdlC')).toBe('si');
    expect(result.current.startUnitOf('ldlC')).toBe('conventional');
  });
});

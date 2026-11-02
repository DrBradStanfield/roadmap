// Pins for units.ts behaviour that no other test checks. Each block names the
// line it guards: a mutation run (mewt, then re-checked by hand on main)
// showed the line could change with every existing test still passing.
// Current behaviour only; nothing here proposes a different line.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIPID_TREATMENT_TARGETS, detectUnitSystem, formatGradedValue, formatTargetLine } from './units';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// formatGradedValue(): `Math.min(floored, x * 10 - 1)`, the cap that keeps a
// value a hair under the line printing below it (US-07 AC5). The cap is a
// guard: no current input reaches it (calculations.ts rounds non-HDL to 4 dp,
// so 3.8 - 2.2 is graded as exactly 1.6), so these pin it with raw values.
describe('formatGradedValue: a value a hair under the line stays under X (US-07 AC5)', () => {
  it('a value 4e-16 under the 1.6 line shows 1.59, not 1.60', () => {
    const line = LIPID_TREATMENT_TARGETS.nonHdlMmol;
    const v = 1.5999999999999996;
    expect(v < line).toBe(true);
    expect(formatTargetLine('ldl', line, 'si')).toBe('1.6');
    expect(formatGradedValue('ldl', v, 'si', line)).toBe('1.59');
  });

  it('LDL 1.4 - 1e-13, graded below 1.4, shows 1.39', () => {
    expect(formatGradedValue('ldl', 1.4 - 1e-13, 'si', LIPID_TREATMENT_TARGETS.ldlMmol)).toBe('1.39');
  });
});

// detectUnitSystem() and isUSTimezone(): the default unit system (US-05).
// units.test.ts covers the Indiana zones and an empty locale with the host's
// own navigator; these cover the other US sub-zones, no navigator at all, and
// an explicit '' locale or timezone, which must not fall back to the host.
describe('detectUnitSystem edge cases', () => {
  it('en-US in Kentucky and North Dakota sub-zones is conventional', () => {
    expect(detectUnitSystem('en-US', 'America/Kentucky/Louisville')).toBe('conventional');
    expect(detectUnitSystem('en-US', 'America/North_Dakota/Center')).toBe('conventional');
  });

  it('with no locale and no navigator (server, iOS engine) returns si, not a throw', () => {
    vi.stubGlobal('navigator', undefined);
    expect(detectUnitSystem()).toBe('si');
    expect(detectUnitSystem(undefined, 'America/New_York')).toBe('si');
  });

  it('an empty locale is si even when the browser says en-US', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(detectUnitSystem('', 'America/New_York')).toBe('si');
  });

  it('an empty timezone skips the cross-check rather than reading the host zone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) as unknown as Intl.DateTimeFormat,
    );
    expect(detectUnitSystem('en-US', '')).toBe('conventional');
  });
});

// @vitest-environment jsdom
// US-09 AC2e: once another tab's log-off has latched this cloud-mode (AC2c)
// tab, no mirror write may put the health copy back in localStorage. No
// HealthTool mirror writer checked the latch: the profile save and the mirror
// helpers the other save paths use (HealthTool.tsx:197, :319, :364) did not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LPA_CHECK_KEPT_KEY, MIRROR_KEY, patchMirror, saveToLocalStorage } from './storage';
import { keepLpaAsIs } from './lpa-unit';
import { latchOnOtherTabsLogOff, roadmapLocalWritesStopped } from '../storage/local-storage-adapter';

// Synthetic in-memory storage, as logout-persistence.test.ts installs.
function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

const med = { id: 'm1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-10-20T00:00:00.000Z' } as never;

describe('US-09 AC2e: the device mirror after another tab logs off', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', makeStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes the mirror before log-off, and nothing after another tab logs off', () => {
    latchOnOtherTabsLogOff();
    // Negative control: before any log-off the mirror is written (passes today and after the fix).
    expect(roadmapLocalWritesStopped()).toBe(false);
    patchMirror({ medications: [med] });
    expect(localStorage.getItem(MIRROR_KEY)).not.toBeNull();

    // Another tab logs off: its content-free signal reaches this tab, and its wipe clears the mirror.
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'health_roadmap_log_off_signal' }));
    localStorage.removeItem(MIRROR_KEY);
    expect(roadmapLocalWritesStopped()).toBe(true);

    // mirrorSavedLists / the lab eGFR patch (HealthTool.tsx:197, :319).
    patchMirror({ medications: [med] });
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
    // reloadValues after any save or correction (HealthTool.tsx:364).
    saveToLocalStorage({ heightCm: 175, sex: 'female' } as never, [], [med], []);
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
    // The Lp(a) check's kept answers, off-file health data (US-09 AC2d).
    keepLpaAsIs('lpa-row-1');
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
  });
});

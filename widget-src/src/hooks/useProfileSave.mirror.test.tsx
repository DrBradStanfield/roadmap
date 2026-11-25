// @vitest-environment jsdom
/**
 * US-34 AC11, AC8: a profile save writes the chat mirror through the one
 * writer; a malformed stored mirror never stops the save from settling, so a
 * held change is still released. Real mirror storage; the store is a stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { renderHook } from '@testing-library/react';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/roadmap-data', () => ({
  getBackendKind: () => 'cloud',
  getShownErase: () => 'e1',
  saveChangedMeasurements: async () => ({ ok: true }),
  loadLatestMeasurementsSync: () => null,
  loadLabValuesSync: () => [],
  loadAllHistorySync: () => [],
}));

import { useProfileSave } from './useProfileSave';
import { MIRROR_KEY } from '../lib/storage';

afterEach(() => { localStorage.clear(); });

describe('US-34 AC11: a malformed stored mirror', () => {
  it('a profile save still settles (onSettled runs) and returns true', async () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: { sex: 'male' }, medications: [], screenings: [null] }));
    const settled = vi.fn();
    const view = renderHook(() => {
      const [inputs, setInputs] = useState<Partial<HealthInputs>>({});
      const inputsRef = useRef(inputs);
      inputsRef.current = inputs;
      const save = useProfileSave({ inputs, inputsRef, setInputs, loaded: true, onSettled: settled, writeRefused: vi.fn(),
        units: { pending: () => undefined, saved: vi.fn() } });
      return { save, setInputs };
    });
    act(() => view.result.current.setInputs({ heightCm: 180 }));
    let saved: unknown;
    await act(async () => { saved = await view.result.current.save.flushProfile('e1'); });
    expect(saved).toBe(true);
    expect(settled).toHaveBeenCalled();
  });
});

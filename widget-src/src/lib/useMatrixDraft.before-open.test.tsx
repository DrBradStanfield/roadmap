// @vitest-environment jsdom
/**
 * US-11 AC6 — a page still loading is on no record yet, so it owns none of
 * this browser's drafts: a value typed into a matrix before the record opens
 * stays on screen, and is kept on the device with the first change after the
 * record opens. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { Refused, SaveTask } from './matrix-save';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { noteDevicePage, VITALS_DRAFT_KEY } from './storage';
import { typeInto } from '../testing/matrix-gestures';

afterEach(() => { cleanup(); localStorage.clear(); });

function vitals() {
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn<(tasks: SaveTask[]) => Promise<Refused>>().mockResolvedValue(new Map());
  const view = render(<StartingInfoVitals vitalsHistory={history} unitSystem="si" onSave={onSave}
    formStage={3} plan={null} unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
  const cell = (label: string) => Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!
    .querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!;
  return { weight: cell('Weight'), waist: cell('Waist Circumference') };
}

describe('US-11 AC6 — drafts typed before the record opens', () => {
  it('stay on screen only, then are kept on the device with the first change after the record opens', () => {
    const m = vitals();
    typeInto(m.weight, '80');
    expect(m.weight.value).toBe('80');
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();

    noteDevicePage(); // the record opens, on this device
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull(); // nothing changed yet
    typeInto(m.waist, '90');

    expect(JSON.parse(localStorage.getItem(VITALS_DRAFT_KEY)!).draft.values).toEqual({ weight: '80', waist: '90' });
  });
});

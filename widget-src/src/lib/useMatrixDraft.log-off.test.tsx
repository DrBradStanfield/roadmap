// @vitest-environment jsdom
/**
 * US-09 AC2e, the drafts: after another tab's log-off has latched this
 * cloud-mode tab, a value typed into the vitals matrix must not be written to
 * the device as a draft. useMatrixDraft persisted it with no latch check.
 * Synthetic values; harness as StartingInfoVitals.numeric-units.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import type { Refused, SaveTask } from './matrix-save';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { VITALS_DRAFT_KEY } from './storage';
import { latchOnOtherTabsLogOff, roadmapLocalWritesStopped } from '../storage/local-storage-adapter';

afterEach(() => { cleanup(); localStorage.clear(); });

function weightInput() {
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn<(tasks: SaveTask[]) => Promise<Refused>>().mockResolvedValue(new Map());
  const view = render(<StartingInfoVitals vitalsHistory={history} unitSystem="si"
    onSave={onSave} onDraftValue={() => {}} formStage={3} plan={null}
    unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
  return row.querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!;
}

describe('US-09 AC2e: matrix drafts after another tab logs off', () => {
  it('control: before any log-off a typed value is kept as a draft', () => {
    fireEvent.change(weightInput(), { target: { value: '80' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
  });

  it('after the latch, a typed value is not written to the device, and a stale draft goes', () => {
    latchOnOtherTabsLogOff();
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'health_roadmap_log_off_signal' }));
    expect(roadmapLocalWritesStopped()).toBe(true);
    // A draft that landed in AC2c's race window, before this tab latched.
    localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} }));
    fireEvent.change(weightInput(), { target: { value: '81' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
  });
});

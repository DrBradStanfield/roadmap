// @vitest-environment jsdom
/**
 * US-09 AC2e, the drafts: after another tab's log-off has latched this
 * cloud-mode tab, a value typed into the vitals matrix must not be written to
 * the device as a draft. useMatrixDraft persisted it with no latch check.
 * Synthetic values; harness as StartingInfoVitals.numeric-units.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { Refused, SaveTask } from './matrix-save';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { noteCloudPage, noteDevicePage, VITALS_DRAFT_KEY } from './storage';
import { listenForOtherTabsLogOff, roadmapLocalWritesStopped } from '../storage/local-storage-adapter';

afterEach(() => { cleanup(); localStorage.clear(); });

function weightInput() {
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn<(tasks: SaveTask[]) => Promise<Refused>>().mockResolvedValue(new Map());
  const view = render(<StartingInfoVitals vitalsHistory={history} unitSystem="si"
    onSave={onSave} formStage={3} plan={null}
    unitOverrides={{}} onToggleFieldUnit={() => {}}/>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
  return row.querySelector<HTMLElement>('.bt-cell-draft')!.querySelector('input')!;
}

describe('US-09 AC2e: matrix drafts after another tab logs off', () => {
  it('control: before any log-off a typed value is kept as a draft', () => {
    noteDevicePage(); // the page's record is open, on this device (US-11 AC6)
    fireEvent.change(weightInput(), { target: { value: '80' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).not.toBeNull();
  });

  it('after a heard log-off, a typed value is not written, and the draft key is left alone', () => {
    listenForOtherTabsLogOff();
    noteCloudPage('memory');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'health_roadmap_log_off_signal' }));
    expect(roadmapLocalWritesStopped()).toBe(true);
    // A page that did not begin the log-off leaves the draft key alone: it may
    // hold a draft written under the new sign-in.
    const theirs = JSON.stringify({ draft: { values: { weight: '79' } }, backfills: {}, meta: {} });
    localStorage.setItem(VITALS_DRAFT_KEY, theirs);
    fireEvent.change(weightInput(), { target: { value: '81' } });
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBe(theirs);
  });
});

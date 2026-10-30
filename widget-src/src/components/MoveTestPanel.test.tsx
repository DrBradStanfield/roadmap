// @vitest-environment jsdom
/**
 * US-04 AC5: a saved blood test's date header moves the whole test to the day
 * it was really drawn. Picking a day writes nothing; a panel names every value
 * that moves and asks about each clash; only Move writes. The page owns one
 * move for both matrices, composed here as InputPanel composes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import {
  createEmptyFile, createMeasurement, planBloodTestMove, BLOOD_TEST_METRICS,
  type ApiMeasurement, type RoadmapFile,
} from '@roadmap/health-core';
import { BatchDateCell, BloodTestTimeline } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import { MOVE_CHANGED, MOVE_LPA, MOVE_TYPED, useMoveTest } from './MoveTestPanel';
import type { ApiLabValue } from '../lib/api-types';

const FROM = '2024-03-12';
const TO = '2024-02-21';
const NOW = '2026-10-30T00:00:00.000Z';

let file: RoadmapFile;
const day = (d: string) => `${d}T00:00:00.000Z`;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  file = createEmptyFile({ deviceId: 'move_ui', now: NOW });
  file.measurements.push(
    createMeasurement({ id: 'ldl1', metricType: 'ldl', value: 3.2, recordedAt: day(FROM), createdAt: day(FROM) }),
    createMeasurement({ id: 'psa1', metricType: 'psa', value: 1.1, recordedAt: day(FROM), createdAt: day(FROM) }),
    createMeasurement({ id: 'ldl0', metricType: 'ldl', value: 3.6, recordedAt: day('2023-01-05'), createdAt: day('2023-01-05') }),
  );
  file.labValues.push({
    id: 'fer1', metricName: 'ferritin', value: 210, unit: 'µg/L', referenceLow: null, referenceHigh: null,
    recordedAt: FROM, createdAt: day(FROM), source: 'manual', status: 'active', correctsId: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const history = (): ApiMeasurement[] => file.measurements
  .filter(m => m.status === 'active' && BLOOD_TEST_METRICS.includes(m.metricType)) as ApiMeasurement[];

/** Both matrices and the page's one move, as InputPanel lays them out. */
function Page({ onMove, unitSystem, bloodTestHistory, labValues }: {
  onMove: Mock; unitSystem: 'si' | 'conventional'; bloodTestHistory: ApiMeasurement[]; labValues: ApiLabValue[];
}) {
  const api = { preview: (from: string, to: string) => planBloodTestMove(file, from, to, { now: NOW, latestDay: '2026-10-30' }), move: onMove };
  const move = useMoveTest({ api, unitSystem, unitOverrides: {}, bloodTestHistory, labValues });
  return <>
    <BloodTestTimeline bloodTestHistory={bloodTestHistory} unitSystem={unitSystem} unitOverrides={{}} onToggleFieldUnit={() => {}}
      onSaveBatch={vi.fn().mockResolvedValue(new Map())} onCorrectValue={vi.fn().mockResolvedValue('ok')} move={move.headers}
      onDraftValue={() => {}} isSaving={false} grading={{}} hasApiResponse/>
    {move.panel}
    <AdditionalLabRows labValues={labValues} move={move.headers}/>
  </>;
}

function matrix(onMove: Mock = vi.fn().mockResolvedValue({ status: 'ok' }), unitSystem: 'si' | 'conventional' = 'si') {
  const view = render(<Page onMove={onMove} unitSystem={unitSystem} bloodTestHistory={history()} labValues={file.labValues as ApiLabValue[]}/>);
  return { view, onMove, ...helpers(view.container) };
}

/** `scope` holds the headers: the blood test matrix unless a lab group is named. */
function helpers(root: HTMLElement, scope = '.bt-timeline') {
  const header = (date: string) => Array.from(root.querySelector(scope)!.querySelectorAll<HTMLButtonElement>('.bt-cell-movable'))
    .find(b => b.querySelector('input')!.value === date)!;
  const pick = (from: string, to: string) => {
    const input = header(from).querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: to } });
  };
  const panel = () => root.querySelector<HTMLElement>('.bt-move-panel');
  const moveButton = () => within(panel()!).getByRole('button', { name: 'Move' }) as HTMLButtonElement;
  const status = () => root.querySelector('.bt-move-status')?.textContent;
  return { header, pick, panel, moveButton, status };
}

describe('US-04 AC5: the saved column header', () => {
  it('is a button titled "Change this test\'s date" on the blood test matrix', () => {
    const { header } = matrix();
    expect(header(FROM).title).toBe("Change this test's date");
  });

  it('stays a plain header without a move (the vitals matrix)', () => {
    const view = render(<BatchDateCell date={FROM} pinned={false}/>);
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('picking a day writes nothing and opens a panel naming every value that moves', async () => {
    const { pick, panel, onMove } = matrix();
    pick(FROM, TO);
    await wait(0);
    expect(onMove).not.toHaveBeenCalled();
    expect(panel()!.textContent).toContain("Move the blood test from 12 Mar '24 to 21 Feb '24? 3 values move.");
    const listed = Array.from(panel()!.querySelectorAll('li')).map(li => li.textContent);
    expect(listed).toEqual(['LDL Cholesterol 3.2 mmol/L', 'PSA 1.1 ng/mL', 'Ferritin 210 µg/L']);
  });

  it('is disabled while its column holds typed text', async () => {
    const { view, header } = matrix();
    const fromCell = view.container.querySelectorAll<HTMLInputElement>('[data-metric="apob"] .bt-cell-backfill input')[1];
    fireEvent.change(fromCell, { target: { value: '0.9' } });
    expect(header(FROM).disabled).toBe(true);
  });

  it('Cancel closes the panel and writes nothing', async () => {
    const { pick, panel, onMove } = matrix();
    pick(FROM, TO);
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Cancel' }));
    expect(panel()).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('US-04 AC5: the panel', () => {
  it('Move moves the shown rows and says where they went', async () => {
    const { pick, moveButton, panel, status, onMove } = matrix();
    pick(FROM, TO);
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).toHaveBeenCalledWith(FROM, TO, ['ldl1', 'psa1', 'fer1'], {});
    expect(panel()).toBeNull();
    expect(status()).toBe("Moved to 21 Feb '24.");
  });

  it('asks about each clash with no default, and Move waits for the answer', async () => {
    file.measurements.push(createMeasurement({ id: 'ldlT', metricType: 'ldl', value: 2.9, recordedAt: day(TO), createdAt: day(TO) }));
    const { pick, moveButton, panel, onMove } = matrix();
    pick(FROM, TO);
    const radios = within(panel()!).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map(r => r.parentElement!.textContent)).toEqual([' keep 2.9 mmol/L (already there)', ' use 3.2 mmol/L (moving)']);
    expect(panel()!.querySelector('legend')!.textContent).toBe("LDL Cholesterol on 21 Feb '24:");
    expect(radios.some(r => r.checked)).toBe(false);
    expect(moveButton().disabled).toBe(true);
    fireEvent.click(radios[0]);
    expect(moveButton().disabled).toBe(false);
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).toHaveBeenCalledWith(FROM, TO, ['ldl1', 'psa1', 'fer1'], { ldlT: 'held' });
  });

  it('marks a value already on the new day as the same, and asks nothing about it', () => {
    file.measurements.push(createMeasurement({ id: 'ldlT', metricType: 'ldl', value: 3.2, recordedAt: day(TO), createdAt: day(TO) }));
    const { pick, panel, moveButton } = matrix();
    pick(FROM, TO);
    expect(within(panel()!).queryAllByRole('radio')).toEqual([]);
    expect(panel()!.querySelector('li')!.textContent).toBe('LDL Cholesterol 3.2 mmol/L (already there, same value)');
    expect(moveButton().disabled).toBe(false);
  });

  it('says an uploaded report keeps its own date', () => {
    file.documents.push({ id: 'd1', title: 'Labs', type: 'pathology_report', date: FROM, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: NOW });
    const { pick, panel } = matrix();
    pick(FROM, TO);
    expect(panel()!.textContent).toContain('The uploaded report keeps its own date.');
  });

  it('a changed test closes the panel and says nothing moved', async () => {
    const { pick, moveButton, panel, status } = matrix(vi.fn().mockResolvedValue({ status: 'changed' }));
    pick(FROM, TO);
    fireEvent.click(moveButton());
    await wait(0);
    expect(panel()).toBeNull();
    expect(status()).toBe(MOVE_CHANGED);
  });

  it('a refused move keeps the panel open with the reason', async () => {
    const refusal = { ok: false, reason: 'future-date', message: 'x' };
    const { pick, moveButton, panel } = matrix(vi.fn().mockResolvedValue({ status: 'invalid', refusal }));
    pick(FROM, TO);
    fireEvent.click(moveButton());
    await wait(0);
    expect(panel()!.textContent).toContain('That day has not happened yet.');
  });

  it('a day holding two values for one test is refused before Move is offered', () => {
    file.measurements.push(createMeasurement({ id: 'ldl1b', metricType: 'ldl', value: 3.3, recordedAt: FROM, createdAt: day(FROM) }));
    const { pick, panel } = matrix();
    pick(FROM, TO);
    expect(panel()!.textContent).toContain("This test has two values for LDL Cholesterol on 12 Mar '24. Correct one first.");
    expect(within(panel()!).queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('typing into the column after the panel opened writes nothing at the press (Codex R2)', async () => {
    const { view, pick, moveButton, panel, status, onMove } = matrix();
    pick(FROM, TO);
    const fromCell = view.container.querySelectorAll<HTMLInputElement>('[data-metric="apob"] .bt-cell-backfill input')[1];
    fireEvent.change(fromCell, { target: { value: '0.9' } });
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(status()).toBe(MOVE_TYPED);
  });

  it('an open editor on the column at the press writes nothing (adversary R5)', async () => {
    const { view, pick, moveButton, panel, status, onMove } = matrix();
    pick(FROM, TO);
    const ldlCells = view.container.querySelectorAll<HTMLElement>('[data-metric="ldl"] .bt-cell-clickable');
    fireEvent.click(ldlCells[ldlCells.length - 1]); // FROM's LDL, the later column
    expect(view.container.querySelector('[data-metric="ldl"] input')).not.toBeNull();
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(status()).toBe(MOVE_TYPED);
  });

  it('waits while an Lp(a) value on the day has an unanswered check (adversary R1)', () => {
    file.measurements.push(createMeasurement({
      id: 'lpa1', metricType: 'lpa', value: 37.44, recordedAt: day(FROM), createdAt: '2026-09-20T04:00:00.000Z', source: 'manual',
    }));
    const { pick, panel, moveButton } = matrix(undefined, 'conventional');
    pick(FROM, TO);
    expect(panel()!.textContent).toContain(MOVE_LPA);
    expect(moveButton().disabled).toBe(true);
  });

  it('enables Move once the Lp(a) check is answered "keep as saved", and moves (Codex R1)', async () => {
    file.measurements.push(createMeasurement({
      id: 'lpa1', metricType: 'lpa', value: 37.44, recordedAt: day(FROM), createdAt: '2026-09-20T04:00:00.000Z', source: 'manual',
    }));
    const { view, pick, panel, moveButton, onMove } = matrix(undefined, 'conventional');
    pick(FROM, TO);
    expect(moveButton().disabled).toBe(true);
    fireEvent.click(within(view.container.querySelector<HTMLElement>('.lpa-check')!).getByRole('button', { name: 'Neither of these (keep as saved)' }));
    await wait(0);
    expect(panel()!.textContent).not.toContain(MOVE_LPA);
    expect(moveButton().disabled).toBe(false);
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).toHaveBeenCalledWith(FROM, TO, ['ldl1', 'psa1', 'lpa1', 'fer1'], {});
  });
});

describe('US-04 AC5: a lab group header moves the same test', () => {
  it('opens the same panel from an additional lab group', async () => {
    const { view, onMove } = matrix();
    fireEvent.click(view.container.querySelector('.alr-group-header')!);
    const { pick, panel, moveButton } = helpers(view.container, '.alr-wrap');
    pick(FROM, TO);
    expect(view.container.querySelectorAll('.bt-move-panel').length).toBe(1);
    expect(panel()!.querySelectorAll('li').length).toBe(3);
    fireEvent.click(moveButton());
    await wait(0);
    expect(onMove).toHaveBeenCalledWith(FROM, TO, ['ldl1', 'psa1', 'fer1'], {});
  });

  it('is disabled while the blood test matrix holds typed text on that day, and Move then writes nothing (Codex R2)', async () => {
    const { view, onMove } = matrix();
    fireEvent.click(view.container.querySelector('.alr-group-header')!);
    const lab = helpers(view.container, '.alr-wrap');
    const labHeader = lab.header(FROM);
    lab.pick(FROM, TO);
    expect(labHeader.disabled).toBe(false);
    const fromCell = view.container.querySelectorAll<HTMLInputElement>('[data-metric="apob"] .bt-cell-backfill input')[1];
    fireEvent.change(fromCell, { target: { value: '0.9' } });
    expect(labHeader.disabled).toBe(true);
    fireEvent.click(lab.moveButton());
    await wait(0);
    expect(onMove).not.toHaveBeenCalled();
    expect(lab.status()).toBe(MOVE_TYPED);
  });
});

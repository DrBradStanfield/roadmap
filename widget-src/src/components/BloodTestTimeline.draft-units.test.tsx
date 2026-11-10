// @vitest-environment jsdom
/**
 * US-04 AC1, US-34 AC7, US-05 AC2: every blood-test draft cell carries the
 * unit it was typed in. A unit chosen on this page says what the numbers
 * typed are in (Brad, 2026-10-13): a switch here re-reads every typed cell of
 * the fields it changes, typed by hand, filled by the chat or restored. A unit
 * system that comes from the record re-reads none: each cell keeps its
 * quantity, shown in the new unit. (Lp(a)'s own rule: BloodTestTimeline.lpa.test.tsx.)
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useState, type MutableRefObject } from 'react';
import { toCanonicalValue, type UnitSystem } from '@roadmap/health-core/units';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { BloodTestTimeline, type BloodTestPrefillFn } from './BloodTestTimeline';
import { press, pressMouse, releaseMouse, showPage, typeInto } from '../testing/matrix-gestures';
import { cellText } from '../lib/blood-test-cell';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import type { SaveTask } from '../lib/matrix-save';

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { cleanup(); showPage(); vi.useRealTimers(); });

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const other = (unit: UnitSystem): UnitSystem => (unit === 'si' ? 'conventional' : 'si');
const mgdl = (n: number) => toCanonicalValue('ldl', n, 'conventional');
/** 3.5 mmol/L, as the matrix shows it in mg/dL. */
const shownInMgdl = cellText('ldl', 3.5, 'conventional');
const restore = (state: object) => localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify(state));

function history(rows: Array<[string, number, string]>): ApiMeasurement[] {
  return rows.map(([metricType, value, day], i) => ({
    id: `row${i}`, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, status: 'active',
  }));
}

/** The matrix as HealthTool keeps it: the global pill and each chip are
 *  choices made here (useUnits counts them); `remote` is a unit system the
 *  record brings, which is not. */
function page(rows: ApiMeasurement[] = []) {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const remote = { to: (_: UnitSystem) => {} };
  function Page() {
    const [system, setSystem] = useState<UnitSystem>('si');
    const [overrides, setOverrides] = useState<Record<string, UnitSystem>>({});
    const [choices, setChoices] = useState(0);
    remote.to = (unit) => setSystem(unit);
    const toggle = (field: string) => { setOverrides((o) => ({ ...o, [field]: other(o[field] ?? system) })); setChoices((n) => n + 1); };
    return (
      <>
        <BloodTestTimeline bloodTestHistory={rows} unitSystem={system} unitOverrides={overrides} onToggleFieldUnit={toggle} unitChoices={choices}
          onSaveBatch={onSaveBatch} onDraftValue={() => {}} isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>
        <button type="button" data-unit-control="all" onClick={() => { setSystem(other(system)); setOverrides({}); setChoices((n) => n + 1); }}>Units</button>
        <button type="button">Elsewhere</button>
      </>
    );
  }
  const view = render(<Page/>);
  const row = (label: string) => Array.from(view.container.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === label) as HTMLElement;
  const cell = (label: string, sel = '.bt-cell-draft input') => row(label).querySelector(sel) as HTMLInputElement;
  const ldl = () => cell('LDL Cholesterol');
  /** A mouse click: the press, the release, the click. */
  const click = (el: HTMLElement) => { pressMouse(el); releaseMouse(el); };
  const pill = () => click(view.getByRole('button', { name: 'Units' }));
  const chip = () => click(row('LDL Cholesterol').querySelector('.bt-unit-chip') as HTMLElement);
  const fromRecord = (unit: UnitSystem) => act(() => remote.to(unit));
  /** Into the matrix, and out: the gesture that commits the draft (US-03 AC5). */
  const leave = async () => { press(ldl()); press(view.getByRole('button', { name: 'Elsewhere' })); await wait(0); };
  /** What the commit saved, by metric and day, in SI. */
  const saved = () => Object.assign({}, ...(onSaveBatch.mock.calls[0][0] as SaveTask[]).map((t) => Object.fromEntries(Object.entries(t.values).map(([m, v]) => [`${m}@${t.date}`, v]))));
  return { view, cell, ldl, pill, chip, fromRecord, leave, saved, prefillRef };
}

describe('US-04 AC1, US-05 AC2: a unit chosen here re-reads every typed blood-test cell of the fields it changes (Brad, 2026-10-13)', () => {
  // A press on the page's pill, outside the matrix, commits a hand-typed
  // draft first (useSaveOnLeave); the row's own chip, inside it, does not.
  it('3.5 typed by hand in mmol/L, then its chip: it reads 3.5 mg/dL and saves so', async () => {
    const p = page();
    typeInto(p.ldl(), '3.5');
    p.chip();
    expect(p.ldl().value).toBe('3.5');
    await p.leave();
    expect(Object.values(p.saved())).toEqual([expect.closeTo(mgdl(3.5), 6)]);
  });

  it('the chip re-reads only its field: LDL 3.5 reads mg/dL, HDL 1.2 stays mmol/L', async () => {
    const p = page();
    typeInto(p.cell('HDL Cholesterol'), '1.2');
    typeInto(p.ldl(), '3.5');
    p.chip();
    expect(p.ldl().value).toBe('3.5');
    expect(p.cell('HDL Cholesterol').value).toBe('1.2');
    await p.leave();
    const saved = p.saved();
    expect(Object.entries(saved).find(([k]) => k.startsWith('ldl@'))![1]).toBeCloseTo(mgdl(3.5), 6);
    expect(Object.entries(saved).find(([k]) => k.startsWith('hdl@'))![1]).toBe(1.2);
  });

  it('a value the chat filled is re-read too: 3.5 mmol/L filled, then the pill, saves 3.5 mg/dL', async () => {
    const p = page();
    act(() => { p.prefillRef.current!('ldl', 3.5, 'si', null); });
    p.pill();
    expect(p.ldl().value).toBe('3.5');
    await p.leave();
    expect(Object.values(p.saved())).toEqual([expect.closeTo(mgdl(3.5), 6)]);
  });

  it('a restored draft and a restored saved column\'s empty cell are re-read too', async () => {
    restore({ draft: { values: { ldl: '3.5' } }, backfills: { '2026-08-15': { ldl: '2.5' } },
      meta: { 'new|ldl': { unit: 'si', typedOn: 'an earlier load' }, '2026-08-15|ldl': { unit: 'si', typedOn: 'an earlier load' } } });
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    p.pill();
    expect(p.ldl().value).toBe('3.5');
    await p.leave();
    const saved = p.saved();
    expect(Object.keys(saved)).toHaveLength(2);
    expect(saved['ldl@2026-08-15']).toBeCloseTo(mgdl(2.5), 6);
    expect(Object.entries(saved).find(([k]) => k !== 'ldl@2026-08-15')![1]).toBeCloseTo(mgdl(3.5), 6);
  });
});

describe('US-04 AC1, US-34 AC7: a unit system from the record keeps every blood-test draft\'s quantity', () => {
  it('3.5 typed by hand in mmol/L: the record switches to US units; it shows in mg/dL and saves 3.5 mmol/L', async () => {
    const p = page();
    typeInto(p.ldl(), '3.5');
    act(() => { (document.activeElement as HTMLElement).blur(); });
    p.fromRecord('conventional');
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });

  it('a value the chat filled, and a saved column\'s empty cell, keep theirs too', async () => {
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    act(() => { p.prefillRef.current!('ldl', 3.5, 'si', null); });
    typeInto(p.cell('LDL Cholesterol', '.bt-cell-backfill input'), '2.5');
    p.fromRecord('conventional');
    await p.leave();
    const saved = p.saved();
    expect(saved['ldl@2026-08-15']).toBe(2.5);
    expect(Object.entries(saved).find(([k]) => k !== 'ldl@2026-08-15')![1]).toBe(3.5);
  });

  it('a chip click after the record\'s switch re-reads in the unit chosen: 3.5 mmol/L shown in mg/dL, then mmol/L, saves 3.5 mmol/L', async () => {
    const p = page();
    typeInto(p.ldl(), '3.5');
    p.fromRecord('conventional');
    p.chip(); // back to mmol/L: the text "3.5" is read in the unit now chosen
    expect(p.ldl().value).toBe('3.5');
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });

  // Legacy: a cell kept before cells carried their unit is stamped as it is
  // restored, with the unit the page shows then (this device's preference).
  it('a draft kept with no unit is read in the unit shown when it is restored: the record\'s switch later keeps 3.5 mmol/L', async () => {
    restore({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: {} });
    const p = page();
    expect(p.ldl().value).toBe('3.5');
    p.fromRecord('conventional');
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });
});

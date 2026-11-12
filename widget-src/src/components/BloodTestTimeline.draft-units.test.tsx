// @vitest-environment jsdom
/**
 * US-04 AC1, US-34 AC7, US-05 AC2: every blood-test draft cell carries the
 * unit it was typed in. A unit chosen on this page says what the numbers
 * typed are in (Brad, 2026-10-13): a row's own chip re-reads the cells of its
 * test typed by hand on this load of the page, as Lp(a)'s control does. Every
 * other cell keeps its quantity, shown in the new unit: one the chat filled,
 * one restored, and every cell through the page's pill, another surface's
 * chip or a unit system the record brings. (Lp(a): BloodTestTimeline.lpa.test.tsx.)
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, act, within } from '@testing-library/react';
import { useRef, useState, type MutableRefObject } from 'react';
import { useUnits } from '../hooks/useUnits';
import { toCanonicalValue, type UnitSystem } from '@roadmap/health-core/units';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { BloodTestTimeline, type BloodTestPrefillFn } from './BloodTestTimeline';
import { press, pressMouse, releaseMouse, showPage, typeInto } from '../testing/matrix-gestures';
import { cellText } from '../lib/blood-test-cell';
import { BT_TIMELINE_DRAFT_KEY, noteDevicePage } from '../lib/storage';
import type { SaveTask } from '../lib/matrix-save';

// This page's record is open, on this device: the drafts and Lp(a) answers it keeps are its own (US-11 AC6).
noteDevicePage();

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

/** The matrix as HealthTool keeps it. The page's pill and the upload
 *  review's chip (`elsewhere`) switch units outside the matrix; `fromRecord`
 *  is a unit system the record brings. `start`: this device's units before
 *  the record applied (useUnits' `startUnitOf`). */
function page(rows: ApiMeasurement[] = [], start?: UnitSystem, mountedIn: UnitSystem = 'si') {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const outside = { remote: (_: UnitSystem) => {}, toggle: (_: string) => {} };
  // The page's switch, as useUnits tells the matrix (`onSwitch`).
  const switches = new Set<(from: UnitSystem, to: UnitSystem) => void>();
  const onUnitSwitch = (listener: (from: UnitSystem, to: UnitSystem) => void) => { switches.add(listener); return () => { switches.delete(listener); }; };
  function Page() {
    const [system, setSystem] = useState<UnitSystem>(mountedIn);
    const [overrides, setOverrides] = useState<Record<string, UnitSystem>>({});
    const toggle = (field: string) => { // the turn, as useUnits reports it
      const from = overrides[field] ?? system;
      setOverrides((o) => ({ ...o, [field]: other(from) }));
      return { from, to: other(from) };
    };
    outside.remote = (unit) => setSystem(unit);
    outside.toggle = toggle;
    return (
      <>
        <BloodTestTimeline bloodTestHistory={rows} unitSystem={system} unitOverrides={overrides} onToggleFieldUnit={toggle}
          startUnitOf={start && (() => start)} onUnitSwitch={onUnitSwitch}
          onSaveBatch={onSaveBatch} onDraftValue={() => {}} isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>
        <button type="button" data-unit-control="all" onClick={() => {
          for (const listener of switches) listener(system, other(system));
          setSystem(other(system)); setOverrides({});
        }}>Units</button>
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
  /** LDL's unit toggled on another surface (the upload review's chip). */
  const elsewhere = () => act(() => outside.toggle('ldlC'));
  const fromRecord = (unit: UnitSystem) => act(() => outside.remote(unit));
  /** Into the matrix, and out: the gesture that commits the draft (US-03 AC5). */
  const leave = async () => { press(ldl()); press(view.getByRole('button', { name: 'Elsewhere' })); await wait(0); };
  /** What the commit saved, by metric and day, in SI. */
  const saved = (call = 0): Record<string, number> => Object.assign({}, ...(onSaveBatch.mock.calls.at(call)![0] as SaveTask[])
    .map((t) => Object.fromEntries(Object.entries(t.values).map(([m, v]) => [`${m}@${t.date}`, v]))));
  return { row, cell, ldl, pill, chip, elsewhere, fromRecord, leave, saved, prefillRef };
}
/** The draft column's saved value for `metric` (the saved column here is 2026-08-15). */
const draftValue = (saved: Record<string, number>, metric = 'ldl') =>
  Object.entries(saved).find(([k]) => k.startsWith(`${metric}@`) && k !== `${metric}@2026-08-15`)![1];

describe('US-04 AC1, US-05 AC2: a row\'s chip re-reads the cells typed by hand on this load (Brad, 2026-10-13)', () => {
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
    expect(draftValue(p.saved())).toBeCloseTo(mgdl(3.5), 6);
    expect(draftValue(p.saved(), 'hdl')).toBe(1.2);
  });

  it('a value the chat filled keeps its quantity through the chip: 3.5 mmol/L shows in mg/dL and saves 3.5', async () => {
    const p = page();
    act(() => { p.prefillRef.current!('ldl', 3.5, 'si', null); });
    p.chip();
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });

  it('a restored draft and a restored saved column\'s empty cell keep theirs through the chip', async () => {
    restore({ draft: { values: { ldl: '3.5' } }, backfills: { '2026-08-15': { ldl: '2.5' } },
      meta: { 'new|ldl': { unit: 'si', typedOn: 'an earlier load' }, '2026-08-15|ldl': { unit: 'si', typedOn: 'an earlier load' } } });
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    p.chip();
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(p.saved()['ldl@2026-08-15']).toBe(2.5);
    expect(draftValue(p.saved())).toBe(3.5);
  });
});

describe('US-04 AC1, US-34 AC7: a unit switched outside the matrix re-reads no blood-test draft', () => {
  // A press outside the matrix is leaving it (useSaveOnLeave): the pill
  // commits a hand-typed draft first, in the unit it was typed in.
  it('the page\'s pill commits 3.5 typed by hand in mmol/L first, as 3.5 mmol/L', async () => {
    const p = page();
    typeInto(p.ldl(), '3.5');
    p.pill();
    await wait(0);
    expect(Object.values(p.saved())).toEqual([3.5]);
  });

  // Brad 2026-11-10 (re-check R1, option a): the pill is a unit chosen here
  // too. A hand-typed cell its press could not commit stays, and is re-read.
  it('"135" typed in mmol/L, refused, then the pill: it reads 135 mg/dL, says nothing is wrong, and saves so', async () => {
    const p = page();
    typeInto(p.ldl(), '135');
    expect(p.ldl().getAttribute('aria-invalid')).toBe('true');
    p.pill();
    await wait(0);
    expect(p.ldl().value).toBe('135');
    expect(p.ldl().getAttribute('aria-invalid')).toBe('false');
    await p.leave();
    expect(Object.values(p.saved(-1))).toEqual([expect.closeTo(mgdl(135), 6)]);
  });

  it('a field already in the new unit by its own chip is not re-read: "5300" refused in mg/dL stays mg/dL through the pill to US units', async () => {
    const p = page();
    p.chip(); // LDL in mg/dL, the page in SI
    typeInto(p.ldl(), '5300');
    p.pill();
    await wait(0);
    expect(p.ldl().value).toBe('5300');
    expect(p.ldl().getAttribute('aria-invalid')).toBe('true'); // still over 498 mg/dL, never read as 5300 mmol/L
  });

  it('the pill keeps a chat-filled value\'s quantity, and a restored cell\'s: shown in mg/dL, saved as mmol/L', async () => {
    restore({ draft: { values: {} }, backfills: { '2026-08-15': { ldl: '2.5' } }, meta: { '2026-08-15|ldl': { unit: 'si', typedOn: 'an earlier load' } } });
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    act(() => { p.prefillRef.current!('ldl', 3.5, 'si', null); });
    p.pill();
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(p.saved()['ldl@2026-08-15']).toBe(2.5);
    expect(draftValue(p.saved())).toBe(3.5);
  });

  it('LDL\'s chip on another surface (the upload review) keeps a hand-typed draft\'s quantity', async () => {
    const p = page();
    typeInto(p.ldl(), '3.5');
    p.elsewhere();
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
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
    expect(p.saved()['ldl@2026-08-15']).toBe(2.5);
    expect(draftValue(p.saved())).toBe(3.5);
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

  // Codex R2 (PR 1147): a cell shown in another unit is checked as it is
  // saved, its text in the unit it was typed in. 12.9 mmol/L, the bound,
  // shows "499" mg/dL, over the 498 mg/dL bound, and saves.
  it('a restored LDL of 12.9 mmol/L shown as 499 mg/dL says nothing is wrong, in the draft and a saved column, and saves 12.9', async () => {
    restore({ draft: { values: { ldl: '12.9' } }, backfills: { '2026-08-15': { ldl: '12.9' } },
      meta: { 'new|ldl': { unit: 'si' }, '2026-08-15|ldl': { unit: 'si' } } });
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    p.fromRecord('conventional');
    const backfill = p.cell('LDL Cholesterol', '.bt-cell-backfill input');
    expect(p.ldl().value).toBe(cellText('ldl', 12.9, 'conventional'));
    expect(backfill.value).toBe(cellText('ldl', 12.9, 'conventional'));
    expect(within(p.row('LDL Cholesterol')).queryByText(/Max/)).toBeNull();
    expect(p.ldl().getAttribute('aria-invalid')).toBe('false');
    expect(backfill.getAttribute('aria-invalid')).toBe('false');
    await p.leave();
    expect(p.saved()['ldl@2026-08-15']).toBe(12.9);
    expect(draftValue(p.saved())).toBe(12.9);
  });

  it('one out of range in its own unit still says so after the switch: 13 mmol/L, in the draft and a saved column', () => {
    restore({ draft: { values: { ldl: '13' } }, backfills: { '2026-08-15': { ldl: '13' } },
      meta: { 'new|ldl': { unit: 'si' }, '2026-08-15|ldl': { unit: 'si' } } });
    const p = page(history([['hdl', 1.2, '2026-08-15']]));
    p.fromRecord('conventional');
    expect(p.ldl().getAttribute('aria-invalid')).toBe('true');
    expect(p.cell('LDL Cholesterol', '.bt-cell-backfill input').getAttribute('aria-invalid')).toBe('true');
  });

  // Legacy: a cell kept before cells carried their unit is stamped as it is
  // restored, with the units this device showed before the record applied.
  it('a draft kept with no unit is read in this device\'s starting unit: the record\'s switch later keeps 3.5 mmol/L', async () => {
    restore({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: {} });
    const p = page([], 'si');
    expect(p.ldl().value).toBe('3.5');
    p.fromRecord('conventional');
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });

  // Adversary R4 (PR 1147): the matrix mounts once the whole form opens,
  // which can be after the record's units applied.
  it('mounted after the record brought US units, a draft kept with no unit is still read in this device\'s starting SI', async () => {
    restore({ draft: { values: { ldl: '3.5' } }, backfills: {}, meta: {} });
    const p = page([], 'si', 'conventional');
    expect(p.ldl().value).toBe(shownInMgdl);
    await p.leave();
    expect(Object.values(p.saved())).toEqual([3.5]);
  });
});

// PR 1204 review F2: the chip toggles from the units seen at the press, and so must its
// re-read of the cells typed by hand. A record's units landing mid-press changed only the second.
describe('US-34 AC7a, US-05 AC2: a chip pressed while the record\'s units arrive', () => {
  it('3.5 typed in mmol/L, the chip pressed, the record brings US units before the click: it reads 3.5 mg/dL and saves so', async () => {
    localStorage.setItem('health_roadmap_unit_system', 'si');
    const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
    let units!: ReturnType<typeof useUnits>;
    function Page() {
      const rootRef = useRef<HTMLDivElement>(null);
      units = useUnits(() => {}, rootRef);
      return (
        <div ref={rootRef}>
          <BloodTestTimeline bloodTestHistory={[]} unitSystem={units.unitSystem} unitOverrides={units.unitOverrides}
            onToggleFieldUnit={units.handleToggleFieldUnit} onUnitSwitch={units.onSwitch}
            onSaveBatch={onSaveBatch} onDraftValue={() => {}} isSaving={false} grading={{}} hasApiResponse prefillRef={{ current: null }}/>
          <button type="button">Elsewhere</button>
        </div>
      );
    }
    const view = render(<Page/>);
    const row = () => Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'LDL Cholesterol') as HTMLElement;
    const ldl = () => row().querySelector('.bt-cell-draft input') as HTMLInputElement;
    const chip = () => row().querySelector('.bt-unit-chip') as HTMLElement;
    typeInto(ldl(), '3.5');
    pressMouse(chip());
    act(() => units.record.shown('conventional')); // the record's units, never held
    releaseMouse(chip());
    expect(ldl().value).toBe('3.5');
    expect(chip().textContent).toBe('mg/dL');
    press(ldl());
    press(view.getByRole('button', { name: 'Elsewhere' }));
    await wait(0);
    const tasks = onSaveBatch.mock.calls.at(0)![0] as SaveTask[];
    expect(tasks.flatMap((t) => Object.values(t.values))).toEqual([expect.closeTo(mgdl(3.5), 6)]);
  });
});

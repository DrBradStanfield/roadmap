// @vitest-environment jsdom
/**
 * US-05 AC2: Lp(a)'s field takes three units, nmol/L, mg/dL and mg/L, on one
 * control. The unit chosen is kept in the record; with none chosen the field
 * opens in the country's unit, or in the unit the old build's toggle chose.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import { localDay, parseProposedEdit, PROPOSE_FIELD_EDIT_TOOL, type ApiMeasurement, type MetricType, type ProposedFieldEdit, type UnitSystem } from '@roadmap/health-core';
import type { MutableRefObject } from 'react';
import { BloodTestTimeline, ValueCell, type BloodTestPrefillFn } from './BloodTestTimeline';
import { press, pressMouse, pressWithoutFocus, releaseMouse, showPage, typeInto } from '../testing/matrix-gestures';
import { BT_TIMELINE_DRAFT_KEY } from '../lib/storage';
import type { SaveTask } from '../lib/matrix-save';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';

// The record's profile.lpaUnit, in memory: what RoadmapStore keeps (its own suite).
const record = vi.hoisted(() => ({ lpaUnit: undefined as string | undefined, set: [] as string[] }));
vi.mock('../lib/roadmap-data', async (original) => ({
  ...(await original<typeof import('../lib/roadmap-data')>()),
  getLpaUnit: () => record.lpaUnit,
  setLpaUnit: (unit: string) => { record.lpaUnit = unit; record.set.push(unit); },
}));
const { trackProductEvent } = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/server-api', async (original) => ({ ...(await original<typeof import('../lib/server-api')>()), trackProductEvent }));

const LEGACY_KEY = 'health_roadmap_unit_overrides';
const UNCLEAR = 'Re-enter this value: its unit is unclear after an update.';
const TODAY = localDay(new Date());

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  record.lpaUnit = undefined;
  record.set = [];
  trackProductEvent.mockClear();
});
afterEach(() => {
  cleanup();
  showPage();
  vi.useRealTimers();
});

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function history(rows: Array<[string, number, string]>): ApiMeasurement[] {
  return rows.map(([metricType, value, day], i) => ({
    id: `row${i}`, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, status: 'active',
  }));
}

function matrix({ unitSystem = 'si' as UnitSystem, rows = [] as ApiMeasurement[] } = {}) {
  const onSaveBatch: Mock = vi.fn().mockResolvedValue(new Map());
  const onToggleFieldUnit = vi.fn();
  const onCorrectValue: Mock = vi.fn().mockResolvedValue('ok');
  const prefillRef: MutableRefObject<BloodTestPrefillFn | null> = { current: null };
  const view = render(
    <>
      <BloodTestTimeline bloodTestHistory={rows} unitSystem={unitSystem} unitOverrides={{}} onToggleFieldUnit={onToggleFieldUnit}
        onSaveBatch={onSaveBatch} onCorrectValue={onCorrectValue} onDraftValue={() => {}} isSaving={false} grading={{}} hasApiResponse prefillRef={prefillRef}/>
      <button type="button">Elsewhere</button>
    </>,
  );
  const row = (label: string) => Array.from(view.container.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === label) as HTMLElement;
  const lpa = () => row('Lp(a)');
  const draft = () => lpa().querySelector('.bt-cell-draft input') as HTMLInputElement;
  const units = () => within(lpa()).getAllByRole('radio').map((b) => b.textContent);
  const active = () => within(lpa()).getByRole('radio', { checked: true }).textContent;
  const choose = (unit: string) => fireEvent.click(within(lpa()).getByRole('radio', { name: unit }));
  const hint = () => lpa().querySelector('.bt-ref-label')?.textContent;
  const tick = () => draft().closest('.bt-cell-value')!.querySelector('.bt-status-tick')?.className.replace('bt-status-tick ', '');
  /** Into the matrix, and out: the gesture that commits the draft (US-03 AC5). */
  const leave = async () => { press(draft()); press(view.getByRole('button', { name: 'Elsewhere' })); await wait(0); };
  const sent = (call = 0) => onSaveBatch.mock.calls[call][0] as SaveTask[];
  /** Another device's choice of unit, merged in: the page re-reads the record. */
  const remote = (unit: string) => {
    record.lpaUnit = unit;
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
  };
  /** A click on a unit of the control, as a mouse makes it: the press, the release, the click. */
  const clickUnit = (unit: string) => {
    pressMouse(within(lpa()).getByRole('radio', { name: unit }));
    releaseMouse(within(lpa()).getByRole('radio', { name: unit }));
  };
  return { view, row, lpa, draft, units, active, choose, hint, tick, leave, sent, remote, clickUnit, onSaveBatch, onCorrectValue, onToggleFieldUnit, prefillRef };
}

describe('US-05 AC2 — the Lp(a) field: three units on one control', () => {
  it('offers nmol/L, mg/dL and mg/L; US units open in mg/dL, with the hint in mg/dL', () => {
    const m = matrix({ unitSystem: 'conventional' });
    expect(m.units()).toEqual(['nmol/L', 'mg/dL', 'mg/L']);
    expect(m.active()).toBe('mg/dL');
    expect(m.hint()).toBe('Normal: <30 mg/dL');
    // Lp(a) has no two-way chip; every other field keeps its own.
    expect(m.lpa().querySelector('.bt-unit-chip')).toBeNull();
    expect(m.row('LDL Cholesterol').querySelector('.bt-unit-chip')?.textContent).toBe('mg/dL');
  });

  it('any other unit setting opens in nmol/L', () => {
    const m = matrix({ unitSystem: 'si' });
    expect(m.active()).toBe('nmol/L');
    expect(m.hint()).toBe('Normal: <75 nmol/L');
  });

  it('a click chooses the unit, keeps it in the record, and the hint follows; no two-way override is written', () => {
    const m = matrix({ unitSystem: 'conventional' });
    m.choose('mg/L');
    expect(record.set).toEqual(['mg/L']);
    expect(m.active()).toBe('mg/L');
    expect(m.hint()).toBe('Normal: <300 mg/L');
    expect(m.onToggleFieldUnit).not.toHaveBeenCalled();
  });

  it('the unit kept in the record wins over the country default', () => {
    record.lpaUnit = 'mg/L';
    expect(matrix({ unitSystem: 'conventional' }).active()).toBe('mg/L');
  });

  it('legacy: the old toggle set to conventional opens in mg/L, set to SI in nmol/L; it is read, never rewritten', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ lpa: 'conventional' }));
    const m = matrix({ unitSystem: 'si' });
    expect(m.active()).toBe('mg/L');
    m.choose('nmol/L');
    expect(m.active()).toBe('nmol/L');
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify({ lpa: 'conventional' }));
    cleanup();

    record.lpaUnit = undefined;
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ lpa: 'si' }));
    expect(matrix({ unitSystem: 'conventional' }).active()).toBe('nmol/L');
  });

  it('a number typed is read in the unit shown: 156 mg/dL saves 390 nmol/L, 93 mg/L saves 23.25', async () => {
    const m = matrix({ unitSystem: 'conventional' });
    typeInto(m.draft(), '156');
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ date: TODAY, values: { lpa: 390 } })]);

    m.choose('mg/L');
    typeInto(m.draft(), '93');
    await m.leave();
    expect(m.sent(1)[0].values.lpa).toBeCloseTo(23.25, 9);
  });

  // Brad's ruling, 2026-10-13: a unit chosen on this page says what the
  // number typed is in. "Type 40, click mg/dL" means 40 mg/dL, as in every
  // other field's draft cells, which read their text in the unit shown.
  it('a unit clicked here after typing re-reads the number typed: 40 in nmol/L, then mg/dL, shows 40 and saves 100 nmol/L', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix();
    typeInto(m.draft(), '40');
    m.clickUnit('mg/dL');
    expect(m.active()).toBe('mg/dL');
    expect(m.draft().value).toBe('40');
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ values: { lpa: 100 }, unit: 'mg/dL' })]);
  });

  it('in a saved column\'s empty cell, too: 40 in nmol/L, then mg/dL, saves 100 nmol/L', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix({ rows: history([['ldl', 3.2, '2026-08-15']]) });
    const cell = () => m.lpa().querySelector('.bt-cell-backfill input') as HTMLInputElement;
    typeInto(cell(), '40');
    m.clickUnit('mg/dL');
    expect(cell().value).toBe('40');
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ date: '2026-08-15', values: { lpa: 100 } })]);
  });

  it('another device\'s switch keeps the unit typed in: 60 mg/dL shows 150 nmol/L, Elevated, and saves 150', async () => {
    const m = matrix({ unitSystem: 'conventional' });
    typeInto(m.draft(), '60');
    m.remote('nmol/L');
    expect(m.active()).toBe('nmol/L');
    expect(m.draft().value).toBe('150');
    expect(m.tick()).toBe('bt-status-bad');
    m.remote('mg/L');
    expect(m.draft().value).toBe('600');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBeCloseTo(150, 9);
  });

  it('a cell kept in its own unit by another device\'s switch keeps it through a click here: 40 nmol/L shown as 16 mg/dL, then mg/L, saves 40', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix();
    typeInto(m.draft(), '40');
    m.remote('mg/dL');
    expect(m.draft().value).toBe('16.0');
    m.clickUnit('mg/L');
    expect(m.draft().value).toBe('160');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(40);
  });

  it('typing after a switch is in the unit now shown', async () => {
    const m = matrix({ unitSystem: 'conventional' });
    typeInto(m.draft(), '60');
    m.choose('nmol/L');
    typeInto(m.draft(), '70');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(70);
  });

  it('the range is checked in the unit shown: 3000 mg/L is the bound', () => {
    record.lpaUnit = 'mg/L';
    const m = matrix();
    typeInto(m.draft(), '3001');
    expect(within(m.lpa()).getByText('Max 3000 mg/L')).toBeTruthy();
    typeInto(m.draft(), '2000');
    expect(within(m.lpa()).queryByText(/^Max/)).toBeNull();
  });

  // US-05 AC2 / US-03 AC5: a number out of range in the unit it was typed in
  // keeps its error after a switch, though it rounds onto the bound in the
  // unit now shown (750.1 nmol/L reads "300.0" mg/dL), and nothing saves.
  it('a number out of range in its own unit keeps its error after another device\'s switch, and saves nothing', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix();
    typeInto(m.draft(), '750.1');
    m.remote('mg/dL');
    expect(m.draft().value).toBe('300.0');
    expect(within(m.lpa()).getByText('Max 750 nmol/L')).toBeTruthy();
    await m.leave();
    expect(m.onSaveBatch).not.toHaveBeenCalled();
  });

  it('in a saved column’s empty cell, too', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix({ rows: history([['ldl', 3.2, '2026-08-15']]) });
    const cell = () => m.lpa().querySelector('.bt-cell-backfill input') as HTMLInputElement;
    typeInto(cell(), '750.1');
    m.remote('mg/dL');
    expect(cell().value).toBe('300.0');
    expect(within(m.lpa()).getByText('Max 750 nmol/L')).toBeTruthy();
    await m.leave();
    expect(m.onSaveBatch).not.toHaveBeenCalled();
  });
});

describe('US-05 AC2 — the usage signal: lpa_unit_selected { unit, from }', () => {
  const sent = () => trackProductEvent.mock.calls.filter(([name]) => name === 'lpa_unit_selected').map(([, meta]) => meta);

  it('fires once per change, by click or arrow key, with the two unit labels', () => {
    const m = matrix({ unitSystem: 'conventional' });
    m.choose('mg/L');
    expect(sent()).toEqual([{ unit: 'mg/L', from: 'mg/dL' }]);
    fireEvent.keyDown(within(m.lpa()).getByRole('radio', { name: 'mg/L' }), { key: 'ArrowLeft' });
    expect(m.active()).toBe('mg/dL');
    expect(sent()).toEqual([{ unit: 'mg/L', from: 'mg/dL' }, { unit: 'mg/dL', from: 'mg/L' }]);
  });

  it('a re-click of the unit already shown sends nothing', () => {
    const m = matrix({ unitSystem: 'si' });
    m.choose('nmol/L');
    expect(sent()).toEqual([]);
  });

  it('never carries a number: only the unit labels, with a value typed in the field', () => {
    const m = matrix({ unitSystem: 'conventional' });
    typeInto(m.draft(), '60');
    m.choose('nmol/L');
    expect(m.draft().value).toBe('60');
    const [meta] = sent();
    expect(Object.keys(meta).sort()).toEqual(['from', 'unit']);
    for (const label of Object.values(meta)) expect(['nmol/L', 'mg/dL', 'mg/L']).toContain(label);
    expect(JSON.stringify(meta)).not.toMatch(/\d/);
  });
});

describe('US-05 AC2 — legacy: an Lp(a) draft restored with no unit is never guessed', () => {
  const restore = (state: object) => localStorage.setItem(BT_TIMELINE_DRAFT_KEY, JSON.stringify(state));

  it('asks for it again, keeps it unsaved, and saves the rest; retyping stamps it', async () => {
    restore({ draft: { values: { lpa: '156', ldl: '3.2' } }, backfills: {}, meta: {} });
    const m = matrix({ unitSystem: 'si' });
    expect(m.draft().value).toBe('156');
    expect(within(m.lpa()).getByText(UNCLEAR)).toBeTruthy();
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ values: { ldl: 3.2 } })]);
    expect(JSON.parse(localStorage.getItem(BT_TIMELINE_DRAFT_KEY)!).draft.values).toEqual({ lpa: '156' });

    typeInto(m.draft(), '15'); // retyped, a key at a time
    typeInto(m.draft(), '156');
    expect(within(m.lpa()).queryByText(UNCLEAR)).toBeNull();
    await m.leave();
    expect(m.sent(1)).toEqual([expect.objectContaining({ values: { lpa: 156 }, unit: 'nmol/L' })]);
  });

  it('a saved column’s empty Lp(a) cell restored with no unit is asked for again too', async () => {
    restore({ draft: { values: {} }, backfills: { '2026-08-15': { lpa: '50' } }, meta: {} });
    const m = matrix({ unitSystem: 'conventional', rows: history([['ldl', 3.2, '2026-08-15']]) });
    const cell = m.lpa().querySelector('.bt-cell-backfill input') as HTMLInputElement;
    expect(cell.value).toBe('50');
    expect(within(m.lpa()).getByText(UNCLEAR)).toBeTruthy();
    await m.leave();
    expect(m.onSaveBatch).not.toHaveBeenCalled();
  });

  // Adversary R2, clinical ruling: a restored cell was not typed on this
  // page, so a unit click here keeps its stamp and its quantity.
  it('a restored draft keeps its quantity through a click: 40 nmol/L, then mg/dL, shows 16.0 and saves 40', async () => {
    record.lpaUnit = 'nmol/L';
    restore({ draft: { values: { lpa: '40' } }, backfills: {}, meta: { 'new|lpa': { unit: 'nmol/L', typedOn: 'an earlier load' } } });
    const m = matrix();
    expect(m.draft().value).toBe('40');
    m.clickUnit('mg/dL');
    expect(m.draft().value).toBe('16.0');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(40);
  });

  it('a restored saved column’s empty cell keeps its quantity too', async () => {
    record.lpaUnit = 'nmol/L';
    restore({ draft: { values: {} }, backfills: { '2026-08-15': { lpa: '40' } }, meta: { '2026-08-15|lpa': { unit: 'nmol/L' } } });
    const m = matrix({ rows: history([['ldl', 3.2, '2026-08-15']]) });
    m.clickUnit('mg/dL');
    expect((m.lpa().querySelector('.bt-cell-backfill input') as HTMLInputElement).value).toBe('16.0');
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ date: '2026-08-15', values: { lpa: 40 } })]);
  });

  it('a restored cell typed into on this page is typed by hand: 40 retyped in nmol/L, then mg/dL, saves 100', async () => {
    record.lpaUnit = 'nmol/L';
    restore({ draft: { values: { lpa: '4' } }, backfills: {}, meta: { 'new|lpa': { unit: 'nmol/L' } } });
    const m = matrix();
    typeInto(m.draft(), '40');
    m.clickUnit('mg/dL');
    expect(m.draft().value).toBe('40');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(100);
  });

  it('other fields’ restored drafts are read as before, in the field’s unit', async () => {
    restore({ draft: { values: { ldl: '124' } }, backfills: {}, meta: {} });
    const m = matrix({ unitSystem: 'conventional' });
    await m.leave();
    expect(m.sent(0)[0].values.ldl).toBeCloseTo(124 / 38.67, 3);
  });
});

describe('US-05 AC2 — the click-to-correct cell compares in the unit it shows', () => {
  const editor = (display: 'nmol/L' | 'mg/dL' | 'mg/L', value: number) => {
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const view = render(<ValueCell metric="lpa" display={display} value={value} rowId="r1" status="ok" pinned={false} onCorrect={onCorrect}/>);
    fireEvent.click(within(view.container).getByRole('button'));
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    const enter = async (typed: string) => {
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await wait(0);
    };
    return { view, input, onCorrect, enter };
  };

  it('shows 390 nmol/L as 1560 mg/L; the same number again writes nothing; 1600 corrects to 400', async () => {
    const e = editor('mg/L', 390);
    expect(e.input.value).toBe('1560');
    await e.enter('1560');
    expect(e.onCorrect).not.toHaveBeenCalled();
    const again = editor('mg/L', 390);
    await again.enter('1600');
    expect(again.onCorrect).toHaveBeenCalledWith('r1', expect.closeTo(400, 9));
  });

  it('310 mg/L over a shown 308 is a correction, though both read 31 in mg/dL', async () => {
    const e = editor('mg/L', 77);
    expect(e.input.value).toBe('308');
    await e.enter('310');
    expect(e.onCorrect).toHaveBeenCalledWith('r1', expect.closeTo(77.5, 9));
  });

  // A unit switch while the editor is open (US-05 AC2, US-04 AC1) never saves
  // the typed text: a user who types 40 and then clicks mg/dL means "this
  // number is in mg/dL", and saving 40 in the old unit is the falsely
  // reassuring error. The switch closes the editor, cancels the click-away
  // save its click armed, writes nothing and says so. Re-expressing the text
  // was wrong too: a saved 124.4 opened as "49.8" mg/dL came back as "125"
  // nmol/L, and click-away wrote 125, Elevated, over a Borderline value
  // nobody touched.
  const openOver124point4 = (typed?: string) => {
    record.lpaUnit = 'mg/dL';
    const m = matrix({ rows: history([['lpa', 124.4, '2026-08-15']]) });
    fireEvent.click(m.lpa().querySelector('.bt-cell-clickable')!);
    const input = m.lpa().querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(input.value).toBe('49.8');
    expect(document.activeElement).toBe(input);
    if (typed !== undefined) fireEvent.change(input, { target: { value: typed } });
    return m;
  };
  /** Another device's switch: the focus is still in the editor. */
  const remoteSwitch = (m: ReturnType<typeof matrix>) => {
    record.lpaUnit = 'nmol/L';
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    return m;
  };
  const radio = (m: ReturnType<typeof matrix>, unit: string) => within(m.lpa()).getByRole('radio', { name: unit });
  /** A click on the row's own unit control, as a mouse makes it: the press,
   *  then the release and the click, which switches the unit. */
  const clickUnit = (m: ReturnType<typeof matrix>, unit: string) => {
    pressMouse(radio(m, unit));
    releaseMouse(radio(m, unit));
  };
  const editorOpen = (m: ReturnType<typeof matrix>) => m.lpa().querySelector('.bt-cell-correcting input');
  const savedCell = (m: ReturnType<typeof matrix>) => m.lpa().querySelector('.bt-cell-clickable .bt-value-num')?.textContent;
  const UNIT_CHANGED = 'The unit changed, so your edit was not saved. Type it again in the new unit.';
  const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';

  // Codex + adversary R1: a press held past the 150 ms click-away save ran
  // that save in the old unit before the click switched it, unannounced.
  it('a slow press on the unit control (held 200 ms) that takes the focus (Chrome) writes nothing and says to choose the unit first', async () => {
    const m = openOver124point4('60');
    pressMouse(radio(m, 'nmol/L'));
    await wait(200);
    releaseMouse(radio(m, 'nmol/L'));
    expect(m.active()).toBe('nmol/L');
    expect(editorOpen(m)).toBeNull();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a slow press that blurs the editor with the focus going nowhere (Safari) closes it at the press, writes nothing and says to choose the unit first', async () => {
    const m = openOver124point4('60');
    pressWithoutFocus(radio(m, 'nmol/L'));
    expect(editorOpen(m)).toBeNull(); // the press decides
    await wait(200);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    releaseMouse(radio(m, 'nmol/L'));
    expect(m.active()).toBe('nmol/L');
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
  });

  // Adversary R1 (2026-10-13): the release wait was capped at a second, so a
  // press held 1.2 s ran the save while the unit was still nmol/L, and
  // 156 nmol/L was saved for a report in mg/dL.
  it('156 typed in nmol/L, then mg/dL held 1200 ms (Safari): nothing written, and it says to choose the unit first', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix({ rows: history([['lpa', 37.44, '2026-08-15']]) });
    fireEvent.click(m.lpa().querySelector('.bt-cell-clickable')!);
    fireEvent.change(editorOpen(m)!, { target: { value: '156' } });
    pressWithoutFocus(radio(m, 'mg/dL'));
    await wait(1200);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    releaseMouse(radio(m, 'mg/dL'));
    expect(m.active()).toBe('mg/dL');
    expect(editorOpen(m)).toBeNull();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
  });

  it('Tab from the editor to the unit control writes nothing and says to choose the unit first', async () => {
    const m = openOver124point4('60');
    act(() => radio(m, 'mg/dL').focus()); // the checked unit: the group's one tab stop
    expect(editorOpen(m)).toBeNull();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(radio(m, 'mg/dL'));
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a click on the unit control mid-correction writes nothing: 60 typed, then mg/dL to nmol/L, says so and leaves the focus on the control', async () => {
    const m = openOver124point4('60');
    clickUnit(m, 'nmol/L');
    expect(m.active()).toBe('nmol/L');
    expect(editorOpen(m)).toBeNull();
    expect(savedCell(m)).toBe('124');
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(within(m.lpa()).getByRole('radio', { name: 'nmol/L' }));
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
  });

  it('a click on the unit control that takes no focus (Safari) writes nothing and says to choose the unit first', async () => {
    const m = openOver124point4('60');
    pressWithoutFocus(radio(m, 'nmol/L'));
    releaseMouse(radio(m, 'nmol/L'));
    expect(editorOpen(m)).toBeNull();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  // Adversary R6: an editor nobody typed in has nothing to lose, so leaving
  // it for its own unit control closes it with no "Not saved" message.
  it('a click on the unit control over an untouched editor writes nothing and closes it silently: "49.8" mg/dL over a saved 124.4', async () => {
    const m = openOver124point4();
    clickUnit(m, 'nmol/L');
    expect(m.active()).toBe('nmol/L');
    expect(editorOpen(m)).toBeNull();
    expect(savedCell(m)).toBe('124');
    expect(within(m.lpa()).queryByText(UNIT_FIRST)).toBeNull();
    expect(within(m.lpa()).queryByText(UNIT_CHANGED)).toBeNull();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('Tab from an untouched editor to the unit control closes it silently', async () => {
    const m = openOver124point4();
    act(() => radio(m, 'mg/dL').focus());
    expect(editorOpen(m)).toBeNull();
    expect(within(m.lpa()).queryByText(UNIT_FIRST)).toBeNull();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a remote unit change closes an untouched editor: nothing written, the cell shows 124 nmol/L and says so', async () => {
    const m = remoteSwitch(openOver124point4());
    expect(editorOpen(m)).toBeNull();
    expect(m.active()).toBe('nmol/L');
    expect(savedCell(m)).toBe('124');
    expect(within(m.lpa()).getByText(UNIT_CHANGED)).toBeTruthy();
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
  });

  it('a remote unit change discards a number typed: 50 typed in mg/dL writes nothing, says so, and the focus is on the cell', async () => {
    const m = remoteSwitch(openOver124point4('50'));
    expect(editorOpen(m)).toBeNull();
    expect(savedCell(m)).toBe('124');
    expect(within(m.lpa()).getByText(UNIT_CHANGED)).toBeTruthy();
    expect(document.activeElement).toBe(m.lpa().querySelector('.bt-cell-clickable'));
    await wait(300);
    expect(m.onCorrectValue).not.toHaveBeenCalled();
    expect(within(m.lpa()).getByText(UNIT_CHANGED)).toBeTruthy(); // until the next open
  });

  it('reopened after a remote unit change, the editor is in the unit now shown: 130 corrects to 130', async () => {
    const m = remoteSwitch(openOver124point4('50'));
    await wait(300);
    fireEvent.click(m.lpa().querySelector('.bt-cell-clickable')!);
    const input = m.lpa().querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(input.value).toBe('124');
    expect(within(m.lpa()).queryByText(UNIT_CHANGED)).toBeNull();
    fireEvent.change(input, { target: { value: '130' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(m.onCorrectValue).toHaveBeenCalledWith('row0', 130);
  });

  // US-04 AC1: a click-away save that fails leaves the editor open for a
  // retry, with the focus already elsewhere. A unit click then closes it and
  // says so, but the focus stays on the unit control the user just pressed.
  it('after a failed click-away save, a unit click closes the editor, says so, and leaves the focus on the unit control', async () => {
    const m = openOver124point4('60');
    m.onCorrectValue.mockResolvedValue('error');
    press(m.view.getByRole('button', { name: 'Elsewhere' }));
    await wait(300);
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
    expect(editorOpen(m)).not.toBeNull();
    expect(within(m.lpa()).getByText('Could not save. Check your connection and try again.')).toBeTruthy();
    clickUnit(m, 'nmol/L');
    expect(editorOpen(m)).toBeNull();
    expect(within(m.lpa()).getByText(UNIT_FIRST)).toBeTruthy();
    expect(document.activeElement).toBe(within(m.lpa()).getByRole('radio', { name: 'nmol/L' }));
    await wait(300);
    expect(m.onCorrectValue).toHaveBeenCalledTimes(1);
  });
});

// US-05 AC2: the chat states a value in its own unit. The cell takes that
// number as stated, stamped with that unit, and shows it in the field's unit;
// it saves the stated value exactly, never one rounded into the field's unit
// first (49.6 mg/dL is 124 nmol/L, Borderline; rounded to "50" it saved 125, Elevated).
describe('US-05 AC2 — a value from the chat saves exactly what was stated', () => {
  // The chat's edit, as parseProposedEdit hands it over: mg/L already rescaled to mg/dL.
  const said = (value: number, unit: string) => {
    const edit = parseProposedEdit(PROPOSE_FIELD_EDIT_TOOL.name, { field: 'lpa', value, unit }) as ProposedFieldEdit;
    return [edit.displayValue, edit.unitSystem] as const;
  };
  const cases: Array<[string, number, string, number, Record<string, string>]> = [
    ['156 mg/dL', 156, 'mg/dL', 390, { 'nmol/L': '390', 'mg/dL': '156', 'mg/L': '1560' }],
    ['93 mg/L', 93, 'mg/L', 23.25, { 'nmol/L': '23', 'mg/dL': '9.3', 'mg/L': '93' }],
    ['498 mg/L', 498, 'mg/L', 124.5, { 'nmol/L': '125', 'mg/dL': '49.8', 'mg/L': '498' }],
    ['390 nmol/L', 390, 'nmol/L', 390, { 'nmol/L': '390', 'mg/dL': '156.0', 'mg/L': '1560' }],
    ['49.6 mg/dL', 49.6, 'mg/dL', 124, { 'nmol/L': '124', 'mg/dL': '49.6', 'mg/L': '496' }],
    ['29.8 mg/dL', 29.8, 'mg/dL', 74.5, { 'nmol/L': '75', 'mg/dL': '29.8', 'mg/L': '298' }],
  ];
  for (const [label, value, unit, saves, shows] of cases) {
    for (const field of ['nmol/L', 'mg/dL', 'mg/L'] as const) {
      it(`${label} with the field in ${field}: shows ${shows[field]}, saves ${saves} nmol/L`, async () => {
        record.lpaUnit = field;
        const m = matrix();
        const [displayValue, system] = said(value, unit);
        act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
        expect(m.draft().value).toBe(shows[field]);
        await m.leave();
        expect(m.sent(0)[0].values.lpa).toBe(saves);
      });
    }
  }

  it('49.6 mg/dL grades Borderline in every unit, as the record will', () => {
    for (const field of ['nmol/L', 'mg/dL', 'mg/L'] as const) {
      record.lpaUnit = field;
      const m = matrix();
      const [displayValue, system] = said(49.6, 'mg/dL');
      act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
      expect([field, m.tick()]).toEqual([field, 'bt-status-warn']);
      cleanup();
    }
  });

  it('29.8 mg/dL in an nmol/L field shows a whole "75" but grades Normal, from the 74.5 it saves', () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix();
    const [displayValue, system] = said(29.8, 'mg/dL');
    act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
    expect([m.draft().value, m.tick()]).toEqual(['75', 'bt-status-ok']);
  });

  // A stated value shown in another unit than it was stated in is not the
  // number on screen: a click here keeps its unit, so it saves exactly.
  it('a stated value shown in another unit keeps its quantity through a click and saves exactly', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix();
    const [displayValue, system] = said(49.6, 'mg/dL');
    act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
    expect(m.draft().value).toBe('124');
    m.clickUnit('mg/L');
    expect(m.draft().value).toBe('496');
    m.remote('nmol/L');
    expect(m.draft().value).toBe('124');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(124);
  });

  // Adversary R2, clinical ruling (2026-10-13): a unit click re-reads only
  // the numbers the user typed by hand on this page. A chat value is the
  // chat's number in the chat's unit, whatever the field showed: it keeps its
  // quantity, and the number shown is re-expressed.
  it('a chat value stated in the unit shown keeps its quantity through a click: 49.6 mg/dL, then nmol/L, shows and saves 124', async () => {
    record.lpaUnit = 'mg/dL';
    const m = matrix();
    const [displayValue, system] = said(49.6, 'mg/dL');
    act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
    expect(m.draft().value).toBe('49.6');
    m.clickUnit('nmol/L');
    expect(m.draft().value).toBe('124');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(124);
  });

  it('a chat value edited by hand is typed by hand: 49.6 mg/dL retyped 50, then nmol/L, saves 50 nmol/L', async () => {
    record.lpaUnit = 'mg/dL';
    const m = matrix();
    const [displayValue, system] = said(49.6, 'mg/dL');
    act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, null); });
    typeInto(m.draft(), '50');
    m.clickUnit('nmol/L');
    expect(m.draft().value).toBe('50');
    await m.leave();
    expect(m.sent(0)[0].values.lpa).toBe(50);
  });

  it('into a saved column’s empty cell, too: 29.8 mg/dL with the field in nmol/L shows 75 and saves 74.5', async () => {
    record.lpaUnit = 'nmol/L';
    const m = matrix({ rows: history([['ldl', 3.2, '2026-08-15']]) });
    const [displayValue, system] = said(29.8, 'mg/dL');
    act(() => { m.prefillRef.current!('lpa' as MetricType, displayValue, system, '2026-08-15'); });
    const cell = m.lpa().querySelector('.bt-cell-backfill input') as HTMLInputElement;
    expect(cell.value).toBe('75');
    await m.leave();
    expect(m.sent(0)).toEqual([expect.objectContaining({ date: '2026-08-15', values: { lpa: 74.5 } })]);
  });
});

// US-05 AC2 (display only): mg/dL shows one decimal place. At 2.5 nmol/L per
// mg/dL a whole-number step hid the cut-points: a stored 74 (Normal) read
// "30 mg/dL" beside "Normal: <30 mg/dL", and 124 (Borderline) read "50".
describe('US-05 AC2 — Lp(a) in mg/dL shows one decimal place', () => {
  it('a stored 74 nmol/L shows 29.6 mg/dL and 124 shows 49.6; the hint stays "<30 mg/dL"', () => {
    record.lpaUnit = 'mg/dL';
    const m = matrix({ rows: history([['lpa', 74, '2026-08-15'], ['lpa', 124, '2026-09-15']]) });
    expect(m.lpa().textContent).toContain('29.6');
    expect(m.lpa().textContent).toContain('49.6');
    expect(m.hint()).toBe('Normal: <30 mg/dL');
  });

  it('a stored 124 is corrected to 125 by typing 50 in mg/dL', async () => {
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const view = render(<ValueCell metric="lpa" display="mg/dL" value={124} rowId="r1" status="warn" pinned={false} onCorrect={onCorrect}/>);
    fireEvent.click(within(view.container).getByRole('button'));
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(input.value).toBe('49.6');
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await wait(0);
    expect(onCorrect).toHaveBeenCalledWith('r1', 125);
  });

  it('mg/L stays whole: a stored 124 shows 496', () => {
    record.lpaUnit = 'mg/L';
    const m = matrix({ rows: history([['lpa', 124, '2026-09-15']]) });
    expect(m.lpa().textContent).toContain('496');
    expect(m.lpa().textContent).not.toContain('496.0');
  });
});

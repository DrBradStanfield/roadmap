// @vitest-environment jsdom
/**
 * US-13 AC1 (widened 2026-09-04) / US-35 AC8 — a lab PDF the connector filed
 * metadata-only (contentHash set, no fileRef) is archived by the website on
 * the next upload of the same bytes. The review step shows every value as
 * already recorded, so nothing is selected — Save must still be offered, and
 * must say what it will do.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { ReviewTable, type FileResult } from './ReviewTable';
import type { ApiDocument } from '../lib/api-types';

// The record's profile.lpaUnit (US-05 AC2), in memory.
const record = vi.hoisted(() => ({ lpaUnit: undefined as string | undefined }));
vi.mock('../lib/roadmap-data', async (original) => ({
  ...(await original<typeof import('../lib/roadmap-data')>()),
  getLpaUnit: () => record.lpaUnit,
  setLpaUnit: (unit: string) => { record.lpaUnit = unit; },
}));

beforeEach(() => { record.lpaUnit = undefined; localStorage.clear(); });
afterEach(cleanup);

const HASH = 'sha256-abc';
const measurements: ApiMeasurement[] = [
  { id: 'old-ldl', metricType: 'ldl', value: 3.9, recordedAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:00.000Z' },
];
const results: FileResult[] = [{
  fileName: 'labs.pdf',
  reportDate: '2024-06-01',
  values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }],
  additionalValues: [],
  file: new Blob(['bytes'], { type: 'application/pdf' }),
  contentHash: HASH,
}];
const connectorRow: ApiDocument = {
  id: 'imported', documentType: 'pathology_report', title: 'Blood test results', documentDate: '2024-06-01',
  contentMd: '', metadata: { importedVia: 'connector' }, sourceFileName: 'labs.pdf',
  createdAt: '2024-06-02T00:00:00.000Z', fileRef: null, contentHash: HASH,
};

const LETTER_HASH = 'sha256-letter';
const letterResults: FileResult[] = [{
  fileName: 'clinic-letter.pdf',
  reportDate: null,
  values: [],
  additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2024-06-10', contentMarkdown: '# Letter', metadata: {} },
  file: new Blob(['letter bytes'], { type: 'application/pdf' }),
  contentHash: LETTER_HASH,
}];
const connectorLetter: ApiDocument = {
  id: 'imported-letter', documentType: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2024-06-10',
  contentMd: '', metadata: { importedVia: 'connector' }, sourceFileName: 'clinic-letter.pdf',
  createdAt: '2024-06-11T00:00:00.000Z', fileRef: null, contentHash: LETTER_HASH,
};

function renderReview(documents: ApiDocument[], files: FileResult[] = results, savedBloodTests: ApiMeasurement[] = measurements) {
  const onSave = vi.fn();
  const utils = render(
    <ReviewTable
      grading={{}}
      results={files}
      history={{ measurements: savedBloodTests, labValues: [], documents }}
      unitSystem="si"
      onSave={onSave}
      onCancel={() => {}}
      isSaving={false}
      error={null}
    />,
  );
  return { ...utils, onSave, button: utils.container.querySelector<HTMLButtonElement>('.review-save-btn')! };
}

describe('ReviewTable — archiving the original behind a connector row (US-13 AC1, US-35 AC8)', () => {
  it('offers Save with nothing selected when the bytes match a metadata-only row, and says so', () => {
    const { button, onSave, container } = renderReview([connectorRow]);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('US-12 AC6: describes original-only saving without claiming cleared values are stored', () => {
    const { button, onSave, container } = renderReview([], results, []);
    const inputs = container.querySelectorAll<HTMLInputElement>('.bt-cell-review input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) fireEvent.change(input, { target: { value: '' } });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    expect(container.querySelector('.review-summary')?.textContent).not.toContain('already in your record');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('keeps Save disabled when the same bytes are already archived (fileRef set)', () => {
    const { button, container } = renderReview([{ ...connectorRow, fileRef: 'Lab results/x.pdf' }]);
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.review-summary')?.textContent).toContain('No items selected');
  });

  it('US-12 AC6: offers an original-only retry after saved values become history context', () => {
    const { button, onSave } = renderReview([]);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('offers Save for a clinic letter the connector filed: name-deduped to an unselected row, yet still an original to archive', () => {
    const { button, onSave, container } = renderReview([connectorLetter], letterResults);
    expect(container.querySelector<HTMLInputElement>('.review-row-check input')!.checked).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 1 Original');
    expect(container.querySelector('.review-summary')?.textContent)
      .toBe('Save will archive the original PDF. No extracted values or documents are selected.');
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledWith({ values: [], documents: [], labValues: [] });
  });

  it('does not double-count a connector letter the user re-selects: it saves as a document, not also an original', () => {
    const { button, container } = renderReview([connectorLetter], letterResults);
    fireEvent.click(container.querySelector<HTMLInputElement>('.review-row-check input')!);
    expect(button.textContent).toBe('Save 1 Document');
  });

  it('keeps Save disabled for a name-deduped letter whose bytes the record does not hold', () => {
    expect(renderReview([{ ...connectorLetter, contentHash: null }], letterResults).button.disabled).toBe(true);
  });
});

// US-06 AC5: the upload review offers a screening-date update by the plan's
// age, not the birth year alone. Born December 1981, the plan says 44 until
// the birthday; the year alone said 45, old enough for prostate screening.
describe('ReviewTable — screening eligibility reads the plan\'s age (US-06 AC5)', () => {
  const psaLetter: FileResult[] = [{
    fileName: 'urology.pdf',
    reportDate: null,
    values: [],
    additionalValues: [],
    document: { classification: 'clinic_letter', title: 'Urology', documentDate: '2026-09-01', contentMarkdown: '# PSA', metadata: { screeningType: 'prostate' } },
  }];
  const renderAt = (age: number | undefined) => render(
    <ReviewTable
      grading={{}}
      results={psaLetter}
      history={{ measurements: [], labValues: [], documents: [] }}
      unitSystem="si"
      age={age}
      sex="male"
      onSave={() => {}}
      onCancel={() => {}}
      isSaving={false}
      error={null}
    />,
  ).container.querySelector('.review-screening-update input');

  it('at 44 there is no prostate screening update to tick', () => {
    expect(renderAt(44)).toBeNull();
  });

  it('at 45 it is offered, ticked', () => {
    expect((renderAt(45) as HTMLInputElement | null)?.checked).toBe(true);
  });
});

// US-05 AC1 / US-13 "Review before save": an untouched cell saves the value the
// report gave, not one re-derived from the rounded number on screen. Lp(a)
// shows mg/dL at one decimal place (0.25 nmol/L a step, US-05 AC2): 124.9
// nmol/L reads "50.0", and 50 × 2.5 would save 125 (Borderline → Elevated);
// 74.9 reads "30.0" and would save 75 (Normal → Borderline). An edited cell
// still converts what the user typed.
describe('ReviewTable — untouched core cells keep the extracted SI value (US-05 AC1, US-13)', () => {
  const lpaFile = (reportDate: string, valueSI: number): FileResult => ({
    fileName: `lpa-${reportDate}.pdf`,
    reportDate,
    values: [{ metric: 'lpa', valueSI, displayValue: valueSI, displayUnit: 'nmol/L', confidence: 'high' }],
    additionalValues: [],
  });
  const files = [lpaFile('2025-01-10', 124.9), lpaFile('2025-02-10', 74.9)];
  const history = { measurements: [], labValues: [], documents: [] };
  const renderAt = (unitSystem: 'si' | 'conventional', onSave = vi.fn()) => {
    const utils = render(
      <ReviewTable grading={{}} results={files} history={history} unitSystem={unitSystem}
        onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
    );
    const rerenderAt = (u: 'si' | 'conventional') => utils.rerender(
      <ReviewTable grading={{}} results={files} history={history} unitSystem={u}
        onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
    );
    const inputs = () => [...utils.container.querySelectorAll<HTMLInputElement>('.bt-cell-review input')];
    const save = () => {
      fireEvent.click(utils.container.querySelector<HTMLButtonElement>('.review-save-btn')!);
      return onSave.mock.calls.at(-1)![0].values as Array<{ valueSI: number; source?: string }>;
    };
    const ticks = () => [...utils.container.querySelectorAll('.bt-cell-review .bt-status-tick')]
      .map(t => t.className.replace('bt-status-tick ', ''));
    return { inputs, save, rerenderAt, ticks };
  };

  it('shows 50.0 and 30.0 mg/dL, and saves exactly 124.9 and 74.9 nmol/L', () => {
    const { inputs, save } = renderAt('conventional');
    expect(inputs().map(i => i.value)).toEqual(['50.0', '30.0']);
    const saved = save();
    expect(saved.map(v => v.valueSI)).toEqual([124.9, 74.9]);
    expect(saved.map(v => v.source)).toEqual([undefined, undefined]);
  });

  it('a unit toggle without typing keeps the cell untouched: still 124.9 and 74.9', () => {
    const { inputs, save, rerenderAt } = renderAt('si');
    rerenderAt('conventional');
    expect(inputs().map(i => i.value)).toEqual(['50.0', '30.0']);
    expect(save().map(v => v.valueSI)).toEqual([124.9, 74.9]);
  });

  it('an edited cell converts the typed number from its display unit, even after a toggle', () => {
    const { inputs, save, rerenderAt } = renderAt('conventional');
    fireEvent.change(inputs()[0], { target: { value: '60' } });
    rerenderAt('si');
    const saved = save();
    expect(saved[0].valueSI).toBeCloseTo(150, 9); // 60 mg/dL × 2.5
    expect(saved[0].source).toBe('lab_import_edited');
    expect(saved[1].valueSI).toBe(74.9);
  });

  it('an untouched cell is coloured by the value it saves: 124.9 Borderline, 74.9 Normal, not 125 / 75', () => {
    const { ticks } = renderAt('conventional');
    expect(ticks()).toEqual(['bt-status-warn', 'bt-status-ok']);
  });

  it('an edited cell is coloured by what was typed; retyping the shown number is untouched again', () => {
    const { inputs, ticks, save, rerenderAt } = renderAt('conventional');
    fireEvent.change(inputs()[0], { target: { value: '51' } }); // 127.5 nmol/L
    fireEvent.change(inputs()[1], { target: { value: '31' } }); // 77.5 nmol/L
    expect(ticks()).toEqual(['bt-status-bad', 'bt-status-warn']);
    fireEvent.change(inputs()[0], { target: { value: '50.0' } }); // the extracted value as shown
    rerenderAt('si');
    expect(ticks()[0]).toBe('bt-status-warn');
    expect(save()[0].valueSI).toBe(124.9);
  });

  it('typed text that matches the other unit\'s rendering still counts as typed', () => {
    // "124" typed as mg/dL is 310 nmol/L. After the toggle the cell's SI
    // rendering is also "124", which must not read as untouched.
    const { inputs, save, rerenderAt } = renderAt('conventional');
    fireEvent.change(inputs()[0], { target: { value: '124' } });
    rerenderAt('si');
    const saved = save();
    expect(saved[0].valueSI).toBeCloseTo(310, 9);
    expect(saved[0].source).toBe('lab_import_edited');
  });
});

// US-05 AC1 / US-13 AC4: an edited cell keeps the number typed and the unit it
// was typed in. A unit toggle shows that quantity in the new unit and grades
// it; it never re-reads the typed digits as the new unit. "60" typed as mg/dL
// is 150 nmol/L (Elevated); read as 60 nmol/L it would show Normal while Save
// stored 150.
describe('ReviewTable — an edited cell after a unit toggle shows what Save writes (US-05 AC1, US-13 AC4)', () => {
  const files: FileResult[] = [{
    fileName: 'lpa.pdf', reportDate: '2025-01-10', additionalValues: [],
    values: [{ metric: 'lpa', valueSI: 124, displayValue: 124, displayUnit: 'nmol/L', confidence: 'high' }],
  }];
  const history = { measurements: [], labValues: [], documents: [] };
  type Props = { unitSystem: 'si' | 'conventional'; overrides?: { lpa: 'si' | 'conventional' } };
  /** The Lp(a) row's unit control (US-05 AC2). */
  const lpaRow = (container: HTMLElement) => container.querySelector('.bt-unit-segments')!.closest('.bt-row') as HTMLElement;
  const setup = (first: Props) => {
    const onSave = vi.fn();
    const el = ({ unitSystem, overrides }: Props) => (
      <ReviewTable grading={{}} results={files} history={history} unitSystem={unitSystem} metricUnitOverrides={overrides}
        onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />
    );
    const utils = render(el(first));
    const input = () => utils.container.querySelector<HTMLInputElement>('.bt-cell-review input')!;
    return {
      input,
      rerender: (p: Props) => utils.rerender(el(p)),
      unit: () => within(lpaRow(utils.container)).getByRole('radio', { checked: true }).textContent,
      choose: (unit: string) => fireEvent.click(within(lpaRow(utils.container)).getByRole('radio', { name: unit })),
      tick: () => utils.container.querySelector('.bt-cell-review .bt-status-tick')!.className.replace('bt-status-tick ', ''),
      save: () => {
        fireEvent.click(utils.container.querySelector<HTMLButtonElement>('.review-save-btn')!);
        return onSave.mock.calls.at(-1)![0].values as Array<{ valueSI: number; source?: string }>;
      },
    };
  };

  it('global toggle: "60" typed in mg/dL (Elevated) shows 150 nmol/L, still Elevated, and saves 150; back in mg/dL it reads 60 again', () => {
    const c = setup({ unitSystem: 'conventional' });
    fireEvent.change(c.input(), { target: { value: '60' } });
    expect(c.tick()).toBe('bt-status-bad');
    c.rerender({ unitSystem: 'si' });
    expect(c.unit()).toBe('nmol/L');
    expect(c.input().value).toBe('150');
    expect(c.tick()).toBe('bt-status-bad');
    c.rerender({ unitSystem: 'conventional' });
    expect([c.unit(), c.input().value, c.tick()]).toEqual(['mg/dL', '60', 'bt-status-bad']);
    const [saved] = c.save();
    expect(saved.valueSI).toBeCloseTo(150, 9);
    expect(saved.source).toBe('lab_import_edited');
  });

  it('US-05 AC2: the row\'s own unit control: "60" typed in mg/dL shows 150 nmol/L and 600 mg/L, graded Elevated, and saves 150', () => {
    const c = setup({ unitSystem: 'conventional' });
    fireEvent.change(c.input(), { target: { value: '60' } });
    c.choose('nmol/L');
    expect([c.unit(), c.input().value, c.tick()]).toEqual(['nmol/L', '150', 'bt-status-bad']);
    expect(record.lpaUnit).toBe('nmol/L');
    c.choose('mg/L');
    expect([c.unit(), c.input().value, c.tick()]).toEqual(['mg/L', '600', 'bt-status-bad']);
    const [saved] = c.save();
    expect(saved.valueSI).toBeCloseTo(150, 9);
    expect(saved.source).toBe('lab_import_edited');
  });

  it('US-05 AC2: in mg/L an untouched 23.25 nmol/L shows 93 and saves exactly 23.25; the hint is in mg/L', () => {
    record.lpaUnit = 'mg/L';
    const one: FileResult[] = [{ ...files[0], values: [{ ...files[0].values[0], valueSI: 23.25 }] }];
    const onSave = vi.fn();
    const { container } = render(
      <ReviewTable grading={{}} results={one} history={history} unitSystem="conventional"
        onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
    );
    expect(container.querySelector<HTMLInputElement>('.bt-cell-review input')!.value).toBe('93');
    expect(lpaRow(container).querySelector('.bt-ref-label')?.textContent).toBe('Normal: <300 mg/L');
    fireEvent.click(container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    expect(onSave.mock.calls[0][0].values[0]).toMatchObject({ valueSI: 23.25, source: undefined });
  });

  it('US-05 AC2: a two-way Lp(a) override from the old build drives nothing; the row opens in its own unit', () => {
    const c = setup({ unitSystem: 'si', overrides: { lpa: 'conventional' } });
    expect([c.unit(), c.input().value]).toEqual(['nmol/L', '124']);
  });

  it('a toggle keeps the exact typed quantity: 124.9 nmol/L shows "50.0" mg/dL, stays Borderline and saves 124.9', () => {
    const c = setup({ unitSystem: 'si' });
    fireEvent.change(c.input(), { target: { value: '124.9' } });
    c.rerender({ unitSystem: 'conventional' });
    expect([c.input().value, c.tick()]).toEqual(['50.0', 'bt-status-warn']);
    const [saved] = c.save();
    expect(saved.valueSI).toBe(124.9);
    expect(saved.source).toBe('lab_import_edited');
  });

  it('typing after a toggle is in the unit now shown', () => {
    const c = setup({ unitSystem: 'conventional' });
    fireEvent.change(c.input(), { target: { value: '60' } });
    c.rerender({ unitSystem: 'si' });
    fireEvent.change(c.input(), { target: { value: '70' } });
    expect([c.input().value, c.tick()]).toEqual(['70', 'bt-status-ok']);
    expect(c.save()[0].valueSI).toBe(70);
  });

  it('a cell retyped to the extracted value, then toggled, shows the extracted value in the new unit', () => {
    const c = setup({ unitSystem: 'conventional' });
    fireEvent.change(c.input(), { target: { value: '51' } });
    fireEvent.change(c.input(), { target: { value: '49.6' } }); // 124 nmol/L, as shown
    c.rerender({ unitSystem: 'si' });
    expect([c.input().value, c.tick()]).toEqual(['124', 'bt-status-warn']);
    expect(c.save()[0]).toMatchObject({ valueSI: 124, source: undefined });
  });
});

// US-13 AC3: a conflict is judged on the stored values, not their rounded
// display. Lp(a) shows mg/dL at one decimal place, so a record's 124.9 nmol/L
// and an upload's 125 nmol/L on the same day both read "50.0" — yet 125
// crosses the Elevated line. The upload must be offered as a conflict with Replace.
describe('ReviewTable — same-day conflicts compare stored values, not rounded text (US-13 AC3)', () => {
  const day = '2025-01-10';
  const held = (value: number): ApiMeasurement[] => [
    { id: 'held-lpa', metricType: 'lpa', value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` },
  ];
  const upload = (valueSI: number): FileResult[] => [{
    fileName: 'lpa.pdf', reportDate: day, additionalValues: [],
    values: [{ metric: 'lpa', valueSI, displayValue: valueSI, displayUnit: 'nmol/L', confidence: 'high' }],
  }];
  const renderConflict = (record: number, uploaded: number) => {
    const onSave = vi.fn();
    const utils = render(
      <ReviewTable grading={{}} results={upload(uploaded)} history={{ measurements: held(record), labValues: [], documents: [] }}
        unitSystem="conventional" onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
    );
    return { ...utils, onSave, replace: () => utils.container.querySelector<HTMLInputElement>('.bt-cell-conflict-replace input') };
  };

  it('124.9 held vs 125 uploaded, both shown as "50.0" mg/dL: a conflict, and Replace corrects to exactly 125', () => {
    const { container, onSave, replace } = renderConflict(124.9, 125);
    expect(replace()).not.toBeNull();
    expect(container.querySelector('.bt-cell-conflict-old')?.textContent).toBe('50.0');
    expect(container.querySelector<HTMLInputElement>('.bt-cell-conflict input[type="text"]')?.value).toBe('50.0');
    fireEvent.click(replace()!);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    expect(onSave.mock.calls.at(-1)![0].values).toEqual([
      { metric: 'lpa', valueSI: 125, recordedAt: `${day}T00:00:00.000Z`, source: undefined, correctsId: 'held-lpa' },
    ]);
  });

  it('an equal value is already recorded: context, no conflict, nothing to save', () => {
    const { container, replace } = renderConflict(124, 124);
    expect(replace()).toBeNull();
    expect(container.querySelector('.bt-cell-review')).toBeNull();
    expect(container.querySelector('.bt-cell-context .bt-value-num')).not.toBeNull();
  });

  it('float noise from a unit conversion is still the same value (US-35 AC6)', () => {
    const { replace } = renderConflict(3.879 * (1 + 1e-12), 3.879);
    expect(replace()).toBeNull();
  });
});

// Brad 2026-10-16 (PR #145): the record holds a lab in SI, the report prints its own unit. "Vitamin D" on a
// report and the stored `vitamin_d` share one row (US-35 AC6), so a reading in another unit says its unit,
// and Replace saves the number with the unit it was printed in (converted once, at the write).
describe('ReviewTable — a lab printed in another unit conflicts, shows its unit, and saves it (US-35 AC6)', () => {
  const day = '2025-02-01';
  const heldLab = { id: 'held-d', metricName: 'vitamin_d', value: 50, unit: 'nmol/L', referenceLow: null, referenceHigh: null,
    recordedAt: `${day}T00:00:00.000Z`, source: 'manual' as const, createdAt: `${day}T00:00:00.000Z` };
  const upload: FileResult[] = [{
    fileName: 'd.pdf', reportDate: day, values: [], additionalValues: [{ name: 'Vitamin D', value: 50, unit: 'ng/mL' }],
  }];

  it('a reading in another unit on a new date stays in its own column, its unit inside the cell (Codex R1)', () => {
    const later: FileResult[] = [{ ...upload[0], reportDate: '2025-03-01' }];
    const { container } = render(
      <ReviewTable grading={{}} results={later} history={{ measurements: [], labValues: [heldLab], documents: [] }}
        unitSystem="si" onSave={vi.fn()} onCancel={() => {}} isSaving={false} error={null} />,
    );
    const strips = [...container.querySelectorAll('.bt-strip-inner')];
    // Every row's strip holds one element per date column, plus the spacer.
    const widths = strips.map((strip) => strip.children.length);
    expect(new Set(widths).size).toBe(1);
    const unit = container.querySelector('.bt-cell-unit');
    expect(unit?.textContent).toBe('ng/mL');
    expect(unit?.parentElement?.parentElement?.classList.contains('bt-strip-inner')).toBe(true);
    // A screen reader hears the unit the eye sees (adversary R3).
    // ...and the SI value Save stores (US-21 AC17).
    expect(container.querySelector('input[aria-label="Vitamin D value ng/mL, saved as 124.8 nmol/L"]')).not.toBeNull();
  });

  it('50 ng/mL against a saved 50 nmol/L: one row, a conflict naming both units, and Replace saves 50 ng/mL', () => {
    const onSave = vi.fn();
    const { container } = render(
      <ReviewTable grading={{}} results={upload} history={{ measurements: [], labValues: [heldLab], documents: [] }}
        unitSystem="si" onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />,
    );
    expect(container.querySelectorAll('.bt-cell-conflict')).toHaveLength(1);
    expect(container.querySelector('.bt-cell-conflict .bt-cell-unit')?.textContent).toBe('ng/mL');
    const replace = container.querySelector<HTMLInputElement>('.bt-cell-conflict-replace input')!;
    expect(replace.getAttribute('aria-label')).toBe('Replace the saved Vitamin D value 50 nmol/L with 50 ng/mL');
    fireEvent.click(replace);
    fireEvent.click(container.querySelector<HTMLButtonElement>('.review-save-btn')!);
    expect(onSave.mock.calls.at(-1)![0].labValues).toEqual([
      expect.objectContaining({ name: 'Vitamin D', value: 50, unit: 'ng/mL', correctsId: 'held-d' }),
    ]);
  });
});

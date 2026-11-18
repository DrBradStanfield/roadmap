// @vitest-environment jsdom
/**
 * US-21 AC18 — the review shows what Save will store. A catalogued test
 * printed in another unit shows the SI value the catalogue converts it to,
 * and a core value whose unit was guessed says so. Synthetic values.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ReviewTable } from './ReviewTable';
import type { FileResult } from '../lib/upload-pipeline';
import { showingAll } from '../testing/import-review';

afterEach(cleanup);

const DAY = '2026-03-10';

function renderReview(results: FileResult[]) {
  return showingAll(render(
    <ReviewTable grading={{}} results={results} history={{ measurements: [], labValues: [], documents: [] }}
      unitSystem="si" onSave={vi.fn()} onCancel={() => {}} isSaving={false} error={null} />,
  ));
}

const lab = (name: string, value: number, unit: string): FileResult[] => [{
  fileName: 'labs.pdf', reportDate: DAY, values: [], additionalValues: [{ name, value, unit }],
}];

describe('US-21 AC18: a catalogued test printed in another unit shows the SI value Save stores', () => {
  it('450 pg/mL vitamin B12 shows → 332.1 pmol/L, the catalogue\'s own conversion', () => {
    const { container, getByRole } = renderReview(lab('Vitamin B12', 450, 'pg/mL'));
    expect(container.querySelector('.bt-cell-si')?.textContent).toBe('→ 332.1 pmol/L');
    // Heard from the visible note; the label names the test only (US-13 AC10).
    expect(getByRole('textbox', { name: 'Vitamin B12 value from 10 Mar 2026', description: '→ 332.1 pmol/L' })).toBeTruthy();
  });

  it('follows an edit: the note is the value the typed number saves', () => {
    const { container } = renderReview(lab('Vitamin B12', 450, 'pg/mL'));
    fireEvent.change(container.querySelector<HTMLInputElement>('.bt-cell-review input')!, { target: { value: '500' } });
    expect(container.querySelector('.bt-cell-si')?.textContent).toBe('→ 369 pmol/L');
  });

  it('previews only a row the write takes: a count off its own range\'s scale shows nothing, one on it shows the stored count', () => {
    const platelets = (value: number): FileResult[] => [{
      fileName: 'labs.pdf', reportDate: DAY, values: [],
      additionalValues: [{ name: 'Platelets', value, unit: 'cells/µL', referenceLow: 150000, referenceHigh: 450000 }],
    }];
    expect(renderReview(platelets(250)).container.querySelector('.bt-cell-si')).toBeNull();
    cleanup();
    expect(renderReview(platelets(250000)).container.querySelector('.bt-cell-si')?.textContent).toBe('→ 250 ×10⁹/L');
  });

  it('says nothing when the number does not change, the test is uncatalogued, or the unit is refused', () => {
    for (const results of [lab('Sodium', 140, 'mEq/L'), lab('Ferritin', 134, 'ug/L'), lab('homocysteine', 9, 'µmol/L'), lab('Vitamin B12', 450, 'mg')]) {
      const { container } = renderReview(results);
      expect(container.querySelector('.bt-cell-si')).toBeNull();
      cleanup();
    }
  });
});

// US-13 AC13 (owner, 2026-11-15): a lab the write refuses on its own gets no
// cell; the review names it before Save, once, under "Not saved", in its words.
// Before, the cell showed the refusal line (US-21 AC21, AC26); Save then refused it.
const notSaved = (container: HTMLElement) => {
  fireEvent.click(container.querySelector<HTMLButtonElement>('.review-not-saved button')!);
  return Array.from(container.querySelectorAll('.review-not-saved li')).map(li => li.textContent);
};

describe('US-21 AC21: a row past its test\'s ceiling is named before Save, never previewed', () => {
  const freeT = (unit: string): FileResult[] => [{
    fileName: 'labs.pdf', reportDate: DAY, values: [],
    additionalValues: [{ name: 'Free Testosterone', value: 312.6, unit, referenceLow: 163, referenceHigh: 473 }],
  }];

  it('free T 312.6 "nmol/L" with range 163–473 has no cell and is listed as misread; never the converted 312,600', () => {
    const { container } = renderReview(freeT('nmol/L'));
    expect(container.querySelector('.bt-cell-review')).toBeNull();
    expect(notSaved(container)).toEqual(['Free testosterone: the number looks misread. Check the report']);
    expect(container.textContent).not.toMatch(/312[,.\s]?600/);
  });

  it('the same row printed in pmol/L is a cell with no note', () => {
    const { container } = renderReview(freeT('pmol/L'));
    expect(container.querySelector('.bt-cell-review')).not.toBeNull();
    expect(container.querySelector('.bt-cell-refused')).toBeNull();
  });
});

describe('US-21 AC26: a value past its plausible range is named before Save, never previewed', () => {
  it('glucose 3,000 mg/dL and ferritin -1 µg/L: no cell, listed as misread', () => {
    for (const [name, value, unit] of [['Glucose', 3000, 'mg/dL'], ['Ferritin', -1, 'µg/L']] as const) {
      const { container, unmount } = renderReview(lab(name, value, unit));
      expect(container.querySelector('.bt-cell-review')).toBeNull();
      expect(notSaved(container)).toEqual([`${name}: the number looks misread. Check the report`]);
      unmount();
    }
  });

  it('a count off its range\'s scale is listed by its scale reason (adversary N1)', () => {
    const { container } = renderReview([{
      fileName: 'labs.pdf', reportDate: DAY, values: [],
      additionalValues: [{ name: 'Platelets', value: 15000000, unit: 'cells/µL', referenceLow: 150, referenceHigh: 400 }],
    }]);
    expect(container.querySelector('.bt-cell-review')).toBeNull();
    expect(notSaved(container)).toEqual(['Platelets: the number and its range are on different scales']);
  });
});

describe('US-21 AC1: a catalogued row is named by the catalogue\'s label, as the blood-test matrix names it', () => {
  it('ft4 reads "Free T4" and urine_acr "Urine ACR", not a title-cased key', () => {
    const { container } = renderReview([{
      fileName: 'labs.pdf', reportDate: DAY, values: [],
      additionalValues: [{ name: 'ft4', value: 15, unit: 'pmol/L' }, { name: 'urine_acr', value: 1.2, unit: 'mg/mmol' }],
    }]);
    const labels = [...container.querySelectorAll('.bt-name-label')].map(l => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Free T4', 'Urine ACR']));
    expect(labels).not.toContain('Ft4');
  });
});

describe('US-21 AC18: a core value whose unit was guessed shows its question, highlighted', () => {
  const core = (confidence: 'high' | 'medium' | 'low', question?: string): FileResult[] => [{
    fileName: 'labs.pdf', reportDate: DAY, additionalValues: [],
    values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: '', confidence, question }],
  }];

  it('medium confidence: the question is shown in the cell, with the warning highlight', () => {
    const question = 'No unit was printed, so the unit was inferred — please verify this value';
    const { container } = renderReview(core('medium', question));
    expect(container.querySelector('.bt-cell-question')?.textContent).toBe(question);
    expect(container.querySelector('.bt-cell-review')?.classList.contains('bt-cell-low-confidence')).toBe(true);
  });

  it('high confidence with no question: no note, no highlight', () => {
    const { container } = renderReview(core('high'));
    expect(container.querySelector('.bt-cell-question')).toBeNull();
    expect(container.querySelector('.bt-cell-low-confidence')).toBeNull();
  });
});

// Issue #166: the review showed only the converted number, so "177 µmol/L"
// gave no hint that the report printed "2" with no unit (US-13 AC11).
describe('US-13 AC11: a core value shows what the report printed when the cell shows something else', () => {
  const printed = (v: Partial<FileResult['values'][number]>): FileResult[] => [{
    fileName: 'labs.pdf', reportDate: DAY, additionalValues: [],
    values: [{ metric: 'creatinine', valueSI: 132.6, displayValue: 1.5, displayUnit: 'mg/dL', displaySystem: 'conventional', confidence: 'high', ...v }],
  }];

  it('a converted value: "Printed: 1.5 mg/dL" beside 133 µmol/L, heard with the input', () => {
    const { container, getByRole } = renderReview(printed({}));
    expect(container.querySelector('.bt-cell-printed')?.textContent).toBe('Printed: 1.5 mg/dL');
    expect(getByRole('textbox', { name: /Creatinine value from/, description: /Printed: 1\.5 mg\/dL/ })).toBeTruthy();
  });

  it('a guessed unit with none printed: "Printed: 2.8 (no unit)"', () => {
    const { container } = renderReview([{
      fileName: 'labs.pdf', reportDate: DAY, additionalValues: [],
      values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: '', displaySystem: 'si', confidence: 'medium', unitGuessed: true }],
    }]);
    expect(container.querySelector('.bt-cell-printed')?.textContent).toBe('Printed: 2.8 (no unit)');
  });

  it('compares by number: "1.1 mg/dL" shown as "1.10" gets no note', () => {
    const { container } = showingAll(render(<ReviewTable grading={{}} results={printed({ valueSI: 97.24, displayValue: 1.1 })}
      history={{ measurements: [], labValues: [], documents: [] }} unitSystem="conventional" onSave={vi.fn()} onCancel={() => {}} isSaving={false} error={null} />));
    expect(container.querySelector<HTMLInputElement>('.bt-cell-review input')!.value).toBe('1.10');
    expect(container.querySelector('.bt-cell-printed')).toBeNull();
  });

  it('says nothing when the cell shows the printed number in a known unit', () => {
    const { container } = renderReview(printed({ valueSI: 85, displayValue: 85, displayUnit: 'µmol/L', displaySystem: 'si' }));
    expect(container.querySelector('.bt-cell-printed')).toBeNull();
  });

  it('a creatinine too high for blood shows its question, highlighted', () => {
    const { container } = renderReview(printed({ valueSI: 1200, displayValue: 1200, displayUnit: 'µmol/L', displaySystem: 'si', confidence: 'medium', question: 'Was this a blood test?' }));
    expect(container.querySelector('.bt-cell-question')?.textContent).toBe('Was this a blood test?');
    expect(container.querySelector('.bt-cell-low-confidence')).not.toBeNull();
  });
});

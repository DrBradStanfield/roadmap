// @vitest-environment jsdom
/**
 * US-13 AC13: the review leads with a summary, shows as rows only the values
 * the app is not sure about, keeps the sure ones behind "Show all" (they still
 * save exactly as before), and lists "Not saved" as one line that opens to the
 * reasons in the person's words. Counts-only `upload_review` on Save or Cancel.
 * Synthetic values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { ReviewTable } from './ReviewTable';
import type { FileResult } from '../lib/upload-pipeline';
import { trackProductEvent } from '../lib/server-api';

vi.mock('../lib/server-api', async (actual) => ({ ...(await actual<typeof import('../lib/server-api')>()), trackProductEvent: vi.fn() }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); vi.mocked(trackProductEvent).mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const DAY = '2026-03-10';
const v = (metric: string, valueSI: number, confidence: 'high' | 'medium' = 'high') =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit: 'mmol/L', confidence });
const labs = (values: FileResult['values'], extra: Partial<FileResult> = {}): FileResult =>
  ({ fileName: 'labs.pdf', reportDate: DAY, values, additionalValues: [], ...extra });
const held = (metricType: string, value: number): ApiMeasurement =>
  ({ id: `held-${metricType}`, metricType, value, recordedAt: `${DAY}T00:00:00.000Z`, createdAt: `${DAY}T00:00:00.000Z` });

function review(results: FileResult[], measurements: ApiMeasurement[] = []) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const view = render(<ReviewTable grading={{}} results={results} history={{ measurements, labValues: [], documents: [] }}
    unitSystem="si" onSave={onSave} onCancel={onCancel} isSaving={false} error={null} />);
  const inputs = () => Array.from(view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).map(i => i.value);
  const save = () => view.queryByRole('button', { name: /^Save/ }) as HTMLButtonElement | null;
  const saved = () => onSave.mock.calls[0][0].values.map((x: { metric: string; valueSI: number; source?: string }) => [x.metric, x.valueSI, x.source]);
  const showAll = () => view.queryByRole('button', { name: /^Show all \d+$/ });
  const event = () => vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'upload_review').map(([, meta]) => meta);
  return { view, onSave, onCancel, inputs, save, saved, showAll, event };
}

describe('US-13 AC13: summary first, unsure rows only, sure values behind "Show all"', () => {
  it('leads with the summary and shows only the unsure values under "Check these"', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2, 'medium'), v('triglycerides', 1.5, 'medium')])]);
    const summary = t.view.container.querySelector('.review-summary')!;
    expect(summary.textContent).toBe('Found 3 blood test values');
    expect(t.view.container.querySelector('.review-table')!.firstElementChild).toBe(summary);
    expect(screen.getByText('Check these 2 values')).toBeTruthy();
    expect(screen.getByText('We were not sure about these. Check each against the report.')).toBeTruthy();
    expect(t.inputs().sort()).toEqual(['1.2', '1.5']);
    expect(screen.getByText('1 value will be saved')).toBeTruthy();
    expect(t.save()!.textContent).toBe('Save 3 values');
  });

  it('a hidden sure value still saves exactly as before', () => {
    const t = review([labs([v('ldl', 3.876), v('hdl', 1.2, 'medium')])]);
    expect(t.inputs()).toEqual(['1.2']);
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['ldl', 3.876, undefined], ['hdl', 1.2, undefined]]);
  });

  it('zero unsure: no rows, "N values will be saved", "Show all N" opens and "Hide" closes them (aria-expanded)', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2)])]);
    expect(t.inputs()).toEqual([]);
    expect(screen.queryByText(/^Check th/)).toBeNull();
    expect(screen.getByText('2 values will be saved')).toBeTruthy();
    const toggle = t.showAll()!;
    expect(toggle.textContent).toBe('Show all 2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide');
    expect(t.inputs().sort()).toEqual(['1.2', '3.9']);
    fireEvent.click(toggle);
    expect(t.inputs()).toEqual([]);
  });

  it('only unsure: the rows and Save, no "Show all" (nothing hidden)', () => {
    const t = review([labs([v('ldl', 3.9, 'medium'), v('hdl', 1.2, 'medium')])]);
    expect(t.inputs().sort()).toEqual(['1.2', '3.9']);
    expect(t.showAll()).toBeNull();
    expect(screen.queryByText(/will be saved$/)).toBeNull();
  });

  it('an out-of-range value is never hidden and still blocks Save', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 999)])]);
    expect(t.inputs()).toContain('999.0');
    expect(t.save()!.disabled).toBe(true);
  });

  it('a conflict cell is always shown, Replace starts off (Q4a), and an equal held value is a count line', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2)])], [held('ldl', 3.0), held('hdl', 1.2)]);
    const replace = screen.getByRole('checkbox', { name: /Replace the saved LDL/ }) as HTMLInputElement;
    expect(replace.checked).toBe(false);
    expect(screen.getByText('1 already in your record')).toBeTruthy();
    expect(t.inputs()).toEqual(['3.9']);
  });

  it('clearing a sure value after "Show all" keeps it out of Save, and its row stays in sight after "Hide"', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2, 'medium')])]);
    fireEvent.click(t.showAll()!);
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(t.inputs().sort()).toEqual(['', '1.2']);
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['hdl', 1.2, undefined]]);
  });

  it('editing a sure value after "Show all" saves the edit', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2, 'medium')])]);
    fireEvent.click(t.showAll()!);
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.1' } });
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['ldl', 4.1, 'lab_import_edited'], ['hdl', 1.2, undefined]]);
  });

  it('nothing to save: the summary, the "Not saved" line, and Close', () => {
    const t = review([labs([], { refusedValues: [{ metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'Synthetic assistant text.' }] })]);
    expect(t.save()).toBeNull();
    expect(screen.getByRole('button', { name: '1 value not saved' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(t.onCancel).toHaveBeenCalledOnce();
  });

  it('a document keeps its card', () => {
    const letter: FileResult = { fileName: 'letter.pdf', reportDate: null, values: [], additionalValues: [],
      document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2024-03-01', contentMarkdown: 'Synthetic text.', metadata: {} } };
    const t = review([letter]);
    expect(t.view.container.querySelector('.review-summary')!.textContent).toBe('Found 1 clinic letter');
    expect(t.view.container.querySelector('.review-file-section')).not.toBeNull();
    expect(t.save()!.textContent).toBe('Save 1 document');
  });
});

describe('US-13 AC13, US-12 AC15/AC19: "Not saved" is one line that opens to the reasons, never a key', () => {
  it('names each test by its label with the reason, counts the unnamed, and shows the footer', () => {
    review([labs([v('ldl', 3.9)], {
      refusedValues: [{ metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'Do not work this out. Synthetic assistant text.' }],
      additionalValues: [{ name: 'neutrophils', value: 60, unit: 'mg/L' }], // a unit it does not take (a % is stored, US-21 AC28)
      droppedValueCount: 3, unreadValues: [{ name: 'vitamin_d', reason: 'unreadable' }],
    })]);
    const line = screen.getByRole('button', { name: '5 values not saved' });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'Values not saved' });
    const text = within(list).getAllByRole('listitem').map(li => li.textContent).join(' | ');
    expect(text).toContain('Creatinine: this unit is usually a urine result');
    expect(text).toContain('Vitamin D (25-OH): could not be read');
    expect(text).toContain('2 other values could not be read');
    expect(text).not.toMatch(/vitamin_d|neutrophils\b|Do not|Synthetic assistant/);
    expect(screen.getByText('To add one, use + Add a blood test after saving.')).toBeTruthy();
  });
});

describe('US-13 AC13 usage signal: one counts-only upload_review per review end', () => {
  // The upload flow sends it once the save finishes, never for a failed one
  // (UploadModal.outcome.test.tsx); Save hands the counts up with its decisions.
  it('on Save: group counts, the toggles opened, the changes, saved 1, handed up with the decisions', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2, 'medium')], { droppedValueCount: 1 })]);
    fireEvent.click(t.showAll()!);
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.1' } });
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    fireEvent.click(t.save()!);
    expect(t.onSave.mock.calls[0][0].review).toEqual({ sure: 1, unsure: 1, notSaved: 1, showAll: 1, notSavedOpened: 1, changedSure: 1, saved: 1 });
    expect(t.event()).toEqual([]);
  });

  it('the counts a Cancel or close sends (the upload flow sends them once): saved 0, and nothing but counts', () => {
    const countsRef: { current: (() => object) | null } = { current: null };
    render(<ReviewTable grading={{}} results={[labs([v('ldl', 3.9)])]} history={{ measurements: [], labValues: [], documents: [] }}
      unitSystem="si" onSave={vi.fn()} onCancel={vi.fn()} isSaving={false} error={null} countsRef={countsRef} />);
    expect(countsRef.current!()).toEqual({ sure: 1, saved: 0 });
    expect(Object.values(countsRef.current!()).every(n => Number.isInteger(n))).toBe(true);
  });
});

// PR 1826 fix round (US-13 AC13): one set of slot rules, the write's refusals in the cells,
// "Not saved" never a row, and the record's own count.
describe('US-13 AC13: what Save writes always has a cell, and a refused value blocks or is named', () => {
  const ferritin = (value: number, unit: string, confidence?: 'low') =>
    labs([], { fileName: `${unit}.pdf`, additionalValues: [{ name: 'Ferritin', value, unit, ...(confidence ? { confidence } : null) }] });

  for (const order of ['refused first', 'valid first'] as const) {
    it(`two files, one day: a Ferritin the write refuses takes no slot; the valid one has its row and saves (${order})`, () => {
      const files = [ferritin(10, 'mg/dL'), ferritin(85, 'µg/L', 'low')];
      const t = review(order === 'refused first' ? files : [...files].reverse());
      expect(t.inputs()).toEqual(['85']);
      expect(t.view.container.querySelector('.review-check-title')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
      expect(screen.getByRole('list', { name: 'Values not saved' }).textContent).toBe('Ferritin: this unit is not one we know for this test');
      fireEvent.click(t.save()!);
      expect(t.onSave.mock.calls[0][0].labValues.map((x: { value: number; unit: string }) => `${x.value} ${x.unit}`)).toEqual(['85 µg/L']);
    });
  }

  it('a blood pressure the wrong way up, beside a valid HDL: the write\'s line on both halves, Save blocked until corrected', () => {
    const t = review([labs([v('systolic_bp', 80), v('diastolic_bp', 120), v('hdl', 1.2)])]);
    const line = 'Blood pressure not saved: the top number (systolic) must be higher than the bottom number (diastolic). Check the report, then enter it again.';
    expect(screen.getAllByText(line)).toHaveLength(2);
    expect(t.save()!.disabled).toBe(true);
    expect(screen.getByText('Correct or clear the values with errors before saving.')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('80'), { target: { value: '130' } });
    expect(screen.queryAllByText(line)).toHaveLength(0);
    expect(t.save()!.disabled).toBe(false);
  });

  it('the pair alone: shown, blocked, never dropped silently', () => {
    const t = review([labs([v('systolic_bp', 80), v('diastolic_bp', 120)])]);
    expect(t.inputs().sort()).toEqual(['120', '80']);
    expect(t.save()!.disabled).toBe(true);
  });

  it('nothing to save (a lone Ferritin in a unit the test does not take): the summary, the "Not saved" line and Close only', () => {
    const t = review([ferritin(10, 'mg/dL')]);
    expect(t.view.container.querySelector('.review-summary')!.textContent).toBe('Found 1 blood test value');
    expect(screen.queryByText(/^Check th/)).toBeNull();
    expect(t.inputs()).toEqual([]);
    expect(screen.getByRole('button', { name: '1 value not saved' })).toBeTruthy();
    expect(t.save()).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('"already in your record" counts only the record\'s own values; an equal reading of this upload is counted nowhere', () => {
    review([labs([v('ldl', 3.9)]), labs([v('ldl', 3.9)], { fileName: 'copy.pdf' })]);
    expect(screen.queryByText(/already in your record$/)).toBeNull();
    expect(screen.getByText('1 value will be saved')).toBeTruthy();
    cleanup();
    review([labs([v('ldl', 3.9)])], [held('ldl', 3.9)]);
    expect(screen.getByText('1 already in your record')).toBeTruthy();
  });
});

// Owner, 2026-11-15: the table is placed and classified as it stands. For any cell the
// person can see and has not cleared: Save writes it, or its error blocks Save, or it
// is named under "Not saved". Never none of the three.
describe('US-13 AC13: every visible, kept cell saves, blocks Save, or is named', () => {
  /** Each visible, uncleared cell's fate. */
  const fates = (t: ReturnType<typeof review>) => {
    const savedValues = (): string[] => {
      const save = t.save();
      if (!save || save.disabled) return [];
      fireEvent.click(save);
      const { values, labValues } = t.onSave.mock.calls.at(-1)![0];
      return [...values.map((x: { valueSI: number }) => String(x.valueSI)), ...labValues.map((x: { value: number }) => String(x.value))];
    };
    const blocked = !!t.save()?.disabled && !!screen.queryByText('Correct or clear the values with errors before saving.');
    const written = savedValues();
    return t.inputs().filter(text => text !== '').map(text => (written.includes(text) ? 'saves' : blocked ? 'blocks' : 'neither'));
  };

  it('a core value out of range, edited into range, saves', () => {
    const t = review([labs([v('ldl', 999), v('hdl', 1.2)])]);
    expect(t.save()!.disabled).toBe(true);
    fireEvent.change(screen.getByDisplayValue('999.0'), { target: { value: '3.2' } });
    expect(fates(t)).toEqual(['saves']); // the LDL row; the sure HDL waits behind Show all
    expect(t.saved()).toEqual([['ldl', 3.2, 'lab_import_edited'], ['hdl', 1.2, undefined]]);
  });

  it('an in-range winner edited out of range blocks Save', () => {
    const t = review([labs([v('ldl', 3.1), v('hdl', 1.2)])]);
    fireEvent.click(t.showAll()!);
    fireEvent.change(screen.getByDisplayValue('3.1'), { target: { value: '999' } });
    expect(t.save()!.disabled).toBe(true);
    expect(fates(t).sort()).toEqual(['blocks', 'blocks']);
  });
});

// Owner, 2026-11-15 (Codex R1): a cell the person edited is pinned. It keeps its cell
// and its slot whatever its number; no other reading of that test and day is promoted
// while it stands. Clearing it releases the slot to the next reading.
describe('US-13 AC13, AC5: an edited cell is pinned', () => {
  const twoReports = () => review([labs([v('ldl', 3.1)], { fileName: 'a.pdf' }), labs([v('ldl', 3.9)], { fileName: 'b.pdf' })]);
  const edit = (from: string, to: string) => fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });

  it('the winning 3.1 edited to 999: the cell stays with its error, Save is blocked, 3.9 is never written', () => {
    const t = twoReports();
    fireEvent.click(t.showAll()!);
    edit('3.1', '999');
    expect(t.inputs()).toEqual(['999']);
    expect(t.save()!.disabled).toBe(true);
    expect(screen.getByText('Correct or clear the values with errors before saving.')).toBeTruthy();
    fireEvent.click(t.save()!);
    expect(t.onSave).not.toHaveBeenCalled();
  });

  it('the winning 3.1 edited to 3.3: 3.3 saves, and 3.9 is named as another reading that day', () => {
    const t = twoReports();
    fireEvent.click(t.showAll()!);
    edit('3.1', '3.3');
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    expect(screen.getByRole('list', { name: 'Values not saved' }).textContent).toBe('LDL Cholesterol: another reading of this test is on the same day');
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['ldl', 3.3, 'lab_import_edited']]);
  });

  it('clearing the edited cell releases the slot: 3.9 takes the cell and saves', () => {
    const t = twoReports();
    fireEvent.click(t.showAll()!);
    edit('3.1', '3.3');
    edit('3.3', '');
    expect(t.inputs()).toEqual(['3.9']);
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['ldl', 3.9, undefined]]);
  });
});

// Codex re-check of PR 1826: a winner retyped to its own rounded display is judged
// on what Save sends (750 nmol/L, valid), not on the extraction (750.1, refused).
describe('US-13 AC13: a winner is judged on the number Save would send', () => {
  it('Lp(a) 750.1 cleared and retyped as 750, the 200 moved onto its day: 750 saves, 200 is named as another reading that day', () => {
    const lpa = (valueSI: number, reportDate: string, fileName: string) =>
      labs([{ metric: 'lpa', valueSI, displayValue: valueSI, displayUnit: 'nmol/L', confidence: 'high' }], { reportDate, fileName });
    const t = review([lpa(750.1, '2025-01-10', 'a.pdf'), lpa(200, '2025-02-10', 'b.pdf')]);
    fireEvent.click(t.showAll() ?? document.body);
    const first = screen.getByLabelText(/^Lp\(a\) value from 10 Jan 2025/) as HTMLInputElement;
    fireEvent.change(first, { target: { value: '' } });
    fireEvent.change(first, { target: { value: '750' } });
    const pickers = screen.getAllByLabelText('Choose column date') as HTMLInputElement[];
    fireEvent.change(pickers[1], { target: { value: '2025-01-10' } });
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    expect(screen.getByRole('list', { name: 'Values not saved' }).textContent).toBe('Lp(a): another reading of this test is on the same day');
    fireEvent.click(t.save()!);
    expect(t.saved()).toEqual([['lpa', 750, 'lab_import_edited']]);
  });
});

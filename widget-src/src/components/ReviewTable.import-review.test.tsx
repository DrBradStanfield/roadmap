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
      additionalValues: [{ name: 'neutrophils', value: 60, unit: '%' }],
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
  it('on Save: group counts, the toggles opened, the changes, saved 1', () => {
    const t = review([labs([v('ldl', 3.9), v('hdl', 1.2, 'medium')], { droppedValueCount: 1 })]);
    fireEvent.click(t.showAll()!);
    fireEvent.change(screen.getByDisplayValue('3.9'), { target: { value: '4.1' } });
    fireEvent.click(screen.getByRole('button', { name: '1 value not saved' }));
    fireEvent.click(t.save()!);
    expect(t.event()).toEqual([{ sure: 1, unsure: 1, notSaved: 1, showAll: 1, notSavedOpened: 1, changedSure: 1, saved: 1 }]);
  });

  it('on Cancel: saved 0, and nothing but counts', () => {
    const t = review([labs([v('ldl', 3.9)])]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(t.event()).toEqual([{ sure: 1, saved: 0 }]);
    expect(t.onCancel).toHaveBeenCalledOnce();
    expect(Object.values(t.event()[0]!).every(n => Number.isInteger(n))).toBe(true);
  });
});

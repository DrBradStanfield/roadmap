// @vitest-environment jsdom
// The web upload list through the real engine (US-13 AC5, AC12, AC24, AC26; web list PR 2): the three cases that sank
// the grid's earlier attempt (PR 1937), drawn, typed into and saved as a person would. Synthetic values only.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { NOT_SAVED_TEXT } from '@roadmap/health-core/import-review';
import { ENTER_A_NUMBER, NUMERIC_SYNTAX_GUIDANCE } from '@roadmap/health-core/cell-input';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { bulkAppendValues, type BulkRow } from '@roadmap/health-core/record-edits';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { UploadListHost, type ListHost } from '../testing/upload-list-host';

afterEach(cleanup);

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
const LDL = (value: number, recordedAt = DAY): BulkRow => ({ kind: 'measurement', metricType: 'ldl', value, recordedAt, source: 'manual' });

function mount(s: UploadState, record = EMPTY) {
  const host = createRef<ListHost>() as { current: ListHost | null };
  render(<UploadListHost initial={s} record={record} now={NOW} host={host} />);
  return host.current!;
}
const row = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`)!;
const input = (key: string) => within(row(key)).getByRole('textbox') as HTMLInputElement;
const typeInto = (key: string, text: string) => {
  act(() => input(key).focus());
  fireEvent.change(input(key), { target: { value: text } });
};
const blur = () => act(() => (document.activeElement as HTMLElement).blur());
const save = () => screen.getByRole('button', { name: /^Save/ });

describe('the three cases that sank PR 1937, drawn (US-13 AC26)', () => {
  it('(a) text typed into a row, then its column moved onto an equal recorded value: the row keeps its text, Save stays blocked', () => {
    const SEP = '2026-09-01';
    const OCT = '2026-10-01';
    const host = mount(open([labRead('f0', { values: [core({ recordedAt: OCT })] })]), bulkAppendValues(EMPTY, [LDL(3.1, SEP)], NOW).file);
    const li = row('f0:v0');
    expect(li.hidden).toBe(true); // it saves and needs nothing: behind Show all
    fireEvent.click(screen.getByRole('button', { name: /^Show all/ }));
    typeInto('f0:v0', 'abc');
    blur();
    const day = document.querySelector<HTMLInputElement>(`input[data-at="f0|printed:${OCT}"]`)!;
    fireEvent.change(day, { target: { value: SEP } });
    expect(day.value).toBe(SEP);
    expect(row('f0:v0')).toBe(li); // never remounted
    expect(input('f0:v0').value).toBe('abc');
    expect(within(li).getByText(NUMERIC_SYNTAX_GUIDANCE)).toBeTruthy();
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(FIX_ERRORS_TEXT)).toBeTruthy();
    fireEvent.click(save());
    expect(host.state().phase).toBe('open');
    expect(document.activeElement).toBe(input('f0:v0'));
  });

  it('(b) LDL twice on one day, the second unticked and typed into: its row stays, with its text, then its edit and caption', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ valueSI: 3.5, displayValue: 3.5 })] })]));
    expect(row('f0:v1').hidden).toBe(true); // the same-day loser needs nothing: behind Show all
    fireEvent.click(screen.getByRole('button', { name: /^Show all/ }));
    const li = row('f0:v1');
    fireEvent.click(within(li).getByRole('checkbox'));
    expect((within(li).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    typeInto('f0:v1', '3..5');
    blur();
    expect(row('f0:v1')).toBe(li);
    expect(input('f0:v1').value).toBe('3..5');
    expect(within(li).getByText(ENTER_A_NUMBER)).toBeTruthy();
    expect((within(li).getByRole('checkbox') as HTMLInputElement).checked).toBe(true); // typing ticks it again
    expect(save().getAttribute('aria-disabled')).toBe('true');
    typeInto('f0:v1', '3.6');
    fireEvent.keyDown(input('f0:v1'), { key: 'Enter' });
    expect(row('f0:v1')).toBe(li);
    expect(input('f0:v1').value).toBe('3.6');
    expect(within(li).getByText(NOT_SAVED_TEXT.sameDay)).toBeTruthy();
    expect(within(li).queryByText(ENTER_A_NUMBER)).toBeNull();
    expect(document.querySelectorAll('li[data-key]')).toHaveLength(2);
    // Hide keeps it in sight: it holds the person's input.
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(row('f0:v1').hidden).toBe(false);
    expect(save().getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(save());
    expect(host.state().phase).toBe('saving');
  });

  it('(c) an out-of-range extraction corrected before the report has a day: no range error, Save waits on the day', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]));
    const li = row('f0:v0');
    expect(within(li).getByText('Max 12.9 mmol/L')).toBeTruthy();
    typeInto('f0:v0', '3.1');
    blur();
    expect(row('f0:v0')).toBe(li);
    expect(input('f0:v0').value).toBe('3.1');
    expect(within(li).queryByText('Max 12.9 mmol/L')).toBeNull();
    expect(input('f0:v0').getAttribute('aria-invalid')).toBe('false');
    expect(within(li).getByText(UPLOAD_TEXT.chooseDay)).toBeTruthy();
    fireEvent.click(save());
    expect(host.state().phase).toBe('open');
    expect(document.activeElement).toBe(document.querySelector('input[data-at="f0|test"]'));
  });
});

describe('the draft (US-13 AC26)', () => {
  it('Escape drops the typed text unsent; the input shows the engine value again', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 })] })]));
    typeInto('f0:v0', '3.2');
    expect(input('f0:v0').value).toBe('3.2');
    fireEvent.keyDown(input('f0:v0'), { key: 'Escape' });
    expect(input('f0:v0').value).toBe(host.see().list.rows[0].shown.text);
    blur();
    expect(host.sent).toEqual([]);
  });

  it('a Save press with a draft commits it first, then saves what the engine then shows', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 })] })]));
    typeInto('f0:v0', '3.2');
    fireEvent.click(save()); // focus never left the input
    expect(host.sent.map((e) => e.type)).toEqual(['chose', 'saveStarted']);
    expect(host.state().phase).toBe('saving');
  });

  it('a row whose input takes none draws no input', () => {
    mount(open([labRead('f0', { values: [core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' })] })]));
    expect(within(row('f0:v0')).queryByRole('textbox')).toBeNull();
  });
});

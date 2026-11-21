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
import { FIX_ERRORS_TEXT, REVIEW_CELL_TEXT, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { IMPORT_REVIEW_TEXT } from '@roadmap/health-core/import-review';
import { ENGINE_NAMES } from '../lib/upload-list-names';
import { UploadListHost, type ListHost } from '../testing/upload-list-host';
import { controlAt } from './UploadList';

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
    expect(li.hidden).toBe(false); // nothing needs checking: every row shows from the start (B5)
    typeInto('f0:v0', 'abc');
    blur();
    const day = document.querySelector<HTMLInputElement>(`[data-at="f0|printed:${OCT}"] input`)!;
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
    expect(row('f0:v1').hidden).toBe(false); // nothing needs checking: every row shows from the start (B5)
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
    expect(document.activeElement).toBe(controlAt(document, 'f0|test'));
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

});

describe('what the engine now says (US-13 AC10, AC26; US-14 AC11-13)', () => {
  it('the check heading, its note, and each row\'s reasons under it, all in the engine\'s words', () => {
    const host = mount(open([labRead('f0', { values: [core({ question: 'Is this LDL or total cholesterol?', unitGuessed: true }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', confidence: 'medium' })] })]));
    const { list } = host.see();
    expect(list.check).toBe(IMPORT_REVIEW_TEXT.checkTitle(2));
    expect(screen.getByRole('heading', { name: list.check! })).toBeTruthy();
    expect(screen.getByText(IMPORT_REVIEW_TEXT.checkFooter)).toBeTruthy();
    const reasons = within(row('f0:v0')).getAllByRole('listitem').map((li) => li.textContent);
    expect(reasons).toEqual(['Is this LDL or total cholesterol?', REVIEW_CELL_TEXT.checkUnit]);
    expect(input('f0:v0').getAttribute('aria-describedby')).toContain(within(row('f0:v0')).getByRole('list').id);
  });

  it('a row whose input takes none draws its number as text and only a tick, named by its label', () => {
    const host = mount(open([labRead('f0', { values: [core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L' })] })]));
    expect(within(row('f0:v0')).queryByRole('textbox')).toBeNull();
    expect(within(row('f0:v0')).getByText(host.see().list.rows[0].shown.text)).toBeTruthy();
    expect(within(row('f0:v0')).getByRole('checkbox').getAttribute('aria-label')).toBe(host.see().list.rows[0].label);
  });

  it('accessible names stay the labels until Brad\'s yes (one constant)', () => {
    expect(ENGINE_NAMES).toBe(false);
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({ valueSI: 500, displayValue: 500 })] })]));
    const { list } = host.see();
    expect(input('f0:v0').getAttribute('aria-label')).toBe(list.rows[0].label);
    expect(controlAt(document, 'f0|test')!.getAttribute('aria-label')).toBe(list.days[0].label);
    expect(within(document.querySelector<HTMLElement>('.upload-list-day')!).getByText(list.days[0].fileName)).toBeTruthy();
    expect(screen.getByText(list.days[0].hint!)).toBeTruthy(); // drawn in the picker, never a day that reads as picked
    expect(document.querySelector<HTMLInputElement>('[data-at="f0|test"] input')!.value).toBe('');
  });

  it('Replace is named by the engine, tied to its row, and the saved value sits beside the caption', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], NOW).file);
    const r = host.see().list.rows[0];
    const box = within(row('f0:v0')).getByRole('checkbox', { name: r.replaceLabel! });
    const described = box.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual([r.label, r.held]);
    const caption = within(row('f0:v0')).getByText(IMPORT_REVIEW_TEXT.conflictKept, { exact: false });
    expect(caption.textContent).toBe(`${r.held} ${IMPORT_REVIEW_TEXT.conflictKept}`);
    fireEvent.click(box);
    expect(host.see().list.rows[0]).toMatchObject({ replacing: true, caption: UPLOAD_TEXT.replaces });
  });

  it('retyping the shown text of a printed limit changes nothing', () => {
    const host = mount(open([labRead('f0', { additionalValues: [{ name: 'CRP', value: 0.6, unit: 'mg/L', comparator: '<' }] })]));
    const shown = input('f0:a0').value;
    typeInto('f0:a0', `${shown}1`);
    typeInto('f0:a0', shown);
    blur();
    expect(host.see().list.rows[0]).toMatchObject({ typed: null, error: null });
    expect(input('f0:a0').value).toBe(shown);
  });

  it('a letter: its title commits on blur, its kind and date through the engine', () => {
    const letter: Open['files'][number] = {
      id: 'l0', name: 'letter.pdf', bytes: 1, hash: 'h-l0', pages: { count: 1, truncated: false },
      status: { s: 'read', choices: NO_CHOICES, extraction: { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
        document: { classification: 'clinic_letter', title: 'Clinic letter', documentDate: '2026-10-20', contentMarkdown: 'Plan', metadata: {} } } },
    };
    const host = mount(open([letter]));
    const title = screen.getByRole('textbox', { name: 'Document title letter.pdf' }) as HTMLInputElement;
    act(() => title.focus());
    fireEvent.change(title, { target: { value: 'Cardiology letter' } });
    expect(host.see().view.documents!.rows[0].title).toBe('Clinic letter'); // a draft until it is left
    blur();
    expect(host.see().view.documents!.rows[0].title).toBe('Cardiology letter');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'scan_result' } });
    expect(host.see().view.documents!.rows[0].kindKey).toBe('scan_result');
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_TEXT.removeDate }));
    expect(host.see().view.documents!.rows[0]).toMatchObject({ dateKnown: false });
    expect(screen.getByText(UPLOAD_TEXT.setDate)).toBeTruthy();
    fireEvent.change(document.querySelector('li[data-doc="l0"] input[type="date"]')!, { target: { value: '2026-09-01' } });
    expect(host.see().view.documents!.rows[0]).toMatchObject({ dateKnown: true, day: '2026-09-01' });
  });
});

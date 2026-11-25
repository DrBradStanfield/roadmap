// @vitest-environment jsdom
// The web upload list, review round three on PR 1948 (US-02 AC4; US-13 AC5, AC10, AC26; US-12 AC19): each fault the
// reviews found, as the person meets it, through the real engine. Synthetic values only.
import { act, cleanup, createEvent, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra } from '@roadmap/health-core/import-review.test-helpers';
import { IMPORT_REVIEW_TEXT } from '@roadmap/health-core/import-review';
import { NUMERIC_SYNTAX_GUIDANCE } from '@roadmap/health-core/cell-input';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import { UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { controlAt } from './UploadList';
import { blur, input, LDL, labRead, letterRead, mount, open, openAll, row, save, typeInto } from '../testing/upload-list-kit';

afterEach(cleanup);
const ldl = (valueSI: number) => labRead('f0', { values: [core({ valueSI, displayValue: valueSI })] });

describe('B1: paste and drop never join lines into one number (US-02 AC4)', () => {
  it.each(['1\n2', '1\r\n2', '1\r2'])('a pasted %j keeps a visible space, then commits as held text; select-all and paste replaces it', (text) => {
    const host = mount(open([ldl(500)]));
    act(() => input('f0:v0').focus());
    input('f0:v0').select();
    fireEvent.paste(input('f0:v0'), { clipboardData: { getData: () => text } });
    expect(input('f0:v0').value).toBe('1 2');
    blur();
    expect(host.see().list.rows[0]).toMatchObject({ typed: { text: '1 2' }, error: NUMERIC_SYNTAX_GUIDANCE });
    act(() => input('f0:v0').focus());
    input('f0:v0').select();
    fireEvent.paste(input('f0:v0'), { clipboardData: { getData: () => '5.2' } });
    expect(input('f0:v0').value).toBe('5.2');
  });

  it.each(['1\n2', '1\r\n2', '1\t2'])('a dropped %j is intercepted before the browser joins its digits', (text) => {
    mount(open([ldl(500)]));
    act(() => input('f0:v0').focus());
    input('f0:v0').select();
    const event = createEvent.drop(input('f0:v0'), { dataTransfer: { getData: () => text } });
    fireEvent(input('f0:v0'), event);
    expect(event.defaultPrevented).toBe(true);
    expect(input('f0:v0').value).toBe(text.replace(/\r\n|[\r\n]/g, ' '));
  });
});

describe('B2: a commit sends the unit the person typed in (Codex R2)', () => {
  it('a unit switch while typing never changes what the typed number means', () => {
    const host = mount(open([ldl(500)]));
    typeInto('f0:v0', '120');
    act(() => host.setUnits(() => 'conventional'));
    blur();
    expect(host.sent.at(-1)).toMatchObject({ change: { typed: 'v0', text: '120', unit: 'si' } });
  });
});

describe('B3: the Not saved section (US-12 AC19)', () => {
  it('draws the engine\'s title, lines and footer before Save', () => {
    const host = mount(open([labRead('f0', { values: [core({})], unreadValues: [{ name: 'Vitamin D', reason: 'unreadable' }], refusedValues: [{ metric: 'creatinine', value: 3, unit: 'mmol/24h', reason: 'unit' }] })]));
    const section = host.see().view.sections.find((x) => x.kind === 'notSaved');
    if (section?.kind !== 'notSaved') throw new Error('the engine has no Not saved section');
    const drawn = screen.getByRole('region', { name: section.title });
    expect(within(drawn).getAllByRole('listitem').map((li) => li.textContent)).toEqual(section.lines);
    expect(within(drawn).getByText(section.footer)).toBeTruthy();
    expect(drawn.compareDocumentPosition(save()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('B4: each row sits under its own day', () => {
  it('a current and a previous LDL in one report read apart, each under its date', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' })] })]));
    const [today, before] = host.see().list.days;
    const groupOf = (key: string) => row(key).closest<HTMLElement>('[data-section]')!;
    expect(groupOf('f0:v0').dataset.section).toBe(today.key);
    expect(groupOf('f0:v1').dataset.section).toBe(before.key);
    expect(groupOf('f0:v1').querySelector('.upload-list-day-printed')!.textContent).toBe(before.source === 'column' ? before.printedLine : '');
    expect(groupOf('f0:v0').querySelector('.upload-list-day-words')!.textContent).toBe(today.label);
    expect(row('f0:v0').parentElement).not.toBe(row('f0:v1').parentElement);
  });
});

describe('B5: a row being typed in is never hidden; nothing to check opens the list', () => {
  it('a record change that drops a row\'s attention leaves the row the person is in shown', () => {
    const host = mount(open([labRead('f0', { values: [core({ confidence: 'medium' }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    expect(host.see().list.check).not.toBeNull();
    act(() => input('f0:v0').focus());
    fireEvent.change(input('f0:v0'), { target: { value: '3.2' } });
    act(() => host.setRecord(bulkAppendValues(EMPTY, [LDL(3.1)], '2026-11-02T00:00:00.000Z').file));
    expect(row('f0:v0').hidden).toBe(false);
    expect(document.activeElement).toBe(input('f0:v0'));
  });

  it('with nothing to check, a report waiting for its day shows its day control and Show all; its values open on the press (T11)', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    expect(host.see().list.check).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('li[data-key]')].every((li) => li.hidden)).toBe(true);
    expect(document.querySelector('.upload-list-day')).toBeTruthy();
    openAll();
    expect([...document.querySelectorAll<HTMLElement>('li[data-key]')].every((li) => !li.hidden)).toBe(true);
    expect(screen.getByRole('button', { name: IMPORT_REVIEW_TEXT.hide })).toBeTruthy();
  });
});

describe('B6: the day picker is one named control', () => {
  it('Save refused for a missing day focuses a control named by the day\'s label and file (US-13 AC28) and described by its hint; nothing interactive nests', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({})] })]));
    const day = host.see().list.days[0];
    fireEvent.click(save());
    const focused = document.activeElement as HTMLElement;
    expect(focused).toBe(controlAt(document, day.key));
    expect(screen.getByRole('button', { name: day.name.replace(/, /g, ' , ') })).toBe(focused);
    const described = focused.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(day.hint);
    expect(document.querySelector('button input, button button, button select')).toBeNull();
  });
});

describe('B7: a row\'s error is announced when it appears', () => {
  it('held text\'s guidance is announced by the list, and shown on its row (S7: never a row alert)', () => {
    mount(open([ldl(3.1)]));
    openAll(); // Show all starts closed (T11)
    typeInto('f0:v0', 'abc');
    blur();
    expect(document.querySelector('.upload-list [aria-live]')!.textContent).toBe(NUMERIC_SYNTAX_GUIDANCE);
    expect(within(row('f0:v0')).getByText(NUMERIC_SYNTAX_GUIDANCE)).toBeTruthy();
  });
});

describe('B8: no screen-made text', () => {
  it('the saved value and the caption stay apart for assistive tech', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], '2026-11-02T00:00:00.000Z').file);
    const r = host.see().list.rows[0];
    const caption = within(row('f0:v0')).getByText(IMPORT_REVIEW_TEXT.conflictKept, { exact: false });
    expect(caption.textContent).toBe(`${r.held} ${IMPORT_REVIEW_TEXT.conflictKept}`);
  });

  it('two letters\' titles and types have names of their own, tied to their file, never the current value', () => {
    mount(open([letterRead('l0', 'Clinic letter', 'one.pdf'), letterRead('l1', 'Clinic letter', 'two.pdf')]));
    const titles = screen.getAllByRole('textbox').map((t) => t.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' '));
    expect(titles).toEqual(['Document title one.pdf', 'Document title two.pdf']);
    for (const select of screen.getAllByRole('combobox')) {
      const name = select.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' ');
      expect(name).not.toContain((select as HTMLSelectElement).selectedOptions[0].textContent);
      expect(name).toMatch(/one\.pdf|two\.pdf/);
    }
  });

  it('Cancel and Saving... are the review\'s own words, from one place', () => {
    mount(open([ldl(3.1)]));
    expect(screen.getByRole('button', { name: UPLOAD_TEXT.cancel })).toBeTruthy();
    fireEvent.click(save());
    expect(save().textContent).toBe(UPLOAD_TEXT.saving);
  });
});

describe('B9: presses, leaving and composing', () => {
  it('Save pressed twice saves once', () => {
    const host = mount(open([ldl(3.1)]));
    fireEvent.click(save());
    fireEvent.click(save());
    expect(host.sent.filter((e) => e.type === 'saveStarted')).toHaveLength(1);
  });

  it('closing the review with a draft open drops the draft, as the grid drops its unsaved text', () => {
    const host = mount(open([ldl(500)]));
    typeInto('f0:v0', '3.2');
    host.unmount();
    expect(host.sent).toEqual([]);
  });

  it('Enter while an input method is composing commits nothing; the commit after it sends once', () => {
    const host = mount(open([ldl(500)]));
    typeInto('f0:v0', '3.2');
    fireEvent.keyDown(input('f0:v0'), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(host.sent).toEqual([]);
    fireEvent.keyDown(input('f0:v0'), { key: 'Enter' });
    blur();
    expect(host.sent.filter((e) => e.type === 'chose')).toHaveLength(1);
  });

  it('Save waiting on a day says so in its line', () => {
    mount(open([labRead('f0', { reportDate: null, values: [core({})], additionalValues: [extra()] })]));
    expect(within(document.querySelector<HTMLElement>('.upload-list-save-line')!).getByText(UPLOAD_TEXT.chooseDay)).toBeTruthy();
    expect(DAY).toBe('2026-11-01');
  });
});

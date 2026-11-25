// @vitest-environment jsdom
// The web upload list, review round five on PR 1948 (US-13 AC5, AC10, AC11, AC26; US-02 AC4): each fault the re-check
// found (S1-S8), as the person meets it, through the real engine. Synthetic values only.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { NUMERIC_SYNTAX_GUIDANCE } from '@roadmap/health-core/cell-input';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import { longDate, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { controlAt } from './UploadList';
import { blur, input, LDL, labRead, letterRead, mount, open, openAll, row, save, showAll, typeInto } from '../testing/upload-list-kit';

afterEach(cleanup);
const unitOf = (key: string) => row(key).querySelector('.upload-list-unit')!.textContent;
const twoLdl = () => labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 }), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' })] });
/** The text of every element an aria-describedby names, in order. */
const described = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? null);
const announced = () => document.querySelector<HTMLElement>('.upload-list [aria-live]')!;

describe('S1: an open draft keeps the unit label it was typed under (Codex R1, US-13 AC5)', () => {
  it('the display unit changes mid-typing: the label still reads the typed unit, no toggle shows, and Save writes that unit', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 })] })]));
    const typedUnder = host.see().list.rows[0].unit;
    typeInto('f0:v0', '5');
    act(() => host.setUnits(() => 'conventional'));
    expect(host.see().list.rows[0].unit.label).not.toBe(typedUnder.label); // the row's unit now is the other one
    expect(unitOf('f0:v0')).toBe(typedUnder.label);
    expect(row('f0:v0').querySelector('.upload-list-unit button')).toBeNull();
    fireEvent.click(save());
    expect(host.sent[0]).toMatchObject({ change: { typed: 'v0', text: '5', unit: typedUnder.typeIn } });
  });

  it('an Lp(a) row shows no choice while its draft is open, only the unit it was typed in', () => {
    const host = mount(open([labRead('f0', { values: [core({ metric: 'lpa', valueSI: 900, displayValue: 900, displayUnit: 'nmol/L' })] })]));
    const label = host.see().list.rows[0].unit.label;
    typeInto('f0:v0', '80');
    expect(within(row('f0:v0')).queryByRole('radiogroup')).toBeNull();
    expect(unitOf('f0:v0')).toBe(label);
  });
});

describe('S2: a unit press commits an open draft first, with no blur (adversary F3)', () => {
  it('another row\'s chip: the draft is sent in the unit it was typed in, then the unit press', () => {
    const host = mount(open([twoLdl()]));
    const typeIn = host.see().list.rows[0].unit.typeIn;
    typeInto('f0:v0', '3.2');
    fireEvent.click(row('f0:v1').querySelector('button.bt-unit-chip')!); // a tap that never moves the focus
    expect(host.sent).toEqual([expect.objectContaining({ type: 'chose', change: { typed: 'v0', text: '3.2', unit: typeIn } })]);
    expect(host.presses).toEqual([{ metric: 'ldl', unit: 'conventional' }]);
    expect(document.querySelector<HTMLElement>('.upload-list')!.dataset.draft).toBeUndefined();
  });

  it('Lp(a)\'s choice: the draft on another row is sent first', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 }), core({ metric: 'lpa', valueSI: 900, displayValue: 900, displayUnit: 'nmol/L' })] })]));
    typeInto('f0:v0', '3.2');
    fireEvent.click(within(row('f0:v1')).getByRole('radio', { checked: false, name: 'mg/dL' }));
    expect(host.sent.map((e) => e.type)).toEqual(['chose']);
    expect(host.presses).toEqual([{ metric: 'lpa', unit: 'mg/dL' }]);
  });
});

describe('S4: Show all is a latch (adversary F4, owner ruling)', () => {
  it('a clean report, opened by the person; typing "abc" in one row and leaving it collapses nothing, and the next row\'s press lands', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    expect(host.see().list.check).toBeNull();
    openAll(); // it starts closed (T11)
    typeInto('f0:v0', 'abc');
    blur(); // iOS Safari: a tap on a checkbox blurs the input and focuses nothing
    expect(host.see().list.check).not.toBeNull();
    expect(row('f0:v1').hidden).toBe(false);
    expect(screen.getByRole('button', { expanded: true }).textContent).toBe(host.see().list.hide);
    fireEvent.click(row('f0:v1').querySelector('.upload-list-tick')!);
    expect(host.see().list.rows[1].ticked).toBe(false);
  });

  it('the latch is set when the review first has rows: a fix that clears the check later never opens it', () => {
    const sending = { ...labRead('f0', {}), status: { s: 'sending' as const, attempt: 1 } };
    const host = mount(open([sending]));
    expect(document.querySelectorAll('li[data-key]')).toHaveLength(0);
    act(() => host.send({ type: 'answered', run: 1, id: 'f0', extraction: { classification: 'lab_report', reportDate: '2026-11-01', values: [core({ valueSI: 500, displayValue: 500 }), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })], additionalValues: [], unrecognized: [], document: null }, legacy: false, now: NOW }));
    expect(host.see().list.check).not.toBeNull();
    expect(row('f0:v1').hidden).toBe(true); // the first rows needed checking: closed
    typeInto('f0:v0', '3.2');
    blur();
    expect(host.see().list.check).toBeNull();
    expect(row('f0:v1').hidden).toBe(true); // only the person's press opens it
    expect(screen.getByRole('button', { expanded: false }).textContent).toBe(host.see().list.showAll);
  });
});

describe('S5: Replace is described by the saved value and the value it would write, as text (Codex R3, US-13 AC10)', () => {
  it('with no text held, the engine\'s shown value and unit; never an input', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], NOW).file);
    const r = host.see().list.rows[0];
    const box = within(row('f0:v0')).getByRole('checkbox', { name: r.replaceLabel! });
    expect(described(box)).toEqual([r.label, r.held, `${r.shown.text} ${r.unit.label}`]);
    expect(screen.getByRole('checkbox', { description: `${r.label} ${r.held} ${r.shown.text} ${r.unit.label}` })).toBe(box);
    for (const id of box.getAttribute('aria-describedby')!.split(' ')) expect(document.getElementById(id)!.matches('input, select, button')).toBe(false);
  });
});

describe('S6: the day picker says its day; an Lp(a) input names its current unit only (adversary F6)', () => {
  it('the picker button\'s description carries the chosen day in words', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({})] })]));
    fireEvent.change(document.querySelector('[data-at="f0|test"] input')!, { target: { value: '2026-10-20' } });
    expect(host.see().list.days[0].picker).toBe('2026-10-20');
    expect(described(controlAt(document, 'f0|test')!)).toContain(longDate('2026-10-20'));
  });

  it('where the browser has no showPicker (S9), the press falls back to the input\'s own click', () => {
    mount(open([labRead('f0', { reportDate: null, values: [core({})] })]));
    const date = document.querySelector<HTMLInputElement>('[data-at="f0|test"] input')!;
    expect('showPicker' in date).toBe(false); // jsdom, as Safari before 16
    let clicked = 0;
    date.addEventListener('click', () => { clicked++; });
    fireEvent.click(controlAt(document, 'f0|test')!);
    expect(clicked).toBe(1);
  });

  it('an Lp(a) input is described by its current unit, not all three', () => {
    const host = mount(open([labRead('f0', { values: [core({ metric: 'lpa', valueSI: 90, displayValue: 90, displayUnit: 'nmol/L' })] })]));
    openAll(); // Show all starts closed (T11)
    const r = host.see().list.rows[0];
    expect(described(input('f0:v0'))).toEqual([r.unit.current]);
  });
});

describe('S7: an error is announced once, when the person\'s step makes it (adversary F8)', () => {
  it('a review that opens with an error announces nothing; a commit that makes one announces it once; a unit press does not again', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 }), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' })] })]));
    expect(host.see().list.rows[0].error).not.toBeNull();
    expect(document.querySelector('.upload-list [role="alert"]')).toBeNull();
    expect(announced().textContent).toBe('');
    showAll();
    expect(announced().textContent).toBe('');
    typeInto('f0:v1', 'abc');
    blur();
    expect(announced().textContent).toBe(NUMERIC_SYNTAX_GUIDANCE);
    const node = announced().firstElementChild;
    fireEvent.click(row('f0:v0').querySelector('button.bt-unit-chip')!);
    expect(announced().firstElementChild).toBe(node);
    expect(announced().textContent).toBe(NUMERIC_SYNTAX_GUIDANCE);
  });
});

describe('round six: the engine\'s printed note, letter preview and picker words (PR 1953)', () => {
  it('a value printed in another unit shows the engine\'s "Printed:" note under it, describing its input (US-13 AC11)', () => {
    const host = mount(open([labRead('f0', { values: [core({ valueSI: 3.1, displayValue: 120, displayUnit: 'mg/dL' })] })]));
    openAll(); // Show all starts closed (T11)
    const r = host.see().list.rows[0];
    expect(r.printed).not.toBeNull();
    const note = within(row('f0:v0')).getByText(r.printed!);
    expect(note.classList.contains('bt-cell-printed')).toBe(true);
    expect(described(input('f0:v0'))).toContain(r.printed);
  });

  it('a row the report printed as shown has no note', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]));
    expect(host.see().list.rows[0].printed).toBeNull();
    expect(row('f0:v0').querySelector('.bt-cell-printed')).toBeNull();
  });

  it('a long letter shows the engine\'s preview cut, as text', () => {
    const letter = letterRead('l0', 'Clinic letter');
    if (letter.status.s !== 'read') throw new Error('a read letter');
    letter.status.extraction.document!.contentMarkdown = `Plan <b>x</b> ${'a'.repeat(400)}`;
    const host = mount(open([letter]));
    const page = host.see().page.letters[0];
    expect(page.preview).not.toBe(page.text);
    const box = document.querySelector<HTMLElement>('li[data-doc="l0"] .review-document-preview')!;
    expect(box.textContent).toBe(page.preview);
    expect(box.querySelector('b')).toBeNull();
  });

  it('each picker shows exactly the engine\'s pickerLine: an unset day, a picked day, a letter with and without a date', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({})] }), letterRead('l0', 'Clinic letter')]));
    const dayButton = () => controlAt(document, 'f0|test')!;
    expect(dayButton().textContent).toBe(host.see().list.days[0].pickerLine);
    fireEvent.change(document.querySelector('[data-at="f0|test"] input')!, { target: { value: '2026-10-20' } });
    expect(dayButton().textContent).toBe(host.see().list.days[0].pickerLine);
    const letterButton = () => document.querySelector<HTMLElement>('li[data-doc="l0"] .upload-list-picker-button')!;
    expect(letterButton().textContent).toBe(host.see().page.letters[0].pickerLine);
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_TEXT.removeDate }));
    expect(letterButton().textContent).toBe(host.see().page.letters[0].pickerLine);
    expect(letterButton().textContent).toBe(UPLOAD_TEXT.setDate);
  });
});

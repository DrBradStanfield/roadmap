// @vitest-environment jsdom
// The web upload list, review round four on PR 1948 (US-05 AC2; US-13 AC5, AC24, AC26; US-14 AC11-13): the engine's unit
// controls, day picker words, Save and close words and letter text (PR 1951), drawn through the real engine. These were
// the round-three it.todos. Synthetic values only.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, EMPTY } from '@roadmap/health-core/import-review.test-helpers';
import { DAY_NOT_HAPPENED } from '@roadmap/health-core/lab-series';
import { longDate, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { blur, labRead, letterRead, mount, open, row, save, typeInto } from '../testing/upload-list-kit';

afterEach(cleanup);
const twoLdl = () => labRead('f0', { values: [core({ valueSI: 500, displayValue: 500 }), core({ valueSI: 2.9, displayValue: 2.9, recordedAt: '2026-09-15' })] });
const unitOf = (key: string) => row(key).querySelector('.upload-list-unit')!.textContent;

describe('units (US-05 AC2, US-13 AC5)', () => {
  it('a row with a unit toggle draws the grid\'s chip; a press asks for that unit and the engine shows it', () => {
    const host = mount(open([twoLdl()]));
    const r = host.see().list.rows[0];
    expect(r.unit.toggle).toBe('conventional');
    expect(unitOf('f0:v0')).toBe(r.unit.label);
    fireEvent.click(within(row('f0:v0')).getByRole('button', { name: r.unit.label }));
    expect(host.presses).toEqual([{ metric: 'ldl', unit: 'conventional' }]);
    expect(unitOf('f0:v0')).toBe(host.see().list.rows[0].unit.label);
    expect(unitOf('f0:v0')).not.toBe(r.unit.label);
  });

  it('held text keeps the unit it was typed in, with no toggle, while another row of the test switches', () => {
    const host = mount(open([twoLdl()]));
    const before = unitOf('f0:v0');
    typeInto('f0:v0', 'abc');
    blur();
    expect(within(row('f0:v0')).queryByRole('button', { name: before })).toBeNull();
    fireEvent.click(row('f0:v1').querySelector('button.bt-unit-chip')!); // the other LDL, behind Show all
    expect(unitOf('f0:v0')).toBe(before);
    expect(unitOf('f0:v1')).not.toBe(before);
    expect(host.see().list.rows[0].unit).toMatchObject({ label: before, toggle: null });
  });

  it('a commit sends the unit the engine says the row is typed in', () => {
    const host = mount(open([twoLdl()]));
    const r = host.see().list.rows[0];
    typeInto('f0:v0', '3.2');
    blur();
    expect(host.sent.at(-1)).toMatchObject({ change: { typed: 'v0', text: '3.2', unit: r.unit.typeIn } });
  });

  it('Lp(a) draws its three units with the one read marked; a choice asks for it; held text draws none', () => {
    const host = mount(open([labRead('f0', { values: [core({ metric: 'lpa', valueSI: 900, displayValue: 900, displayUnit: 'nmol/L' })] })]));
    const r = host.see().list.rows[0];
    const group = within(row('f0:v0')).getByRole('radiogroup');
    expect(within(group).getAllByRole('radio').map((b) => b.textContent)).toEqual([...r.unit.choices!]);
    expect(within(group).getByRole('radio', { checked: true }).textContent).toBe(r.unit.current);
    const other = r.unit.choices!.find((u) => u !== r.unit.current)!;
    fireEvent.click(within(group).getByRole('radio', { name: other }));
    expect(host.presses).toEqual([{ metric: 'lpa', unit: other }]);
    expect(host.see().list.rows[0].unit.current).toBe(other);
    typeInto('f0:v0', 'abc');
    blur();
    expect(within(row('f0:v0')).queryByRole('radiogroup')).toBeNull();
    expect(unitOf('f0:v0')).toBe(host.see().list.rows[0].unit.label);
  });
});

describe('the day picker (US-13 AC24)', () => {
  it('a day chosen that has not happened shows in the picker, with the engine\'s why beside it', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({})] })]));
    const picker = document.querySelector<HTMLInputElement>('[data-at="f0|test"] input')!;
    fireEvent.change(picker, { target: { value: '2026-12-01' } });
    const day = host.see().list.days[0];
    expect(day).toMatchObject({ picker: '2026-12-01', hint: DAY_NOT_HAPPENED, day: null });
    const control = document.querySelector<HTMLElement>('[data-at="f0|test"]')!;
    expect(within(control).getByRole('button').textContent).toBe(longDate('2026-12-01'));
    const hint = control.closest('.upload-list-day')!.querySelector('.upload-list-day-hint')!;
    expect(hint.textContent).toBe(DAY_NOT_HAPPENED);
    expect(within(control).queryByText(DAY_NOT_HAPPENED)).toBeNull(); // beside the picker, not in it
  });
});

describe('the page\'s words and letters (US-14 AC11-13)', () => {
  it('Save and close words come from the page; nothing to save keeps Save drawn, refused, with its why', () => {
    const host = mount(open([labRead('f0', { values: [] })]), EMPTY);
    const { page, view } = host.see();
    expect(view.save).toMatchObject({ enabled: false, why: UPLOAD_TEXT.saveNothing });
    expect(save().textContent).toBe(page.save);
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(UPLOAD_TEXT.saveNothing)).toBeTruthy();
    expect(screen.getByRole('button', { name: page.close })).toBeTruthy();
  });

  it('a letter\'s text is shown as text, never as markup', () => {
    const letter = letterRead('l0', 'Clinic letter');
    if (letter.status.s !== 'read') throw new Error('a read letter');
    letter.status.extraction.document!.contentMarkdown = '## Plan\n<b>bold?</b> <img src=x onerror=alert(1)>';
    const host = mount(open([letter]));
    const text = host.see().page.letters[0].preview;
    const preview = document.querySelector<HTMLElement>('li[data-doc="l0"] .review-document-preview')!;
    expect(preview.textContent).toBe(text);
    expect(preview.querySelector('b, img, h2')).toBeNull();
  });

  it('while saving, Save says so in the page\'s words', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]));
    fireEvent.click(save());
    expect(save().textContent).toBe(host.see().page.save);
    expect(host.see().page.save).toBe(UPLOAD_TEXT.saving);
  });
});

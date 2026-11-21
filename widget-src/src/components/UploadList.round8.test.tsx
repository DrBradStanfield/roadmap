// @vitest-environment jsdom
// The web upload list, Codex at 8cb68bc78 (US-13 AC21, AC26): T8, a press acts on what the person saw when they pressed,
// though the blur's commit changes that control first; T9, no unit control acts while the review is not editable. Through
// the real engine, with the full pointer sequence: pointerdown on the control while the input holds focus, the blur the
// press causes, then the click. Synthetic values only.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import { input, LDL, labRead, mount, open, row, save, typeInto } from '../testing/upload-list-kit';

afterEach(cleanup);
/** The person opens Show all, when the list offers it (T11: it starts closed). */
const openAll = () => { const b = screen.queryByRole('button', { name: /^Show all/ }); if (b) fireEvent.click(b); };
const tick = (key: string) => row(key).querySelector<HTMLInputElement>('.upload-list-tick')!;
const replace = (key: string) => row(key).querySelector<HTMLInputElement>('.upload-list-replace input')!;
/** A mouse press on `el` while the input has the focus: pointerdown, the blur it causes, then the click. */
const press = (el: HTMLInputElement) => {
  fireEvent.pointerDown(el);
  act(() => el.focus()); // the input blurs: its draft commits before the click lands
  fireEvent.click(el);
};

describe('T8: a press acts on the control as it was drawn when pressed (Codex at 8cb68bc78)', () => {
  it('a ticked row emptied, then its still-checked tick pressed: the row ends unticked and Save leaves it out', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    openAll();
    expect(tick('f0:v0').checked).toBe(true);
    typeInto('f0:v0', '');
    press(tick('f0:v0'));
    expect(host.see().list.rows[0]).toMatchObject({ ticked: false, saves: false });
    expect(tick('f0:v0').checked).toBe(false);
    fireEvent.click(save());
    expect(host.sent.filter((e) => e.type === 'saveStarted')).toHaveLength(1);
    expect(host.see().list.rows[0].saves).toBe(false);
  });

  it('a cleared row typed into, then its unchecked tick pressed: the row ends ticked, sent once', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    openAll();
    fireEvent.click(tick('f0:v0'));
    expect(tick('f0:v0').checked).toBe(false);
    typeInto('f0:v0', '3.2');
    press(tick('f0:v0'));
    expect(host.see().list.rows[0].ticked).toBe(true);
    expect(host.sent.filter((e) => e.type === 'chose' && 'tick' in e.change)).toHaveLength(2); // the first untick, then this one
  });

  it('Replace checked, the input emptied, then Replace pressed as drawn (checked): it ends off', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], NOW).file);
    openAll();
    fireEvent.click(replace('f0:v0'));
    expect(host.see().list.rows[0].replacing).toBe(true);
    typeInto('f0:v0', '');
    press(replace('f0:v0'));
    expect(host.see().list.rows[0].replacing).toBe(false);
    expect(replace('f0:v0').checked).toBe(false);
  });

  it('a cleared row with a Replace, a number typed, then Replace pressed as drawn (unchecked): it ends on', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], NOW).file);
    openAll();
    fireEvent.click(tick('f0:v0'));
    typeInto('f0:v0', '3.4');
    press(replace('f0:v0'));
    expect(host.see().list.rows[0]).toMatchObject({ replacing: true, ticked: true });
  });
});

describe('T9: no unit control acts while the review is not editable (Codex low)', () => {
  it('while saving, the unit chip and Lp(a)\'s choices are disabled and a press sends nothing', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ metric: 'lpa', valueSI: 90, displayValue: 90, displayUnit: 'nmol/L' })] })]));
    openAll();
    fireEvent.click(save());
    expect(host.see().view.editable).toBe(false);
    const chip = row('f0:v0').querySelector<HTMLButtonElement>('button.bt-unit-chip')!;
    const radios = within(row('f0:v1')).getAllByRole('radio') as HTMLButtonElement[];
    expect([chip, ...radios].every((b) => b.disabled)).toBe(true);
    fireEvent.click(chip);
    for (const r of radios) fireEvent.click(r);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(host.presses).toEqual([]);
    expect(input('f0:v0').disabled).toBe(true);
  });
});

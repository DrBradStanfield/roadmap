// @vitest-environment jsdom
// The web upload list, final re-check on PR 1948 (US-13 AC10, AC12, AC26): T1-T4, as the person meets them, through the
// real engine and a synchronous host (the host's contract: a choice lands before `choose` returns). Synthetic values only.
import { act, cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import { NUMERIC_SYNTAX_GUIDANCE } from '@roadmap/health-core/cell-input';
import { bulkAppendValues } from '@roadmap/health-core/record-edits';
import type { UploadEvent } from '@roadmap/health-core/upload-flow';
import { reviewedWrites, uploadReview } from '@roadmap/health-core/upload-review';
import { uploadSavePlan } from '@roadmap/health-core/upload-plan';
import { blur, input, LDL, labRead, letterRead, mount, open, row, save, typeInto } from '../testing/upload-list-kit';

afterEach(cleanup);
const ldl = (valueSI: number) => labRead('f0', { values: [core({ valueSI, displayValue: valueSI })] });
const announced = () => document.querySelector<HTMLElement>('.upload-list [aria-live]')!;
const described = (el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? null);
const starts = (sent: UploadEvent[]) => sent.filter((e) => e.type === 'saveStarted');

describe('T1: Save saves exactly what the engine holds after the commit (Codex R1, adversary R1)', () => {
  const leave = { blur: () => blur(), Enter: () => fireEvent.keyDown(input('f0:v0'), { key: 'Enter' }) };
  it.each(Object.keys(leave) as Array<keyof typeof leave>)('a valid number, committed by %s, then Save: the saved writes are the engine\'s after the commit', (how) => {
    const host = mount(open([ldl(500)]));
    typeInto('f0:v0', '3.2');
    leave[how]();
    const committed = host.state();
    fireEvent.click(save());
    const started = starts(host.sent);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ reviewed: reviewedWrites(uploadReview(committed, EMPTY, NOW)) });
    expect(host.state().phase).toBe('saving');
  });

  it.each(Object.keys(leave) as Array<keyof typeof leave>)('held text, committed by %s, then Save: nothing is saved and the focus goes to the row', (how) => {
    const host = mount(open([ldl(3.1)]));
    typeInto('f0:v0', 'abc');
    leave[how]();
    fireEvent.click(save());
    expect(starts(host.sent)).toHaveLength(0);
    expect(host.state().phase).toBe('open');
    expect(document.activeElement).toBe(input('f0:v0'));
  });

  it('a double press with a draft open commits once and starts one save', () => {
    const host = mount(open([ldl(500)]));
    typeInto('f0:v0', '3.2');
    fireEvent.click(save());
    fireEvent.click(save());
    expect(host.sent.filter((e) => e.type === 'chose')).toHaveLength(1);
    expect(starts(host.sent)).toHaveLength(1);
  });

  it('a press whose commit leaves Save refused focuses the blocker and saves nothing', () => {
    const host = mount(open([ldl(3.1)]));
    typeInto('f0:v0', 'abc');
    fireEvent.click(save()); // the focus never left the input
    expect(host.see().list.rows[0].typed?.text).toBe('abc');
    expect(starts(host.sent)).toHaveLength(0);
    expect(document.activeElement).toBe(input('f0:v0'));
  });
});

describe('T2: a new error text on a row that had one is announced, politely (adversary R3, US-13 AC12)', () => {
  it('held "abc", then "1,234": the row now asks which number, and that is said', () => {
    const host = mount(open([ldl(3.1)]));
    expect(announced().getAttribute('aria-live')).toBe('polite');
    typeInto('f0:v0', 'abc');
    blur();
    expect(announced().textContent).toBe(NUMERIC_SYNTAX_GUIDANCE);
    typeInto('f0:v0', '1,234');
    blur();
    const asked = host.see().list.rows[0].error!;
    expect(asked).not.toBe(NUMERIC_SYNTAX_GUIDANCE);
    expect(announced().textContent).toBe(asked);
  });
});

describe('T3: a choice that changes nothing leaves no announcement waiting for an engine step (adversary R2)', () => {
  it('a letter date the engine refuses (a day to come), then a file landing with an error: nothing is said', () => {
    const sending = { ...labRead('f1', {}), status: { s: 'sending' as const, attempt: 1 } };
    const host = mount(open([letterRead('l0', 'Clinic letter'), sending]));
    const before = host.state();
    fireEvent.change(document.querySelector('li[data-doc="l0"] input[type="date"]')!, { target: { value: '2026-12-01' } });
    expect(host.sent.filter((e) => e.type === 'chose')).toHaveLength(1);
    expect(host.state()).toBe(before); // refused: the engine changed nothing
    act(() => host.send({ type: 'answered', run: 1, id: 'f1', extraction: { classification: 'lab_report', reportDate: '2026-11-01', values: [core({ valueSI: 500, displayValue: 500 })], additionalValues: [], unrecognized: [], document: null }, legacy: false, now: NOW }));
    expect(host.see().list.rows.some((r) => r.fileId === 'f1' && r.error)).toBe(true);
    expect(announced().textContent).toBe('');
  });
});

describe('T4: Replace never describes held text as the value it would write (adversary R4)', () => {
  it('a draft open on the row, then held text: the description keeps the label and the saved value only', () => {
    const host = mount(open([labRead('f0', { values: [core({})] })]), bulkAppendValues(EMPTY, [LDL(2.9)], NOW).file);
    const r = host.see().list.rows[0];
    const box = () => within(row('f0:v0')).getByRole('checkbox', { name: r.replaceLabel! });
    typeInto('f0:v0', 'abc');
    expect(described(box())).toEqual([r.label, r.held]);
    blur();
    expect(host.see().list.rows[0].typed?.text).toBe('abc');
    expect(described(box())).toEqual([r.label, r.held]);
    expect(row('f0:v0').textContent).not.toContain('abc mmol/L');
  });
});

describe('T7: clearing a letter\'s date makes it unknown; a cleared lab day is ignored, as the grid does (US-13 AC6)', () => {
  const datesSaved = (host: ReturnType<typeof mount>) =>
    uploadSavePlan(host.state(), EMPTY, NOW, uploadReview(host.state(), EMPTY, NOW), false).documents.map((d) => d.fields.documentDate);
  const dateInput = () => document.querySelector<HTMLInputElement>('li[data-doc="l0"] input[type="date"]')!;

  it('a letter\'s native date cleared: Save plans no document date, and the picker says so (ReviewTable.document-dates port)', () => {
    const host = mount(open([letterRead('l0', 'Clinic letter')]));
    expect(datesSaved(host)).toEqual(['2026-10-20']);
    fireEvent.change(dateInput(), { target: { value: '2024-08-09' } });
    expect(datesSaved(host)).toEqual(['2024-08-09']);
    fireEvent.change(dateInput(), { target: { value: '' } });
    expect(host.sent.at(-1)).toMatchObject({ type: 'chose', change: { document: { date: null } } });
    expect(datesSaved(host)).toEqual([null]);
    expect(host.see().view.documents!.rows[0].dateKnown).toBe(false);
    expect(document.querySelector('li[data-doc="l0"] .upload-list-picker-button')!.textContent).toBe(host.see().page.letters[0].pickerLine);
  });

  it('a lab day cleared in its picker sends nothing: the grid ignores an empty lab day (ReviewMatrix.tsx DateHeader)', () => {
    const host = mount(open([labRead('f0', { reportDate: null, values: [core({})] })]));
    const picker = () => document.querySelector<HTMLInputElement>('[data-at="f0|test"] input')!;
    fireEvent.change(picker(), { target: { value: '2026-10-20' } });
    const sent = host.sent.length;
    fireEvent.change(picker(), { target: { value: '' } });
    expect(host.sent).toHaveLength(sent);
    expect(host.see().list.days[0].picker).toBe('2026-10-20');
  });
});

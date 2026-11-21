// @vitest-environment jsdom
// The web upload list, Codex at 51fb6a178 and the owner's read (US-12 AC9, US-13 AC26): T10, the done screen names the
// files not fully read; T11, Show all starts closed; T12, a cancelled press leaves no intent behind. Through the real
// engine. Synthetic values only.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { core } from '@roadmap/health-core/import-review.test-helpers';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { FILE_NOTICE_TEXT, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';
import { labRead, mount, open, row, typeInto, type Open } from '../testing/upload-list-kit';

afterEach(cleanup);
const done = (s: ReturnType<typeof open>): UploadState => ({ ...s, phase: 'done', outcome: { values: 1, documents: 0, archived: 0 } });
const notices = () => document.querySelector<HTMLElement>('.upload-done .upload-file-notices');

describe('T10: the done screen names the files not fully read (US-12 AC9)', () => {
  it('after a truncated read: the file and the engine\'s words, under the saved line', () => {
    const cut = { ...labRead('f0', { values: [core({})] }, 'long-report.pdf'), pages: { count: 40, truncated: true } };
    const host = mount(done(open([cut])));
    const { view } = host.see();
    expect(view.files.rows).toEqual([expect.objectContaining({ name: 'long-report.pdf', status: FILE_NOTICE_TEXT.truncated, notFullyRead: true })]);
    expect(screen.getByText(view.done!.line)).toBeTruthy();
    const list = within(notices()!).getByRole('list');
    expect(within(list).getByText('long-report.pdf')).toBeTruthy();
    expect(list.textContent).toContain(FILE_NOTICE_TEXT.truncated);
  });

  it('after one good report and one failed file: the failed file and its reason', () => {
    const failed = { ...labRead('f1', {}, 'scan.pdf'), status: { s: 'failed' as const, reason: 'server' as const, attempt: 3 } };
    const host = mount(done(open([labRead('f0', { values: [core({})] }, 'good.pdf'), failed])));
    const section = host.see().view.sections.find((x) => x.kind === 'failed');
    if (section?.kind !== 'failed') throw new Error('the engine keeps the failed file on the done view');
    const list = within(notices()!).getByRole('list');
    expect(within(list).getByText('scan.pdf')).toBeTruthy();
    expect(list.textContent).toContain(section.rows[0].line);
    expect(list.textContent).not.toContain('good.pdf');
  });
});

describe('T11: Show all starts closed, whatever the review needs (US-13 AC26, decisions-for-brad Open)', () => {
  it('a report with nothing to check: its rows sit behind "Show all", only the press opens them', () => {
    const host = mount(open([labRead('f0', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' })] })]));
    expect(host.see().list.check).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('li[data-key]')].every((li) => li.hidden)).toBe(true);
    const button = screen.getByRole('button', { expanded: false });
    expect(button.textContent).toBe(host.see().list.showAll);
    fireEvent.click(button);
    expect([...document.querySelectorAll<HTMLElement>('li[data-key]')].every((li) => !li.hidden)).toBe(true);
  });
});

describe('T12: a cancelled press leaves no intent for a later activation (owner\'s read of usePress)', () => {
  it('pointerdown then pointercancel, the box flipped by a commit, then a bare click: the box\'s own new state is sent', () => {
    const host = mount(open([labRead('f0', { values: [core({ confidence: 'medium' })] })]));
    const tick = row('f0:v0').querySelector<HTMLInputElement>('.upload-list-tick')!;
    typeInto('f0:v0', '');
    fireEvent.pointerDown(tick); // drawn checked: a press would mean "off"
    fireEvent.pointerCancel(tick); // a scroll took the touch
    act(() => (document.activeElement as HTMLElement).blur()); // the empty commit unticks the row
    expect(tick.checked).toBe(false);
    act(() => tick.click()); // assistive tech's click, with no pointerdown of its own
    expect(host.see().list.rows[0].ticked).toBe(true);
  });

  it('a claim is cleared when the press leaves the control and when the box loses the focus', () => {
    const host = mount(open([labRead('f0', { values: [core({ confidence: 'medium' })] })]));
    const tick = row('f0:v0').querySelector<HTMLInputElement>('.upload-list-tick')!;
    typeInto('f0:v0', '');
    fireEvent.pointerDown(tick);
    fireEvent.pointerLeave(tick.closest('label')!);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => tick.click());
    expect(host.see().list.rows[0].ticked).toBe(true);
    act(() => tick.focus());
    fireEvent.keyDown(tick, { key: ' ' }); // drawn checked: Space claims "off"
    act(() => tick.blur());
    act(() => tick.click());
    expect(host.see().list.rows[0].ticked).toBe(false); // the box's own new state, not a stale claim
  });
});

describe('T10: the error screens name them too (US-12 AC9), in the list\'s Files block (UploadListParts.tsx Files)', () => {
  it('a failed Save keeps the truncated file\'s notice and the failed file\'s reason on screen', () => {
    const cut = { ...labRead('f0', { values: [core({})] }, 'long-report.pdf'), pages: { count: 40, truncated: true } };
    const failed = { ...labRead('f1', {}, 'scan.pdf'), status: { s: 'failed' as const, reason: 'server' as const, attempt: 3 } };
    const host = mount({ ...open([cut, failed]), phase: 'saveFailed', attempt: 1, message: 'Network' });
    const files = document.querySelector<HTMLElement>('.upload-list-files')!;
    expect(files.textContent).toContain(FILE_NOTICE_TEXT.truncated);
    const section = host.see().view.sections.find((x) => x.kind === 'failed');
    if (section?.kind !== 'failed') throw new Error('the engine keeps the failed file');
    expect(files.textContent).toContain('scan.pdf');
    expect(files.textContent).toContain(section.rows[0].line);
  });
});

describe('US-12 AC9: each reason once on the review and the done screen (the engine\'s one rule, PR 1974)', () => {
  const files: Open['files'] = [
    labRead('f0', { values: [core({})] }, 'good.pdf'),
    { ...labRead('f1', { values: [core({})] }, 'long-report.pdf'), pages: { count: 40, truncated: true } },
    { ...labRead('f2', {}, 'stopped.pdf'), pages: null, status: { s: 'stopped' } },
    { ...labRead('f3', {}, 'held.pdf'), pages: null, status: { s: 'known', as: 'document', archiveOnly: false } },
    { ...labRead('f4', {}, 'big.pdf'), hash: null, pages: null, status: { s: 'refused', verdict: 'tooLarge' } },
  ];
  const reasons = [FILE_NOTICE_TEXT.truncated, UPLOAD_TEXT.stoppedLine, UPLOAD_TEXT.statusKnown, UPLOAD_TEXT.statusRefused('tooLarge')];
  const times = (text: string) => document.body.textContent!.split(text).length - 1;
  for (const screenName of ['review', 'done'] as const) {
    it(`on the ${screenName} screen`, () => {
      mount(screenName === 'review' ? open(files) : done(open(files)));
      for (const reason of reasons) expect(times(reason), reason).toBe(1);
    });
  }
});

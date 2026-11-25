// @vitest-environment jsdom
// What a screen reader calls each value and day control on the web upload list (US-13 AC28, AC10; Brad's option 1 of
// 2026-11-23): the engine's composition, built only from references to text the list shows (US-09 AC7l), read from the
// accessibility tree. The name algorithm joins references with a space, so a comma is read after one (" ,"). Synthetic values only.
import { cleanup, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, NOW } from '@roadmap/health-core/import-review.test-helpers';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { openAll } from '../testing/upload-list-kit';
import { UploadListHost, type ListHost } from '../testing/upload-list-host';
import { controlAt } from './UploadList';

afterEach(cleanup);

type Open = Extract<UploadState, { phase: 'open' }>;
const labRead = (id: string, name: string, over: Partial<UnifiedExtractionResult>): Open['files'][number] => ({
  id, name, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { classification: 'lab_report', reportDate: DAY, values: [], additionalValues: [], unrecognized: [], document: null, ...over }, choices: NO_CHOICES },
});
const open = (files: Open['files']): Open => ({ phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: NOW });
function mount(s: UploadState) {
  const host = createRef<ListHost>() as { current: ListHost | null };
  render(<UploadListHost initial={s} record={EMPTY} now={NOW} host={host} />);
  openAll();
  return host.current!;
}
const row = (key: string) => document.querySelector<HTMLLIElement>(`li[data-key="${key}"]`)!;
/** The words a screen reader says: the engine's name, each comma after a space. */
const spoken = (name: string) => name.replace(/, /g, ' , ');

describe('US-13 AC28: each value and day control is named from text on screen', () => {
  it('a value: "<test> value from <file>, <day>", and ", another reading" for a second reading there; input and tick alike', () => {
    const host = mount(open([labRead('f0', 'report.pdf', { values: [core({}), core({ valueSI: 3.4, displayValue: 3.4 })] })]));
    const [first, second] = host.see().list.rows;
    expect(first.name).toBe('LDL Cholesterol value from report.pdf, 1 Nov 2026');
    expect(second.name).toBe('LDL Cholesterol value from report.pdf, 1 Nov 2026, another reading');
    for (const r of [first, second]) {
      expect(within(row(r.key)).getByRole('textbox', { name: spoken(r.name) })).toBeTruthy();
      expect(within(row(r.key)).getByRole('checkbox', { name: spoken(r.name) })).toBeTruthy();
    }
  });

  it('a value with no day yet: test and file alone', () => {
    const host = mount(open([labRead('f0', 'undated.pdf', { reportDate: null, values: [core({})] })]));
    const [r] = host.see().list.rows;
    expect(r.name).toBe('LDL Cholesterol value from undated.pdf');
    expect(within(row(r.key)).getByRole('textbox', { name: spoken(r.name) })).toBeTruthy();
  });

  it('a day control: its label, the previous column\'s printed day, then the file\'s name', () => {
    const host = mount(open([labRead('f0', 'report.pdf', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', recordedAt: '2026-09-15' })] })]));
    const days = host.see().list.days;
    expect(days.map((d) => d.name)).toEqual([`${days[0].label}, report.pdf`, `${days[1].label}, 15 Sep 2026, report.pdf`]);
    for (const d of days) {
      expect(screen.getByRole('button', { name: spoken(d.name) })).toBe(controlAt(document, d.key));
    }
  });

  it('no attribute holds record text: names come by reference alone (US-09 AC7l)', () => {
    mount(open([labRead('f0', 'Jane Smith labs.pdf', { values: [core({}), core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', recordedAt: '2026-09-15' })] })]));
    for (const el of document.querySelectorAll('.upload-list *')) {
      for (const attr of el.getAttributeNames()) expect(el.getAttribute(attr), `${el.tagName} ${attr}`).not.toMatch(/Jane|LDL|HbA1c|Sep 2026|Nov 2026/);
    }
  });
});

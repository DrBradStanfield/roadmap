// @vitest-environment jsdom
/**
 * US-09 AC7l: text from the person's record is shown as text, never copied into an attribute.
 * Each control keeps the name it had, in the same words, now taken from the text on screen.
 * Synthetic names only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { recordWith } from '@roadmap/health-core/import-review.test-helpers';
import { recordTextInAttributes } from '../testing/no-record-text-in-attributes';

vi.mock('chart.js', () => {
  class Chart { static register() {} destroy() {} update() {} }
  return { Chart, LineController: {}, LineElement: {}, PointElement: {}, LinearScale: {}, TimeScale: {}, Tooltip: {}, Filler: {} };
});
vi.mock('chartjs-plugin-annotation', () => ({ default: {} }));
vi.mock('chartjs-adapter-date-fns', () => ({}));

import { TimeSeriesChart } from './HistoryPanel';
import { ChatThreadList } from './ChatThreadList';
import { RowSuggestions } from './PlanCards';
import { recordedChoice } from './form-kit';
import { labRead, letterRead, mount, open, openAll } from '../testing/upload-list-kit';
import type { Suggestion } from '@roadmap/health-core/types';

const TEST = 'Quillmarrow Index';
const CHAT = 'Brindlewick question';
const FILE = 'Tansyloft scan';

afterEach(cleanup);

describe('US-09 AC7l: the helper exempts only a form field\'s own value', () => {
  it('a text-like field and a textarea are exempt; an option, a checkbox and a radio are not', () => {
    const { container } = render(<form>
      <input defaultValue={TEST}/><input type="number" defaultValue="613"/><input type="email" defaultValue={`${TEST}@example.org`}/>
      <input type="date" defaultValue="2025-02-17"/><input type="search" defaultValue={TEST}/><input type="tel" defaultValue={TEST}/>
      <input type="text" defaultValue={TEST}/><textarea defaultValue={TEST}/>
      <select defaultValue={TEST}><option value={TEST}>{TEST}</option></select>
      <input type="checkbox" value={TEST}/><input type="radio" value={TEST}/>
    </form>);
    // Names and values only: a date is no sentinel, since a day alone names no condition or result (AC7l).
    expect(recordTextInAttributes(container, [TEST, '613'])).toEqual([
      `option[value]="${TEST}"`, `input[value]="${TEST}"`, `input[value]="${TEST}"`,
    ]);
  });

  it('a value as shown matches as a whole number only', () => {
    const { container } = render(<div><span data-a="2.46131"/><span data-b="16.13"/><span data-c="Lp(a): 613 nmol/L"/></div>);
    expect(recordTextInAttributes(container, ['613', '6.1'])).toEqual(['span[data-c]="Lp(a): 613 nmol/L"']);
  });
});

describe('US-09 AC7l: a medicine select holding an answer off its list', () => {
  const listed = [{ value: 'atorvastatin', label: 'Atorvastatin' }];

  it('shows "Other (recorded)", the answer in no attribute; picking it writes nothing, a listed one writes', () => {
    const pick = vi.fn();
    const { container } = render(<select aria-label="Statin" {...recordedChoice(listed, 'Plumquist', pick)}/>);
    const select = screen.getByRole('combobox', { name: 'Statin' }) as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe('Other (recorded)');
    expect(recordTextInAttributes(container, ['Plumquist'])).toEqual([]);
    fireEvent.change(select, { target: { value: select.selectedOptions[0].value } });
    expect(pick).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'atorvastatin' } });
    expect(pick).toHaveBeenCalledWith('atorvastatin');
  });

  it('a listed answer keeps its own key', () => {
    render(<select aria-label="Statin" {...recordedChoice(listed, 'atorvastatin', () => {})}/>);
    expect((screen.getByRole('combobox', { name: 'Statin' }) as HTMLSelectElement).value).toBe('atorvastatin');
  });
});

describe('US-09 AC7l: a plan suggestion on a row', () => {
  // A suggestion's title can carry the person's own value (an Lp(a) result, a protein target).
  const s: Suggestion = { id: 's1', category: 'bloodwork', priority: 'attention', title: 'Elevated Lp(a): 613 nmol/L', description: 'Ask about 613.' };
  const none = { highlighted: new Set<string>(), fadingOut: new Set<string>() };

  it('its info button is named "About:" and the title, the title in no attribute', () => {
    const { container } = render(<RowSuggestions suggestions={[s]} highlights={none}/>);
    expect(screen.getByRole('button', { name: `About: ${s.title}` })).toBeTruthy();
    expect(recordTextInAttributes(container, ['613'])).toEqual([]);
  });

  it('a screening row shows the description, and its button still says the title', () => {
    const { container } = render(<RowSuggestions suggestions={[s]} highlights={none} describes/>);
    expect(screen.getByRole('button', { name: `About: ${s.title}` })).toBeTruthy();
    expect(recordTextInAttributes(container, ['613'])).toEqual([]);
  });
});

describe('US-09 AC7l: a chart of a test the catalogue does not know', () => {
  it('names the chart and its events list in the same words, with the name in no attribute', () => {
    const { container } = render(
      <TimeSeriesChart title={TEST} showTitle={false} data={[{ x: Date.UTC(2026, 9, 1), y: 4 }]} unit="U/L" color="#000"
        annotations={[{ id: 'a1', date: Date.UTC(2026, 8, 1), label: 'Recorded start: atorvastatin' }]}/>,
    );
    expect(screen.getByRole('img', { name: `${TEST} chart` })).toBeTruthy();
    expect(screen.getByRole('list', { name: `${TEST} recorded medication changes` })).toBeTruthy();
    expect(recordTextInAttributes(container, [TEST])).toEqual([]);
  });

  it('with its own heading, the events list is still named after it', () => {
    const { container } = render(
      <TimeSeriesChart title={TEST} data={[{ x: Date.UTC(2026, 9, 1), y: 4 }]} unit="U/L" color="#000"
        annotations={[{ id: 'a1', date: Date.UTC(2026, 8, 1), label: 'Recorded start: atorvastatin' }]}/>,
    );
    expect(screen.getByRole('heading', { name: TEST })).toBeTruthy();
    expect(screen.getByRole('list', { name: `${TEST} recorded medication changes` })).toBeTruthy();
    expect(recordTextInAttributes(container, [TEST])).toEqual([]);
  });
});

describe('US-09 AC7l: the chat History list', () => {
  it('names each Delete after its thread, with the title in no attribute', () => {
    const { container } = render(
      <ChatThreadList conversations={[{ id: 'c1', title: CHAT, updatedAt: 'x', createdAt: 'x' }, { id: 'c2', title: '', updatedAt: 'x', createdAt: 'x' }]}
        activeConversationId={null} className="t" onSelect={() => {}} onNew={() => {}} onDelete={() => {}}/>,
    );
    expect(screen.getByRole('button', { name: `Delete conversation ${CHAT}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete conversation Untitled' })).toBeTruthy();
    expect(recordTextInAttributes(container, [CHAT])).toEqual([]);
  });
});

describe('US-09 AC7l: the upload list', () => {
  it('names a test the catalogue does not know by its label, with the name and file name in no attribute', () => {
    mount(open([
      labRead('f0', { additionalValues: [{ name: TEST, value: 4.2, unit: 'U/L' }] }, `${FILE}.pdf`),
      letterRead('f1', 'Letter', `${FILE} letter.pdf`),
    ]));
    openAll();
    expect(screen.getByRole('checkbox', { name: TEST })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: TEST })).toBeTruthy();
    expect(document.body.textContent).toContain(FILE);
    expect(recordTextInAttributes(document.body, [TEST, FILE])).toEqual([]);
  });

  it('names Replace in the engine\'s words, with the test name in no attribute', () => {
    const host = mount(open([labRead('f0', { additionalValues: [{ name: TEST, value: 4.2, unit: 'U/L' }] })]),
      recordWith([{ kind: 'lab', metricName: TEST, value: 3.1, unit: 'U/L' }]));
    openAll();
    const r = host.see().list.rows[0];
    expect(r.replaceLabel).toContain(TEST);
    expect(screen.getByRole('checkbox', { name: r.replaceLabel! })).toBeTruthy();
    expect(recordTextInAttributes(document.body, [TEST])).toEqual([]);
  });
});

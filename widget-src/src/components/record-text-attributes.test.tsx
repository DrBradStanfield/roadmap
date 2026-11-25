// @vitest-environment jsdom
/**
 * US-09 AC7l: text from the person's record is shown as text, never copied into an attribute.
 * Each control keeps the name it had, in the same words, now taken from the text on screen.
 * Synthetic names only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
import { labRead, letterRead, mount, open, openAll } from '../testing/upload-list-kit';

const TEST = 'Quillmarrow Index';
const CHAT = 'Brindlewick question';
const FILE = 'Tansyloft scan';

afterEach(cleanup);

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

// @vitest-environment jsdom
/**
 * US-62 AC8a (Brad 2026-11-09): a row's trend box is as tall as its name block and as wide as
 * its CSS column (56, or 44 below 390px), and the line is drawn over the block's ink, from the
 * title's cap height to the date line's baseline, capped at 0.8 x its width and centred. It
 * follows the block when the block changes or the web fonts load, and an unchanged measurement
 * renders nothing.
 * jsdom lays nothing out, so the block, the column, the text's line boxes and the font's
 * metrics are given through stubs.
 */
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MetricRows, trendBand, type RowModel } from './MyDataRows';

/** The font's metrics, as the canvas measures "H". */
const DESCENT = 4, CAP = 11;
/** The name block (its top at 100), the trend's CSS column, and where the title's cap height
 *  and the date line's baseline fall, from the block's top. */
let layout = { height: 36, column: 56, capTop: 5, baseline: 32 };
const observers: Array<() => void> = [];
const ownLines = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

const rect = (top: number, height: number, width = 100) =>
  ({ x: 0, y: top, top, left: 0, width, height, right: width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  layout = { height: 36, column: 56, capTop: 5, baseline: 32 };
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private fire: () => void) { observers.push(() => this.fire()); }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('md-row-name')) return rect(100, layout.height);
    if (this.classList.contains('md-row-trend')) return rect(100, layout.height, layout.column);
    return rect(0, 0);
  });
  // A text's one line box ends a descent below its baseline.
  Range.prototype.getClientRects = function (this: Range) {
    const text = this.startContainer as Element;
    const baseline = text.classList.contains('md-row-label') ? layout.capTop + CAP : layout.baseline;
    return [rect(100 + baseline + DESCENT - 20, 20)] as unknown as DOMRectList;
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    { font: '', measureText: () => ({ fontBoundingBoxDescent: DESCENT, actualBoundingBoxAscent: CAP }) } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (ownLines) Object.defineProperty(Range.prototype, 'getClientRects', ownLines);
  else delete (Range.prototype as Partial<Range>).getClientRects;
});

const row: RowModel = {
  subject: { kind: 'core', metric: 'waist' }, label: 'Waist-to-height', target: 'Normal <0.5', day: '2025-02-01',
  latest: '0.53', previous: '0.50', unit: '', trend: [0.4, 0.6, 0.5], tint: '#5b5bd6', status: 'warn', graded: 'waist',
};

/** The drawn line's top and bottom in the svg, its group's shift included. */
function drawn(container: HTMLElement) {
  const svg = container.querySelector('svg.md-row-trend')!;
  const shift = Number(/translate\(0,([\d.]+)\)/.exec(svg.querySelector('g')!.getAttribute('transform')!)![1]);
  const ys = [...svg.querySelector('path[fill="none"]')!.getAttribute('d')!.matchAll(/,([\d.]+)/g)].map(m => Number(m[1]) + shift);
  return { svg, top: Math.min(...ys), bottom: Math.max(...ys) };
}

const remeasure = () => act(() => observers.forEach(fire => fire()));

describe('US-62 AC8a: the trend is drawn over the name block\'s ink', () => {
  it('keeps the box the block\'s height and its column\'s width, and draws from the cap height to the baseline', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    const { svg, top, bottom } = drawn(container);
    expect(svg.getAttribute('height')).toBe('36');
    expect(svg.getAttribute('width')).toBe('56');
    // The line's highest and lowest points sit 2px inside the band, so the 2px end dot never overshoots.
    expect(top).toBeCloseTo(5 + 2, 1);
    expect(bottom).toBeCloseTo(32 - 2, 1);
  });

  it('takes the 44px column below 390px, and caps its band by that width', () => {
    layout = { height: 70, column: 44, capTop: 5, baseline: 67 };
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    const { svg, top, bottom } = drawn(container);
    expect(svg.getAttribute('width')).toBe('44');
    expect(bottom - top).toBeCloseTo(0.8 * 44 - 4, 1); // capped at 35.2, the 2px padding inside it
    expect((top + bottom) / 2).toBeCloseTo(36, 1); // centred on the ink
  });

  it('follows the block when the title or date line wraps', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    layout = { height: 52, column: 56, capTop: 5, baseline: 48 };
    remeasure();
    const { svg, top, bottom } = drawn(container);
    expect(svg.getAttribute('height')).toBe('52');
    expect(top).toBeCloseTo(7, 1);
    expect(bottom).toBeCloseTo(46, 1);
  });

  it('fills its box while the ink is not yet a band (a measurement still settling)', () => {
    layout = { height: 36, column: 56, capTop: 30, baseline: 10 };
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    const { top, bottom } = drawn(container);
    expect(top).toBeCloseTo(2, 1);
    expect(bottom).toBeCloseTo(34, 1);
    expect(trendBand(30, 10)).toBeUndefined();
    expect(trendBand(5, 9)).toBeUndefined(); // no room inside the padding
    expect(trendBand(5, Number.NaN)).toBeUndefined();
  });

  it('caps a tall band at 0.8 x the width, centred on the ink', () => {
    const capped = trendBand(5, 85, 56)!;
    expect(capped.height).toBeCloseTo(44.8, 9);
    expect(capped.top + capped.height / 2).toBeCloseTo(45, 9);
    expect(trendBand(5, 32, 56)).toEqual({ top: 5, height: 27 });
  });

  it('renders nothing again for an unchanged measurement', () => {
    const commits = vi.fn();
    render(<Profiler id="rows" onRender={commits}><MetricRows rows={[row]} onOpen={() => {}}/></Profiler>);
    const settled = commits.mock.calls.length;
    remeasure();
    expect(commits).toHaveBeenCalledTimes(settled);
    layout = { ...layout, height: 40 };
    remeasure();
    expect(commits).toHaveBeenCalledTimes(settled + 1);
  });

  it('re-measures once the web fonts have loaded, as a swap moves the ink but not the block (#1002 R2)', async () => {
    let loaded!: () => void;
    const ready = new Promise<void>(resolve => { loaded = resolve; });
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
    try {
      const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
      expect(drawn(container).top).toBeCloseTo(7, 1);
      // The web font swaps in: same block height, so no resize fires, but the ink moves.
      layout = { ...layout, capTop: 9, baseline: 30 };
      await act(async () => { loaded(); await ready; });
      const { top, bottom } = drawn(container);
      expect(top).toBeCloseTo(9 + 2, 1);
      expect(bottom).toBeCloseTo(30 - 2, 1);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('measures nothing once the row is gone, when the fonts load after it (#1002 R2)', async () => {
    let loaded!: () => void;
    const ready = new Promise<void>(resolve => { loaded = resolve; });
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
    try {
      const { unmount } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
      unmount();
      const boxes = vi.mocked(Element.prototype.getBoundingClientRect);
      boxes.mockClear();
      await act(async () => { loaded(); await ready; });
      expect(boxes).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('draws where the browser has no document.fonts', () => {
    expect('fonts' in document).toBe(false); // jsdom: no FontFaceSet
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    expect(drawn(container).top).toBeCloseTo(7, 1);
  });

  it('halves the fill under the line', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    expect(container.querySelector('linearGradient stop')!.getAttribute('stop-opacity')).toBe('0.125');
  });

  it('sizes the column in CSS, 56 and 44 below 390px, with no height to override the drawn one', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const rule = /\n\.md-row-trend\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).not.toMatch(/(^|[\s;])height\s*:/);
    expect(rule).toMatch(/width:\s*56px/);
    expect(css).toMatch(/\.md-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 56px 104px/);
    const narrow = /@media \(max-width: 389px\) \{([\s\S]*?)\n\}/.exec(css)![1];
    expect(narrow).toMatch(/\.md-row\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) 44px 104px;/);
    expect(narrow).toMatch(/\.md-row-trend\s*\{\s*width:\s*44px;/);
  });
});

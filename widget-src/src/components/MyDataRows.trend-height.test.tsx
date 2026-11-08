// @vitest-environment jsdom
/**
 * US-62 AC8a (Brad 2026-11-09): a row's trend box is as tall as its name block, and the
 * line is drawn over the block's ink, from the title's cap height to the date line's
 * baseline, capped at 0.8 x its width and centred; it follows the block when the block
 * changes (a wrapped title or date line). jsdom lays nothing out, so the name block and
 * its two ink marks are given through a stubbed ResizeObserver and getBoundingClientRect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MetricRows, trendBand, type RowModel } from './MyDataRows';

/** The name block's box, and where its cap-height and baseline marks sit, from its top. */
let layout = { height: 36, capTop: 5, baseline: 32 };
const observers: Array<() => void> = [];

beforeEach(() => {
  layout = { height: 36, capTop: 5, baseline: 32 };
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private fire: () => void) { observers.push(() => this.fire()); }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const at = (top: number, height: number) => ({ x: 0, y: top, top, left: 0, width: 0, height, right: 0, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
    if (this.classList.contains('md-row-name')) return at(100, layout.height);
    if (this.classList.contains('md-row-ink')) {
      const cap = 10; // the mark runs from the cap height down to the baseline
      return this.parentElement!.classList.contains('md-row-label') ? at(100 + layout.capTop, cap) : at(100 + layout.baseline - cap, cap);
    }
    return at(0, 0);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

describe('US-62 AC8a: the trend is drawn over the name block\'s ink', () => {
  it('keeps the box the block\'s height, 56 wide, and draws from the cap height to the baseline', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    const { svg, top, bottom } = drawn(container);
    expect(svg.getAttribute('height')).toBe('36');
    expect(svg.getAttribute('width')).toBe('56');
    // The line's highest and lowest points sit 2px inside the band, so the 2px end dot never overshoots.
    expect(top).toBeCloseTo(5 + 2, 1);
    expect(bottom).toBeCloseTo(32 - 2, 1);
  });

  it('follows the block when the title or date line wraps', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    layout = { height: 52, capTop: 5, baseline: 48 };
    act(() => observers.forEach(fire => fire()));
    const { svg, top, bottom } = drawn(container);
    expect(svg.getAttribute('height')).toBe('52');
    expect(top).toBeCloseTo(7, 1);
    expect(bottom).toBeCloseTo(46, 1);
  });

  it('caps a tall band at 0.8 x the width, centred on the ink', () => {
    const capped = trendBand(5, 85, 56);
    expect(capped.height).toBeCloseTo(44.8, 9);
    expect(capped.top + capped.height / 2).toBeCloseTo(45, 9); // the ink's middle
    expect(trendBand(5, 32, 56)).toEqual({ top: 5, height: 27 });
  });

  it('halves the fill under the line', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    expect(container.querySelector('linearGradient stop')!.getAttribute('stop-opacity')).toBe('0.125');
  });

  it('sets no fixed height in CSS, so the drawn height is the one used', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const rule = /\.md-row-trend\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).not.toMatch(/(^|[\s;])height\s*:/);
    expect(rule).toMatch(/width:\s*56px/);
  });
});

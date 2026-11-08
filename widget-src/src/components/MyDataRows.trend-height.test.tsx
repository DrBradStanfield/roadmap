// @vitest-environment jsdom
/**
 * US-62 AC8a (Brad 2026-11-09): a row's trend is as tall as its name block, its top
 * on the title's top and its bottom on the "target · date" line's bottom, and it
 * follows the block when the block's height changes (a wrapped title or date line).
 * jsdom lays nothing out, so the name block's height is given through a stubbed
 * ResizeObserver and getBoundingClientRect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MetricRows, type RowModel } from './MyDataRows';

let nameHeight = 36;
const observers: Array<() => void> = [];

beforeEach(() => {
  nameHeight = 36;
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private fire: () => void) { observers.push(() => this.fire()); }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('md-row-name') ? nameHeight : 0;
    return { x: 0, y: 0, top: 0, left: 0, width: 200, height, right: 200, bottom: height, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const row: RowModel = {
  subject: { kind: 'core', metric: 'waist' }, label: 'Waist-to-height', target: 'Normal <0.5', day: '2025-02-01',
  latest: '0.53', previous: '0.50', unit: '', trend: [0.5, 0.52, 0.53], tint: '#5b5bd6', status: 'warn', graded: 'waist',
};

describe('US-62 AC8a: the trend spans the name block', () => {
  it('draws the trend as tall as the title and its date line', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    const trend = container.querySelector('svg.md-row-trend')!;
    expect(trend.getAttribute('height')).toBe('36');
    expect(trend.getAttribute('width')).toBe('44');
  });

  it('grows with the block when the title or date line wraps', () => {
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    nameHeight = 52;
    act(() => observers.forEach(fire => fire()));
    expect(container.querySelector('svg.md-row-trend')!.getAttribute('height')).toBe('52');
  });

  it('sets no fixed height in CSS, so the drawn height is the one used', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const rule = /\.md-row-trend\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).not.toMatch(/(^|[\s;])height\s*:/);
  });
});

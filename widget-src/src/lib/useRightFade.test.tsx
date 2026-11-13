// @vitest-environment jsdom
/**
 * D2 (after H79, US-62): the vitals grid hides its scrollbar, so a phone fades the grid's
 * right edge while columns lie past it. The hook marks the scroller; styles.css draws the fade.
 */
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRightFade } from './useScrollToRightOnMount';
import { useRef } from 'react';
import { cascaded, focusOn, nest } from '../testing/css-cascade';

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function Grid() {
  const ref = useRightFade(useRef<HTMLDivElement>(null));
  return <div ref={ref} className="bt-timeline-scroll" data-testid="scroller" />;
}

/** jsdom lays nothing out: give the scroller a 300px view of 500px of columns. */
const sized = (el: HTMLElement, scrollLeft: number) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 500 });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 });
  el.scrollLeft = scrollLeft;
  fireEvent.scroll(el);
};

describe('D2: the vitals grid fades its right edge while more lies there', () => {
  it('marks the scroller while scrollLeft is short of the end, and clears it at the end', () => {
    const { getByTestId } = render(<Grid />);
    const el = getByTestId('scroller');
    sized(el, 120);
    expect(el.classList.contains('bt-more-right')).toBe(true);
    sized(el, 200); // the end: 500 - 300
    expect(el.classList.contains('bt-more-right')).toBe(false);
    sized(el, 0);
    expect(el.classList.contains('bt-more-right')).toBe(true);
  });

  it('never marks a grid that fits, so nothing fades with nothing to the right', () => {
    const { getByTestId } = render(<Grid />);
    const el = getByTestId('scroller');
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 });
    fireEvent.scroll(el);
    expect(el.classList.contains('bt-more-right')).toBe(false);
  });

  it('styles.css fades the marked scroller on a phone only, and not while a cell is focused', () => {
    const vitals = nest('bt-timeline bt-vitals-card', 'bt-timeline-scroll bt-more-right');
    expect(cascaded(vitals, 'mask-image', 390)).toMatch(/linear-gradient\(to right/);
    expect(cascaded(vitals, 'mask-image', 375)).toMatch(/linear-gradient\(to right/);
    expect(cascaded(vitals, 'mask-image', 1280)).toBeUndefined(); // desktop keeps a sticky Trend
    expect(cascaded(nest('bt-timeline bt-vitals-card', 'bt-timeline-scroll'), 'mask-image', 390)).toBeUndefined();
    const typing = vitals.appendChild(document.createElement('input'));
    expect(cascaded(vitals, 'mask-image', { width: 390, states: focusOn(typing) })).toBeUndefined();
  });
});

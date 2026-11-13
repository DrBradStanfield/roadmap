// @vitest-environment jsdom
/**
 * US-20 AC8: on a phone every value box in the vitals matrix is at least 16px, so
 * iOS Safari does not zoom the page when one is tapped. The blood pressure
 * pair is the case that broke: its 13px rule has two classes and beat the
 * one-class phone guard. jsdom ignores media queries and computes no cascade,
 * so this resolves `font-size` from styles.css itself (testing/css-cascade.ts): the rules whose media
 * apply at the given width and whose selector matches the rendered input,
 * ranked by !important, specificity, then source order. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StartingInfoVitals } from './StartingInfoVitals';
import { cascaded, mediaApplies, parseRules, specificity } from '../testing/css-cascade';

afterEach(() => { cleanup(); localStorage.clear(); });

/** The cascaded `font-size` of `el` at a screen `width`, in px. */
function fontSizeAt(el: Element, width: number): number {
  const value = cascaded(el, 'font-size', width);
  if (value === undefined) throw new Error(`no font-size rule matches ${el.outerHTML}`);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!px) throw new Error(`font-size is not in px: ${value}`);
  return Number(px[1]);
}

function renderVitals() {
  return render(
    <StartingInfoVitals vitalsHistory={[]} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={3}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
}

const PHONE = 390;
const DESKTOP = 1280;

describe('US-20 AC8: on a phone the vitals inputs are 16px, so iOS does not zoom on a tap', () => {
  it('both blood pressure inputs are 16px on a phone', () => {
    const view = renderVitals();
    for (const name of ['Systolic blood pressure', 'Diastolic blood pressure']) {
      const input = view.getByRole('textbox', { name });
      expect(input.closest('.bt-vitals-bp-inputs')).not.toBeNull();
      expect(fontSizeAt(input, PHONE)).toBe(16);
    }
  });

  it('every value box in the vitals matrix is at least 16px on a phone', () => {
    const view = renderVitals();
    const inputs = [...view.container.querySelectorAll('input.bt-input')];
    expect(inputs.length).toBeGreaterThanOrEqual(4); // weight, waist, systolic, diastolic
    expect(inputs.map(input => fontSizeAt(input, PHONE)).filter(px => px < 16)).toEqual([]);
  });

  it('desktop is unchanged: the pair stays 13px, the other inputs 14px', () => {
    const view = renderVitals();
    const bp = [...view.container.querySelectorAll('.bt-vitals-bp-inputs input.bt-input')];
    expect(bp).toHaveLength(2);
    for (const input of bp) expect(fontSizeAt(input, DESKTOP)).toBe(13);
    const others = [...view.container.querySelectorAll('input.bt-input')].filter(input => !bp.includes(input));
    expect(others.length).toBeGreaterThan(0);
    for (const input of others) expect(fontSizeAt(input, DESKTOP)).toBe(14);
  });

  it('the resolver: specificity, media at each width, and a lone .bt-input on a phone', () => {
    const input = document.body.appendChild(document.createElement('input'));
    input.className = 'bt-input';
    expect(specificity('.bt-vitals-bp-inputs .bt-input')).toEqual([0, 2, 0]);
    expect(specificity('.health-tool .health-field input')).toEqual([0, 2, 1]);
    expect(specificity('.bt-cell-value:has(> .bt-vitals-bp-inputs)')).toEqual([0, 2, 0]);
    expect(mediaApplies('(max-width: 768px)', PHONE)).toBe(true);
    expect(mediaApplies('(max-width: 768px)', DESKTOP)).toBe(false);
    expect(mediaApplies('(hover: none) and (pointer: coarse)', PHONE)).toBe(true);
    expect(mediaApplies('print', DESKTOP)).toBe(false); // print media only on the printed page
    expect(mediaApplies('print', DESKTOP, false, true)).toBe(true);
    expect(mediaApplies('screen', DESKTOP, false, true)).toBe(false);
    // A list joined after another comes later in source order: an equal rival wins.
    expect(cascaded(input, 'color', PHONE, [...parseRules('.bt-input { color: red }'), ...parseRules('.bt-input { color: green }')])).toBe('green');
    expect(fontSizeAt(input, PHONE)).toBe(16); // the phone guard
    expect(fontSizeAt(input, DESKTOP)).toBe(14);
    // A state is a whole pseudo-class on the element that holds it: :focus is not :focus-within,
    // and a parent's :focus-within does not match a rule that puts it on the child.
    const rules = parseRules('.bt-input:focus-within { color: red } .x:focus-within .bt-input { color: green }');
    expect(cascaded(input, 'color', { width: PHONE, states: [[input, [':focus']]] }, rules)).toBeUndefined();
    expect(cascaded(input, 'color', { width: PHONE, states: [[input, [':focus-within']]] }, rules)).toBe('red');
    const parent = document.body.appendChild(document.createElement('div'));
    parent.className = 'x';
    parent.appendChild(input);
    expect(cascaded(input, 'color', { width: PHONE, states: [[parent, [':focus-within']]] }, rules)).toBe('green');
    // A sibling shorthand the resolver does not model fails loudly.
    expect(() => cascaded(input, 'background', PHONE, parseRules('.bt-input { background-color: red }'))).toThrow(/does not model background-color/);
    expect(() => cascaded(input, 'font-size', PHONE, parseRules('.bt-input { font: inherit }'))).toThrow(/does not model font beside font-size/);
    parent.remove();
  });
});

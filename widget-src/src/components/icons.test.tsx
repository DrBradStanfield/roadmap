// @vitest-environment jsdom
/**
 * US-62 AC30a: each My health section symbol takes its iPhone tint, at 3:1 or more
 * on white and on the page's grey (WCAG 1.4.11's non-text ratio).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SectionIcon, type SectionKey } from './icons';

function luminance([r, g, b]: number[]): number {
  const [lr, lg, lb] = [r, g, b].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const colourOf = (section: SectionKey) => {
  const { container } = render(<SectionIcon section={section}/>);
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec((container.firstChild as HTMLElement).style.color);
  expect(m, section).not.toBeNull();
  return m!.slice(1).map(Number);
};

// The iPhone's hue per topic (TopicPlan.swift); orange, green, cyan and gray as Apple's increased-contrast variants.
const IPHONE: Array<[SectionKey, number[]]> = [
  ['weight', [175, 82, 222]], ['sleep', [0, 113, 164]], ['fitness', [201, 52, 0]], ['bloodPressure', [255, 59, 48]],
  ['cholesterol', [255, 59, 48]], ['screening', [88, 86, 214]], ['skin', [201, 52, 0]], ['bloodTests', [0, 122, 255]],
  ['supplements', [36, 138, 61]], ['other', [108, 108, 112]], ['aboutYou', [201, 52, 0]],
];

describe('US-62 AC30a: the section symbols\' colours', () => {
  it.each(IPHONE)('%s takes its iPhone tint, at 3:1 or more on white and grey', (section, rgb) => {
    const colour = colourOf(section);
    expect(colour).toEqual(rgb);
    expect(ratio(colour, [255, 255, 255])).toBeGreaterThanOrEqual(3);
    expect(ratio(colour, [242, 242, 247])).toBeGreaterThanOrEqual(3);
  });
});

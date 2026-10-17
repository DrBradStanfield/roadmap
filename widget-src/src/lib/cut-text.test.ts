/** US-12 AC12: text sent as a page is cut at a boundary, never mid-value. */
import { describe, it, expect } from 'vitest';
import { cutText } from './cut-text';

describe('US-12 AC12: cutText', () => {
  it('leaves text within the cap as it is', () => {
    expect(cutText('LDL 2.9', 7)).toBe('LDL 2.9');
  });
  it('cuts at the last line end within the cap', () => {
    expect(cutText('LDL 2.9\nHDL 1.4\nTG 1.1', 18)).toBe('LDL 2.9\nHDL 1.4');
  });
  it('cuts a line with no line end at its last space', () => {
    expect(cutText('Ferritin 85 ug/L', 14)).toBe('Ferritin 85');
  });
  it('with no space, cuts at the cap but backs out of a number', () => {
    expect(cutText('abc123.45', 7)).toBe('abc');
    expect(cutText('abcdefgh', 5)).toBe('abcde');
  });
  it('never splits a surrogate pair', () => {
    expect(cutText('ab\u{1F600}cd', 3)).toBe('ab');
  });
});

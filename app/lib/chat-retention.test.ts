import { describe, expect, it } from 'vitest';
import { retentionOf } from './chat-retention';

// C1: one retention mode per surface (US-52 AC5, US-15 AC7/AC8).
describe('retentionOf', () => {
  const table: Array<[{ app: boolean; widget: boolean }, string]> = [
    [{ app: true, widget: false }, 'none'],
    [{ app: true, widget: true }, 'none'],
    [{ app: false, widget: true }, 'question-rows'],
    [{ app: false, widget: false }, 'transcript'],
  ];
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => expect(retentionOf(input)).toBe(expected));
  }
});

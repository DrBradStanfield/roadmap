import { describe, it, expect } from 'vitest';
import { productsBlockText } from './chat-products-block';

// US-15 AC29: the products block carries the writing style and the answer bank
// on every surface, under neutral headings.
describe('productsBlockText (US-15 AC29)', () => {
  it('puts products, then the writing style, then the answer bank, under fixed headings', () => {
    const text = productsBlockText({ products: 'P', writingStyle: 'W', answerBank: 'A' });
    expect(text).toBe(
      "## Dr Stanfield's Products\n\nP\n\n---\n\n## WRITING STYLE (applies to every answer)\n\nW\n\n---\n\n## ANSWER BANK (approved answers to customer questions)\n\nA",
    );
    expect(text).not.toContain("Brad's answers");
  });

  it('leaves out a missing file instead of sending an empty heading', () => {
    expect(productsBlockText({ products: 'P', writingStyle: '', answerBank: 'A' })).not.toContain('WRITING STYLE');
    expect(productsBlockText({ products: '', writingStyle: '', answerBank: '' })).toBe('');
  });
});

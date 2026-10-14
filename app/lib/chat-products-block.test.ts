import { describe, it, expect } from 'vitest';
import { productsBlockText } from './chat-products-block';

describe('productsBlockText', () => {
  it('puts products, then the writing style, then the answer bank, under fixed headings', () => {
    const text = productsBlockText({ products: 'P', writingStyle: 'W', answerBank: 'A' });
    expect(text).toBe(
      "## Dr Stanfield's Products\n\nP\n\n---\n\n## WRITING STYLE (applies to every answer)\n\nW\n\n---\n\n## ANSWER BANK (Brad's answers to questions customers have asked)\n\nA",
    );
  });

  it('leaves out a missing file instead of sending an empty heading', () => {
    expect(productsBlockText({ products: 'P', writingStyle: '', answerBank: 'A' })).not.toContain('WRITING STYLE');
    expect(productsBlockText({ products: '', writingStyle: '', answerBank: '' })).toBe('');
  });
});

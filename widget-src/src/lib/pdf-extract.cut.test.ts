/**
 * US-12 AC12: a PDF page's text past the server's text-page cap is cut at a
 * space and marked truncated, so one dense page never fails a whole batch.
 * pdf.js is faked: only getTextContent matters for a text page.
 */
import { describe, it, expect, vi } from 'vitest';
import { IMPORT_LIMITS } from '@roadmap/health-core/import-hints';

const pageText = vi.hoisted(() => ({ items: [] as Array<{ str: string }> }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({
    numPages: 1,
    getPage: async () => ({ getTextContent: async () => pageText, cleanup: () => {} }),
  }) }),
}));
const { extractFromPdf } = await import('./pdf-extract');

describe('US-12 AC12: extractFromPdf cuts a page past the text-page cap', () => {
  it('keeps a normal page whole', async () => {
    pageText.items = [{ str: 'Ferritin 85 ug/L (30-400)' }, { str: 'HbA1c 38 mmol/mol (20-41)' }];
    expect(await extractFromPdf(new File([], 'a.pdf'))).toEqual({ pages: [{ type: 'text', content: '[Page 1/1]\nFerritin 85 ug/L (30-400) HbA1c 38 mmol/mol (20-41)' }], truncated: false });
  });
  it('cuts a page past the cap at a space, within the cap, and marks it truncated', async () => {
    pageText.items = Array.from({ length: 8000 }, () => ({ str: 'Ferritin 85 ug/L' }));
    const { pages, truncated } = await extractFromPdf(new File([], 'dense.pdf'));
    expect(truncated).toBe(true);
    expect(pages[0].content.length).toBeLessThanOrEqual(IMPORT_LIMITS.websiteTextPageChars);
    const kept = pages[0].content.slice('[Page 1/1]\n'.length);
    expect(kept.length).toBeGreaterThan(IMPORT_LIMITS.websiteTextPageChars - 30);
    // A prefix of the page's text that ends where a word does.
    expect(pageText.items.map(i => i.str).join(' ').startsWith(kept + ' ')).toBe(true);
  });
});

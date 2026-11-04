// @vitest-environment jsdom
/**
 * US-12 AC22: a scanned PDF page is rendered at 1.5x, but never with a side
 * longer than 2,000 pixels, the cap the iPhone app already applies
 * (LabFileReader.jpegPage). A photo saved as a PDF on a Mac gets a page as large
 * as its pixels (a 12 MP photo at 72 dpi is a 4032 x 3024 pt page), which 1.5x
 * turned into a 27 MP canvas and a multi-megabyte image; a page 200 inches square
 * (14,400 pt, Acrobat's page-size limit) gave a canvas Chrome cannot encode,
 * sent as an empty image.
 *
 * pdf.js is faked (only the page box matters); the canvas is jsdom's, with
 * `getContext` and `toDataURL` stubbed to record the size it was given.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const box = vi.hoisted(() => ({ width: 612, height: 792 }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }), // no text layer: a scanned page
        getViewport: ({ scale }: { scale: number }) => ({ width: box.width * scale, height: box.height * scale }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: () => {},
      }),
    }),
    destroy: async () => {},
  }),
}));
const { extractFromPdf } = await import('./pdf-extract');

const encoded: Array<[number, number]> = [];
const proto = HTMLCanvasElement.prototype;
const original = { getContext: proto.getContext, toDataURL: proto.toDataURL };
beforeAll(() => {
  proto.getContext = (() => ({})) as unknown as typeof proto.getContext;
  proto.toDataURL = function (this: HTMLCanvasElement) {
    encoded.push([this.width, this.height]);
    return 'data:image/jpeg;base64,U3ludGhldGlj';
  };
});
afterAll(() => Object.assign(proto, original));
beforeEach(() => { encoded.length = 0; });

async function renderedSize(width: number, height: number): Promise<[number, number]> {
  Object.assign(box, { width, height });
  const { pages } = await extractFromPdf(new File([], 'scan.pdf', { type: 'application/pdf' }));
  expect(pages).toEqual([{ type: 'image', content: 'U3ludGhldGlj', mimeType: 'image/jpeg' }]);
  expect(encoded).toHaveLength(1);
  return encoded[0];
}

describe('US-12 AC22: a scanned PDF page is rendered no larger than 2,000 px on its long side', () => {
  it('a Letter page keeps 1.5x (918 x 1188)', async () => {
    expect(await renderedSize(612, 792)).toEqual([918, 1188]);
  });

  it('an A4 page keeps 1.5x (892 x 1263)', async () => {
    expect(await renderedSize(595, 842)).toEqual([892, 1263]);
  });

  it('a photo saved as a PDF at 72 dpi (4032 x 3024 pt) is drawn at 2000 x 1500, not 6048 x 4536', async () => {
    expect(await renderedSize(4032, 3024)).toEqual([2000, 1500]);
  });

  it("a page 200 inches square (14,400 pt, Acrobat's page-size limit) is drawn at 2000 x 2000, not 21600 x 21600", async () => {
    expect(await renderedSize(14400, 14400)).toEqual([2000, 2000]);
  });

  it('a tall page is capped by its height (612 x 14400 pt: 85 x 2000)', async () => {
    expect(await renderedSize(612, 14400)).toEqual([85, 2000]);
  });

  it('a page just over the cap at 1.5x (1400 pt wide: 2100 px) comes down to 2000', async () => {
    expect(await renderedSize(1400, 700)).toEqual([2000, 1000]);
  });
});

/**
 * US-14 AC6: a long document title is cut to fit the 80-character name, and the
 * cut never splits an emoji (or any character outside the Basic Multilingual
 * Plane) in two. Half of one is not a character: `encodeURIComponent` throws
 * on it, so on Google Drive the original was stored but "View original" could
 * never find it again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentRef, splitDocumentRef } from './document-path';
import { driveDownloadDocument } from './drive-rest';

const EMOJI = '\u{1F600}'; // two UTF-16 units
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** '2024-05-10 ' is 11 units and '.pdf' 4, so the name's base is cut at 76 units. */
function refFor(title: string): string {
  return buildDocumentRef({
    type: 'pathology_report',
    title,
    date: '2024-05-10',
    sourceFileName: 'report.pdf',
    existingRefs: [],
  });
}

describe('US-14 AC6: the 80-character cut keeps whole characters', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('drops an emoji the cut would split, rather than keeping half of it', () => {
    // 11 + 64 = 75: the emoji's first half is the 76th unit, the last one kept.
    const ref = refFor(`${'a'.repeat(64)}${EMOJI} tail`);
    expect(LONE_HALF.test(ref)).toBe(false);
    expect(() => encodeURIComponent(ref)).not.toThrow();
    expect(ref).toBe(`Lab results/2024-05-10 ${'a'.repeat(64)}.pdf`);
  });

  it('leaves no space at the end of the name when the dropped emoji followed one', () => {
    const ref = refFor(`${'a'.repeat(63)} ${EMOJI} tail`);
    expect(ref).toBe(`Lab results/2024-05-10 ${'a'.repeat(63)}.pdf`);
  });

  it('keeps an emoji that fits whole before the cut', () => {
    const ref = refFor(`${'a'.repeat(63)}${EMOJI} tail`);
    expect(ref).toBe(`Lab results/2024-05-10 ${'a'.repeat(63)}${EMOJI}.pdf`);
  });

  it('keeps an emoji in a title short enough not to be cut', () => {
    expect(refFor(`Lipid panel ${EMOJI}`)).toBe(`Lab results/2024-05-10 Lipid panel ${EMOJI}.pdf`);
  });

  it('a Drive original filed under such a title can be opened again', async () => {
    const { name } = splitDocumentRef(refFor(`${'a'.repeat(64)}${EMOJI} tail`));
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.includes('alt=media')
        ? new Response('%PDF-1.4 synthetic')
        : new Response(JSON.stringify({ files: [{ id: 'file-1' }] }), { status: 200 });
    }));
    const blob = await driveDownloadDocument('token', name, 'folder-1');
    expect(await blob.text()).toBe('%PDF-1.4 synthetic');
    expect(decodeURIComponent(urls[0])).toContain(`name='2024-05-10 ${'a'.repeat(64)}.pdf'`);
  });
});

// @vitest-environment jsdom
/**
 * US-14 AC3: "View original file" opens only a vetted passive type in a tab.
 * A blob: URL opened top-level runs with the page's origin, so an archived
 * SVG or HTML would run script beside the cloud tokens in localStorage.
 * Anything else is re-typed as application/octet-stream and downloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentLightbox } from './DocumentLightbox';
import { deleteDocument, readDocumentFile } from '../lib/roadmap-data';
import type { ApiDocument } from '../lib/api-types';

vi.mock('../lib/roadmap-data', () => ({ readDocumentFile: vi.fn(), deleteDocument: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));

const doc = (fileRef: string): ApiDocument => ({
  id: 'd1', documentType: 'other', title: 'Scan', documentDate: '2024-06-01', contentMd: 'text',
  metadata: {}, sourceFileName: 'scan', createdAt: '2024-06-01T00:00:00Z', fileRef, contentHash: 'sha256-x',
});

let opened: Blob[];
let open: ReturnType<typeof vi.spyOn>;
let click: ReturnType<typeof vi.spyOn>;
let downloads: string[];

beforeEach(() => {
  opened = [];
  downloads = [];
  URL.createObjectURL = vi.fn((b: Blob) => { opened.push(b); return 'blob:x'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  open = vi.spyOn(window, 'open').mockImplementation(() => null);
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function viewOriginal(fileRef: string, blob: Blob) {
  vi.mocked(readDocumentFile).mockResolvedValue(blob);
  render(<DocumentLightbox doc={doc(fileRef)} onClose={() => {}} />);
  fireEvent.click(screen.getByText('View original file'));
  await waitFor(() => expect(opened).toHaveLength(1));
}

describe('US-14 AC3: View original never opens an active type', () => {
  it('downloads an archived SVG as octet-stream and never opens it', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan.svg', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }));
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
    expect(click).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual(['2024-06-01 Scan.svg']);
  });

  it('downloads when the bytes are typed active under a passive extension', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan.png', new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
  });

  it('downloads a .docx rather than opening it', async () => {
    await viewOriginal('Other documents/2024-06-01 Letter.docx', new Blob(['x']));
    expect(open).not.toHaveBeenCalled();
    expect(downloads).toEqual(['2024-06-01 Letter.docx']);
  });

  it('opens a PDF in a tab, typed as a PDF even when the backend returns untyped bytes', async () => {
    await viewOriginal('Lab reports/2024-06-01 Panel.pdf', new Blob(['%PDF-1.4']));
    expect(open).toHaveBeenCalledWith('blob:x', '_blank', 'noopener');
    expect(opened[0].type).toBe('application/pdf');
    expect(click).not.toHaveBeenCalled();
  });
});

// US-14 AC9 (A7): delete and "View original file" each run on one named state, and an answer
// that throws gives the button back instead of leaving it on "Deleting..." or "Opening…".
describe('US-14 AC9: delete and view original never stick', () => {
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it('delete asks once, then deletes and closes', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(true);
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(<DocumentLightbox doc={doc('')} onClose={onClose} onDeleted={onDeleted} />);
    fireEvent.click(button('Delete Document'));
    expect(deleteDocument).not.toHaveBeenCalled();
    fireEvent.click(button('Confirm Delete'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onDeleted).toHaveBeenCalledWith('d1');
  });

  it('a delete the record refuses goes back to the first press', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(false);
    const onClose = vi.fn();
    render(<DocumentLightbox doc={doc('')} onClose={onClose} />);
    fireEvent.click(button('Delete Document'));
    fireEvent.click(button('Confirm Delete'));
    await waitFor(() => expect(button('Delete Document').disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a delete that throws gives the button back', async () => {
    vi.mocked(deleteDocument).mockRejectedValue(new Error('store gone'));
    render(<DocumentLightbox doc={doc('')} onClose={() => {}} />);
    fireEvent.click(button('Delete Document'));
    fireEvent.click(button('Confirm Delete'));
    await waitFor(() => expect(button('Delete Document').disabled).toBe(false));
  });

  it('a missing original says so and gives the button back', async () => {
    vi.mocked(readDocumentFile).mockResolvedValue(null);
    render(<DocumentLightbox doc={doc('Lab reports/2024-06-01 Panel.pdf')} onClose={() => {}} />);
    fireEvent.click(button('View original file'));
    expect(await screen.findByText('Could not load the original file from your cloud storage.')).toBeTruthy();
    expect(button('View original file').disabled).toBe(false);
  });

  it('a read that throws says so and gives the button back', async () => {
    vi.mocked(readDocumentFile).mockRejectedValue(new Error('network'));
    render(<DocumentLightbox doc={doc('Lab reports/2024-06-01 Panel.pdf')} onClose={() => {}} />);
    fireEvent.click(button('View original file'));
    expect(await screen.findByText('Could not load the original file from your cloud storage.')).toBeTruthy();
    expect(button('View original file').disabled).toBe(false);
  });
});

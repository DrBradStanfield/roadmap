// @vitest-environment jsdom
/**
 * US-14 AC3: "View original file" opens only a vetted passive type in a tab.
 * A blob: URL opened top-level runs with the page's origin, so an archived
 * SVG or HTML would run script beside the cloud tokens in localStorage.
 * Anything else is re-typed as application/octet-stream and downloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentLightbox, deleteTransition, originalTransition, type DeleteStep, type OriginalView } from './DocumentLightbox';
import { deleteDocument, readDocumentFile } from '../lib/roadmap-data';
import type { ApiDocument } from '../lib/api-types';

vi.mock('../lib/roadmap-data', () => ({ readDocumentFile: vi.fn(), deleteDocument: vi.fn(), getShownErase: () => 'erase-shown' }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));

const doc = (fileRef: string, mimeType: string | null = null): ApiDocument => ({
  id: 'd1', documentType: 'other', title: 'Scan', documentDate: '2024-06-01', contentMd: 'text',
  metadata: {}, sourceFileName: 'scan', createdAt: '2024-06-01T00:00:00Z', fileRef, contentHash: 'sha256-x', mimeType,
});

let opened: Blob[];
let open: ReturnType<typeof vi.spyOn>;
let click: ReturnType<typeof vi.spyOn>;
let downloads: string[];

beforeEach(() => {
  // restoreAllMocks leaves a module mock's calls and answers in place; each test starts with none.
  vi.mocked(deleteDocument).mockReset();
  vi.mocked(readDocumentFile).mockReset();
  opened = [];
  downloads = [];
  URL.createObjectURL = vi.fn((b: Blob) => { opened.push(b); return 'blob:x'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  open = vi.spyOn(window, 'open').mockImplementation(() => null);
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function viewOriginal(fileRef: string, blob: Blob, mimeType: string | null = null) {
  vi.mocked(readDocumentFile).mockResolvedValue(blob);
  render(<DocumentLightbox doc={doc(fileRef, mimeType)} onClose={() => {}} />);
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

// US-14 AC14: the web and the iPhone decide by one rule (health-core originalPreview): the
// extension decides; with none, the row's stored type does, and only a passive kind opens.
describe('US-14 AC14: View original follows the shared rule', () => {
  it('opens an original with no extension by its stored passive type, typed by the table', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan', new Blob(['png']), 'IMAGE/PNG; charset=binary');
    expect(open).toHaveBeenCalledWith('blob:x', '_blank', 'noopener');
    expect(opened[0].type).toBe('image/png');
    expect(click).not.toHaveBeenCalled();
  });

  it('opens a name that looks active but has no extension only as the table type (PR 2204 review R4)', async () => {
    await viewOriginal('Other documents/evil.html ', new Blob(['png'], { type: 'application/octet-stream' }), 'image/png; name=evil.html');
    expect(open).toHaveBeenCalledWith('blob:x', '_blank', 'noopener');
    expect(opened[0].type).toBe('image/png');
  });

  it('downloads an original with no extension whose stored type can carry script', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan', new Blob(['<svg/>']), 'image/svg+xml');
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
    expect(downloads).toEqual(['2024-06-01 Scan']);
  });

  it('downloads an original with no extension and no stored type', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan', new Blob(['x'], { type: 'image/png' }));
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
  });

  it('downloads when the served bytes disagree with a passive stored type', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'image/png');
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
  });

  it('a passive stored type never rescues an unknown or active extension', async () => {
    await viewOriginal('Other documents/2024-06-01 Scan.svg', new Blob(['<svg/>']), 'image/png');
    expect(open).not.toHaveBeenCalled();
    expect(downloads).toEqual(['2024-06-01 Scan.svg']);
  });

  it('downloads when the stored type is not the extension\'s own', async () => {
    await viewOriginal('Lab reports/2024-06-01 Panel.pdf', new Blob(['%PDF-1.4']), 'image/png');
    expect(open).not.toHaveBeenCalled();
    expect(opened[0].type).toBe('application/octet-stream');
  });
});

// US-14 AC9 (A7): delete and "View original file" each run on one named state, and an answer
// that throws gives the button back instead of leaving it on "Deleting..." or "Opening…".
describe('US-14 AC9: delete and view original never stick', () => {
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it('the transition tables: each state x event names the state that follows', () => {
    const deleteRows: Array<[DeleteStep, 'press' | 'settled', DeleteStep]> = [
      ['idle', 'press', 'confirming'], ['confirming', 'press', 'deleting'], ['deleting', 'press', 'deleting'],
      ['idle', 'settled', 'idle'], ['confirming', 'settled', 'confirming'], ['deleting', 'settled', 'idle'],
    ];
    for (const [s, e, n] of deleteRows) expect([s, e, deleteTransition(s, e)]).toEqual([s, e, n]);
    const originalRows: Array<[OriginalView, 'open' | 'opened' | 'missing', OriginalView]> = [
      ['idle', 'open', 'opening'], ['opening', 'open', 'opening'], ['failed', 'open', 'opening'],
      ['idle', 'opened', 'idle'], ['opening', 'opened', 'idle'], ['failed', 'opened', 'failed'],
      ['idle', 'missing', 'idle'], ['opening', 'missing', 'failed'], ['failed', 'missing', 'failed'],
    ];
    for (const [s, e, n] of originalRows) expect([s, e, originalTransition(s, e)]).toEqual([s, e, n]);
  });

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
    expect(deleteDocument).toHaveBeenCalledWith('d1', 'erase-shown'); // the erase shown at the press (H20)
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

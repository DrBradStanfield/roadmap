// @vitest-environment jsdom
/**
 * US-12 AC4a: the upload window is a dialog. It is named by its title, it
 * takes the focus when it opens, and hiding it gives the focus back to what
 * opened it. Before this it was a plain box at the end of the page: the focus
 * stayed on the button behind the backdrop, and Settings' Escape check
 * (`[aria-modal="true"]`) could not see it. Synthetic: no file is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_ENGINE } from '../testing/upload-engine';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { SettingsSheet } from './SettingsSheet';
import { getDocumentArchiveMode, saveUpload } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { findReviewValue } from '../testing/import-review';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ recordFileSync: vi.fn(() => null), saveUpload: vi.fn(), uploadKnownIndex: vi.fn(() => new Map()), isLegacyUpload: vi.fn(() => false), getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/archive-payloads', async importOriginal => ({ ...await importOriginal<typeof import('../lib/archive-payloads')>(), sha256Blob: vi.fn(async () => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

/** The page: an opener button and the modal, shown and hidden as HealthTool does. */
function Page({ startOpen = false, mounted = true, withOpener = true }: { startOpen?: boolean; mounted?: boolean; withOpener?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return <>
    {withOpener && <button type="button" onClick={() => setOpen(true)}>Upload lab results</button>}
    <button type="button">Somewhere else</button>
    {mounted && <UploadModal open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onComplete={() => {}} unitSystem="si" />}
  </>;
}

function openFromButton() {
  const opener = screen.getByRole('button', { name: 'Upload lab results' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const title = () => screen.getByRole('heading', { name: 'Upload Health Records' });

beforeEach(() => { vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); delete (window as { HealthUpload?: unknown }).HealthUpload; });

describe('US-12 AC4a: the upload window is a dialog', () => {
  it('is a modal dialog named by its title', () => {
    render(<Page />);
    openFromButton();
    const dialog = screen.getByRole('dialog', { name: 'Upload Health Records' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.className).toBe('upload-modal');
    expect(dialog.contains(title())).toBe(true);
  });

  it('opening it moves the focus to its title, inside the dialog', () => {
    render(<Page />);
    openFromButton();
    expect(document.activeElement).toBe(title());
    expect(title().tabIndex).toBe(-1);
  });

  it('a window shown on its first render takes the focus too', () => {
    render(<Page startOpen />);
    expect(document.activeElement).toBe(title());
  });

  it('Close gives the focus back to the button that opened it', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape hides it, as before, and gives the focus back', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a click on the backdrop hides it and gives the focus back', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(document.querySelector('.upload-modal-backdrop')!);
    expect(document.activeElement).toBe(opener);
  });

  it('opening it a second time takes the focus again and gives it back again', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openFromButton();
    expect(document.activeElement).toBe(title());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('a hidden window claims no aria-modal, so Settings keeps its Escape', () => {
    render(<Page />);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    openFromButton();
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('with a session hidden, Escape in Settings still closes Settings; with the window open, it does not', () => {
    const onSettingsClose = vi.fn();
    render(<><Page /><SettingsSheet onClose={onSettingsClose}><p>Units</p></SettingsSheet></>);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });
    expect(onSettingsClose).toHaveBeenCalledOnce();
    openFromButton();
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });
    expect(onSettingsClose).toHaveBeenCalledOnce();
  });

  it('hiding it leaves the focus where something else has since put it outside the window', () => {
    render(<Page />);
    openFromButton();
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' });
    elsewhere.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a window reopened from the floating indicator gives the focus back to the indicator shown on hiding it', async () => {
    vi.mocked(checkLabImportQuota).mockReturnValue(new Promise(() => {}) as never); // the file is still being read
    render(<Page />);
    const opener = openFromButton();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    const indicator = document.querySelector<HTMLElement>('.floating-upload-indicator')!;
    indicator.focus();
    fireEvent.keyDown(indicator, { key: 'Enter' }); // the indicator leaves the page as the window shows
    expect(document.activeElement).toBe(title());
    fireEvent.keyDown(document, { key: 'Escape' });
    const shown = document.querySelector('.floating-upload-indicator');
    expect(shown).not.toBeNull();
    expect(document.activeElement).toBe(shown);
  });

  it('an opener that left the page while the window was open: hiding gives the focus to the floating indicator', async () => {
    vi.mocked(checkLabImportQuota).mockReturnValue(new Promise(() => {}) as never);
    const { rerender } = render(<Page />);
    openFromButton();
    act(() => { rerender(<Page withOpener={false} />); });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const shown = document.querySelector('.floating-upload-indicator');
    expect(shown).not.toBeNull();
    expect(document.activeElement).toBe(shown);
  });

  it('a window removed while open (an erase mounts a new one) gives the focus back', () => {
    const { rerender } = render(<Page />);
    const opener = openFromButton();
    act(() => { rerender(<Page mounted={false} />); });
    expect(document.activeElement).toBe(opener);
  });

  it('a window removed while the focus is outside it leaves the focus there', () => {
    const { rerender } = render(<Page />);
    openFromButton();
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' });
    elsewhere.focus();
    act(() => { rerender(<Page mounted={false} />); });
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('US-12 AC4a: a window reopened from the floating indicator that then ends its session', () => {
  const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };
  /** Opened from the button and a file picked, then hidden: a review once shown, a read while it runs (it then fails). Then reopened from the indicator. */
  async function reopened(shown: 'review' | 'failed read') {
    let fail: ((error: Error) => void) | undefined;
    vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 } as never); vi.mocked(labImport).mockResolvedValue(extraction as never);
    vi.mocked(saveUpload).mockResolvedValue({ ok: true, outcome: { values: 1, documents: 0, archived: 0, unstored: 0 }, added: [] });
    const extractFromPdf = shown === 'review' ? async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false }) : () => new Promise((_, no) => { fail = no; });
    Object.assign(window, { HealthUpload: { ...UPLOAD_ENGINE, extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } });
    render(<Page />);
    openFromButton();
    await act(async () => { fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    if (shown === 'review') await findReviewValue('3.9');
    else await waitFor(() => expect(fail).toBeTypeOf('function')); // main's flow hashes the file first; the read has started
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    if (fail) await act(async () => { fail!(new Error('synthetic unreadable file')); });
    const indicator = await screen.findByRole('button', { name: shown === 'review' ? /Ready for review/ : /Upload needs attention/ });
    indicator.focus(); fireEvent.keyDown(indicator, { key: 'Enter' });
    expect(document.activeElement).toBe(title());
    if (fail) screen.getByText('No readable files found. Please check your files and try again.'); // the failed-read screen
  }
  const toDone = async () => { await reopened('review'); fireEvent.click(screen.getByRole('button', { name: /^Save / })); await screen.findByRole('button', { name: 'Done' }); };
  it.each([
    ['Close on the failed-read screen', async () => { await reopened('failed read'); fireEvent.click(screen.getByRole('button', { name: 'Close' })); }],
    ['Escape on the failed-read screen', async () => { await reopened('failed read'); fireEvent.keyDown(document, { key: 'Escape' }); }],
    ['Done on the done screen', async () => { await toDone(); fireEvent.click(screen.getByRole('button', { name: 'Done' })); }],
    ['Escape on the done screen', async () => { await toDone(); fireEvent.keyDown(document, { key: 'Escape' }); }],
    ["the review's Cancel", async () => { await reopened('review'); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); }],
  ])('%s: the session ends, no indicator shows, the focus is not moved', async (_, end) => {
    await end();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.floating-upload-indicator')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.upload-modal h3')); // not moved: jsdom keeps it on the hidden title, a browser drops it to the body
  });
});
